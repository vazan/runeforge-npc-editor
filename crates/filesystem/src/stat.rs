use std::fs::Metadata;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Etat d'un fichier tel que lu : sert de reference pour detecter une modification externe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub size: u64,
    /// Date de modification en millisecondes depuis l'epoque Unix (0 si indisponible).
    pub modified_ms: i64,
    /// Empreinte SHA-256 hexadecimale du contenu.
    pub sha256: String,
    pub readonly: bool,
}

pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

pub fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    to_hex(&digest[..])
}

pub fn modified_millis(metadata: &Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Etat d'un fichier dont le contenu `data` vient d'etre lu ou ecrit.
pub fn stat_with_bytes(metadata: &Metadata, data: &[u8]) -> FileStat {
    FileStat {
        size: data.len() as u64,
        modified_ms: modified_millis(metadata),
        sha256: sha256_hex(data),
        readonly: metadata.permissions().readonly(),
    }
}
