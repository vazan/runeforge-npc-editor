//! Manifeste de release : ce que l'editeur signe. L'application ne decide jamais d'installer d'apres autre chose.
//!
//! Format (JSON UTF-8) ; la signature est celle des octets exacts du fichier :
//!
//! ```json
//! {
//!   "schema": 1,
//!   "product": "runeforge-studio",
//!   "version": "0.2.0",
//!   "channel": "stable",
//!   "publishedAt": "2026-11-15T10:00:00Z",
//!   "notes": "Texte brut.",
//!   "minimumVersion": "0.1.0",
//!   "platforms": { "windows-x86_64": { "file": "runeforge-studio-0.2.0-windows-x86_64.exe", "size": 123, "sha256": "..." } }
//! }
//! ```

use std::collections::BTreeMap;

use semver::Version;
use serde::Deserialize;

use crate::error::UpdateError;
use crate::version::{parse_version, Channel};

pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
/// Taille maximale d'un executable de mise a jour (le produit actuel en pese une vingtaine de Mio).
pub const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
pub const PRODUCT: &str = "runeforge-studio";
pub const SCHEMA: u32 = 1;
const MAX_NOTES_BYTES: usize = 8 * 1024;
const MAX_PLATFORMS: usize = 16;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    schema: u32,
    product: String,
    version: String,
    channel: String,
    published_at: String,
    notes: String,
    minimum_version: Option<String>,
    platforms: BTreeMap<String, RawPlatform>,
}

