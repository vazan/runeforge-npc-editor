//! Les plateformes que les mises a jour savent installer, et le format d'executable que chacune attend.
//!
//! La cle de plateforme du manifeste est `<systeme>-<architecture>` (`windows-x86_64`, `linux-x86_64`, `linux-aarch64`). Le systeme dit
//! comment l'application se remplace elle-meme (voir `install`) et comment reconnaitre un executable : un fichier `MZ` n'est pas
//! l'executable d'un Linux, et un fichier ELF n'est pas celui d'un Windows, quelle que soit sa signature.

/// Systemes (`std::env::consts::OS`) dont l'application sait se remplacer elle-meme.
pub fn supports_install(os: &str) -> bool {
    matches!(os, "windows" | "linux")
}

/// Le format d'un executable, d'apres son en-tete.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutableKind {
    /// Windows : le fichier commence par `MZ`.
    Pe,
    /// Linux : le fichier commence par `\x7fELF`.
    Elf,
}

impl ExecutableKind {
    /// Le format attendu pour une cle de plateforme du manifeste ; `None` : systeme que les mises a jour ne prennent pas en charge.
    pub fn for_platform(platform: &str) -> Option<Self> {
        match platform.split('-').next()? {
            "windows" => Some(ExecutableKind::Pe),
            "linux" => Some(ExecutableKind::Elf),
            _ => None,
        }
    }

    /// Vrai si `head` (le debut du fichier) est celui de ce format.
    pub fn matches(self, head: &[u8]) -> bool {
        match self {
            ExecutableKind::Pe => head.starts_with(b"MZ"),
            ExecutableKind::Elf => head.starts_with(b"\x7fELF"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_and_linux_can_install_and_nothing_else_can() {
        assert!(supports_install("windows") && supports_install("linux"));
        for other in ["macos", "freebsd", "android", "", "Windows", "linux-x86_64"] {
            assert!(!supports_install(other), "{other:?}");
        }
    }

    #[test]
    fn the_expected_format_follows_the_system_of_the_platform_key() {
        assert_eq!(ExecutableKind::for_platform("windows-x86_64"), Some(ExecutableKind::Pe));
        assert_eq!(ExecutableKind::for_platform("linux-x86_64"), Some(ExecutableKind::Elf));
        assert_eq!(ExecutableKind::for_platform("linux-aarch64"), Some(ExecutableKind::Elf));
        for unknown in ["macos-aarch64", "freebsd-x86_64", "x86_64", "-x86_64", ""] {
            assert_eq!(ExecutableKind::for_platform(unknown), None, "{unknown:?}");
        }
    }

    #[test]
    fn a_header_is_recognised_for_its_own_system_only() {
        let windows = b"MZ\x90\x00";
        let linux = b"\x7fELF\x02\x01";
        assert!(ExecutableKind::Pe.matches(windows) && !ExecutableKind::Pe.matches(linux));
        assert!(ExecutableKind::Elf.matches(linux) && !ExecutableKind::Elf.matches(windows));
        for short_or_wrong in [&b""[..], b"M", b"\x7fEL", b"ELF\x7f", b"#!/bin/sh\n", b"PK\x03\x04"] {
            assert!(!ExecutableKind::Pe.matches(short_or_wrong) && !ExecutableKind::Elf.matches(short_or_wrong), "{short_or_wrong:?}");
        }
    }
}
