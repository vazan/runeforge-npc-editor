use crate::error::{FsError, Result};

const MAX_PATH_LEN: usize = 1024;
const MAX_SEGMENT_LEN: usize = 255;

/// Noms de peripheriques reserves par Windows (avec ou sans extension) : refuses partout pour la portabilite.
const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9", "lpt1",
    "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Valide un chemin **relatif** a une racine approuvee et le decoupe en segments.
///
/// Refuse : chemin vide ou trop long, chemin absolu (`/x`, `\x`, `C:\x`), navigation (`.` et `..`), segments vides,
/// caracteres de controle ou interdits (`< > : " | ? *`, ce qui exclut aussi les flux de donnees alternatifs
/// NTFS `fichier:flux`), noms se terminant par un espace ou un point, noms de peripheriques Windows.
/// Les separateurs `/` et `\` sont acceptes et equivalents.
pub fn validate_relative(relative: &str) -> Result<Vec<String>> {
    if relative.is_empty() {
        return Err(FsError::invalid_path("empty path"));
    }
    if relative.len() > MAX_PATH_LEN {
        return Err(FsError::invalid_path("path too long"));
    }
    if relative.starts_with('/') || relative.starts_with('\\') {
        return Err(FsError::invalid_path("absolute path"));
    }
    let mut segments = Vec::new();
    for segment in relative.split(['/', '\\']) {
        validate_segment(segment)?;
        segments.push(segment.to_string());
    }
    Ok(segments)
}

fn validate_segment(segment: &str) -> Result<()> {
    if segment.is_empty() {
        return Err(FsError::invalid_path("empty path segment"));
    }
    if segment == "." || segment == ".." {
        return Err(FsError::invalid_path("relative navigation is not allowed"));
    }
    if segment.len() > MAX_SEGMENT_LEN {
        return Err(FsError::invalid_path("path segment too long"));
    }
    if segment
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
    {
        return Err(FsError::invalid_path("forbidden character"));
    }
    if segment.ends_with(' ') || segment.ends_with('.') {
        return Err(FsError::invalid_path("trailing space or dot"));
    }
    let stem = segment.split('.').next().unwrap_or("").to_ascii_lowercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(FsError::invalid_path("reserved device name"));
    }
    Ok(())
}

/// Forme canonique d'un chemin relatif (separateur `/`) servant de cle stable.
pub fn normalize_key(relative: &str) -> Result<String> {
    Ok(validate_relative(relative)?.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_regular_relative_paths() {
        assert_eq!(validate_relative("npc/cities/prontera.txt").unwrap(), vec!["npc", "cities", "prontera.txt"]);
        assert_eq!(validate_relative("npc\\cities\\a.txt").unwrap(), vec!["npc", "cities", "a.txt"]);
        assert_eq!(validate_relative(".runeforge/project.json").unwrap().len(), 2);
        assert_eq!(validate_relative("quests_16_1.txt").unwrap(), vec!["quests_16_1.txt"]);
        assert_eq!(validate_relative("dir with space/é.txt").unwrap().len(), 2);
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        for bad in ["../x", "a/../../x", "a/./b", "/etc/passwd", "\\\\server\\share", "C:\\x", "C:x", "a/..", "."] {
            assert!(validate_relative(bad).is_err(), "devrait refuser {bad:?}");
        }
    }

    #[test]
    fn rejects_empty_segments_and_control_characters() {
        for bad in ["", "a//b", "a/", "a\u{0}b", "a\nb", "tab\tname"] {
            assert!(validate_relative(bad).is_err(), "devrait refuser {bad:?}");
        }
    }

    #[test]
    fn rejects_windows_hazards() {
        for bad in ["con", "CON.txt", "dir/nul", "aux.tar.gz", "com1", "LPT9.log", "a.", "a ", "file:stream", "a<b", "a|b", "a?b", "a*b", "q\"x"] {
            assert!(validate_relative(bad).is_err(), "devrait refuser {bad:?}");
        }
        // Proches mais valides.
        for good in ["console.txt", "com10.txt", "nullable", "lpt0", "auxiliary/x"] {
            assert!(validate_relative(good).is_ok(), "devrait accepter {good:?}");
        }
    }

    #[test]
    fn rejects_overlong_values() {
        assert!(validate_relative(&"a".repeat(300)).is_err());
        assert!(validate_relative(&format!("{}/x", "a/".repeat(600))).is_err());
    }

    #[test]
    fn normalize_key_is_separator_independent() {
        assert_eq!(normalize_key("a\\b/c.txt").unwrap(), "a/b/c.txt");
    }
}