#[derive(Deserialize)]
struct RawPlatform {
    file: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformEntry {
    pub file: String,
    pub size: u64,
    /// Empreinte SHA-256 en hexadecimal minuscule.
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub version: Version,
    pub channel: Channel,
    pub published_at: String,
    pub notes: String,
    pub minimum_version: Option<Version>,
    pub platforms: BTreeMap<String, PlatformEntry>,
}

fn is_platform_key(key: &str) -> bool {
    let mut parts = key.split('-');
    let (Some(os), Some(arch), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    [os, arch].iter().all(|part| !part.is_empty() && part.len() <= 16 && part.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'))
}

/// Un nom de fichier de release : lettres, chiffres, `.`, `_` et `-`, sans `..`, sans separateur (il n'est jamais un chemin).
pub fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains("..")
        && name.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_timestamp(text: &str) -> bool {
    !text.is_empty() && text.len() <= 40 && text.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'T' | b'Z' | b':' | b'-' | b'+' | b'.'))
}

/// Lit et valide un manifeste **deja authentifie** (voir `verify::verify_manifest`) : jamais appele sur des octets non signes.
pub fn parse(bytes: &[u8]) -> Result<Manifest, UpdateError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::bad_manifest("size"));
    }
    let raw: RawManifest = serde_json::from_slice(bytes).map_err(|_| UpdateError::bad_manifest("json"))?;
    if raw.schema > SCHEMA {
        return Err(UpdateError::UnsupportedSchema);
    }
    if raw.schema != SCHEMA {
        return Err(UpdateError::bad_manifest("schema"));
    }
    if raw.product != PRODUCT {
        return Err(UpdateError::bad_manifest("product"));
    }
    let version = parse_version(&raw.version)?;
    let channel = Channel::parse(&raw.channel).map_err(|_| UpdateError::bad_manifest("channel"))?;
    if channel == Channel::Stable && !version.pre.is_empty() {
        return Err(UpdateError::bad_manifest("channel"));
    }
    if !is_timestamp(&raw.published_at) {
        return Err(UpdateError::bad_manifest("publishedAt"));
    }
    if raw.notes.len() > MAX_NOTES_BYTES || raw.notes.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err(UpdateError::bad_manifest("notes"));
    }
    let minimum_version = raw.minimum_version.as_deref().map(parse_version).transpose()?;
    if raw.platforms.is_empty() || raw.platforms.len() > MAX_PLATFORMS {
        return Err(UpdateError::bad_manifest("platforms"));
    }
    let mut platforms = BTreeMap::new();
    for (key, platform) in raw.platforms {
        if !is_platform_key(&key) || !is_safe_file_name(&platform.file) || !is_sha256_hex(&platform.sha256) || platform.size == 0 || platform.size > MAX_ARTIFACT_BYTES {
            return Err(UpdateError::bad_manifest("platform"));
        }
        platforms.insert(key, PlatformEntry { file: platform.file, size: platform.size, sha256: platform.sha256 });
    }
    Ok(Manifest { version, channel, published_at: raw.published_at, notes: raw.notes, minimum_version, platforms })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn valid() -> Value {
        json!({
            "schema": 1,
            "product": "runeforge-studio",
            "version": "0.2.0",
            "channel": "stable",
            "publishedAt": "2026-11-15T10:00:00Z",
            "notes": "Premiere ligne.\nSeconde ligne.",
            "minimumVersion": "0.1.0",
            "platforms": { "windows-x86_64": { "file": "runeforge-studio-0.2.0-windows-x86_64.exe", "size": 1234, "sha256": SHA } }
        })
    }

    fn parse_json(value: &Value) -> Result<Manifest, UpdateError> {
        parse(value.to_string().as_bytes())
    }

    fn with(mutation: impl FnOnce(&mut Value)) -> Result<Manifest, UpdateError> {
        let mut value = valid();
        mutation(&mut value);
        parse_json(&value)
    }

    #[test]
    fn reads_a_valid_manifest() {
        let manifest = parse_json(&valid()).unwrap();
        assert_eq!(manifest.version, Version::new(0, 2, 0));
        assert_eq!(manifest.channel, Channel::Stable);
        assert_eq!(manifest.minimum_version, Some(Version::new(0, 1, 0)));
        let entry = &manifest.platforms["windows-x86_64"];
        assert_eq!((entry.file.as_str(), entry.size, entry.sha256.as_str()), ("runeforge-studio-0.2.0-windows-x86_64.exe", 1234, SHA));
        assert!(manifest.notes.contains('\n'));
    }

    #[test]
    fn a_future_schema_is_reported_as_such_and_other_schemas_are_refused() {
        assert_eq!(with(|v| v["schema"] = json!(2)), Err(UpdateError::UnsupportedSchema));
        assert!(matches!(with(|v| v["schema"] = json!(0)), Err(UpdateError::BadManifest { .. })));
    }

    #[test]
    fn refuses_a_manifest_of_another_product_or_with_a_bad_version_or_channel() {
        assert!(with(|v| v["product"] = json!("other")).is_err());
        assert!(with(|v| v["version"] = json!("v0.2.0")).is_err());
        assert!(with(|v| v["version"] = json!("0.2")).is_err());
        assert!(with(|v| v["channel"] = json!("nightly")).is_err());
        // Un canal stable ne peut pas porter une pre-version.
        assert!(with(|v| v["version"] = json!("0.3.0-beta.1")).is_err());
        assert!(with(|v| {
            v["version"] = json!("0.3.0-beta.1");
            v["channel"] = json!("beta");
        })
        .is_ok());
        assert!(with(|v| v["minimumVersion"] = json!("soon")).is_err());
    }

    #[test]
    fn minimum_version_is_optional() {
        let manifest = with(|v| {
            v.as_object_mut().unwrap().remove("minimumVersion");
        })
        .unwrap();
        assert_eq!(manifest.minimum_version, None);
    }

    #[test]
    fn refuses_unsafe_or_malformed_platform_entries() {
        let entry = |file: &str, size: u64, sha: &str| json!({ "windows-x86_64": { "file": file, "size": size, "sha256": sha } });
        for (file, size, sha) in [
            ("../evil.exe", 10, SHA),
            ("dir/evil.exe", 10, SHA),
            ("dir\\evil.exe", 10, SHA),
            (".hidden.exe", 10, SHA),
            ("", 10, SHA),
            ("ok.exe", 0, SHA),
            ("ok.exe", MAX_ARTIFACT_BYTES + 1, SHA),
            ("ok.exe", 10, "ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789"),
            ("ok.exe", 10, "abc"),
        ] {
            assert!(with(|v| v["platforms"] = entry(file, size, sha)).is_err(), "{file} {size} {sha}");
        }
        assert!(with(|v| v["platforms"] = json!({})).is_err());
        assert!(with(|v| v["platforms"] = json!({ "windows": { "file": "ok.exe", "size": 1, "sha256": SHA } })).is_err());
        assert!(with(|v| v["platforms"] = json!({ "Windows-x86_64": { "file": "ok.exe", "size": 1, "sha256": SHA } })).is_err());
    }

    #[test]
    fn refuses_odd_notes_and_dates_and_oversized_or_non_json_input() {
        assert!(with(|v| v["notes"] = json!("bell\u{7}")).is_err());
        assert!(with(|v| v["notes"] = json!("x".repeat(MAX_NOTES_BYTES + 1))).is_err());
        assert!(with(|v| v["publishedAt"] = json!("yesterday")).is_err());
        assert!(parse(b"not json").is_err());
        assert!(parse(&vec![b' '; MAX_MANIFEST_BYTES + 1]).is_err());
        assert!(parse(b"{}").is_err());
    }

    #[test]
    fn file_names_are_never_paths() {
        assert!(is_safe_file_name("runeforge-studio-0.2.0-windows-x86_64.exe"));
        for bad in ["", "..", "a/b", "a\\b", "a:b", "a b", "-lead", "a..b", &"x".repeat(129)] {
            assert!(!is_safe_file_name(bad), "{bad}");
        }
    }
}
