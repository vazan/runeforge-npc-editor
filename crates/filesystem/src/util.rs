use std::fs::{self, Metadata, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::Result;
use crate::path_guard::normalize_key;
use crate::stat::sha256_hex;

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// Nom d'un fichier temporaire voisin de `target` (meme dossier, donc meme volume : `rename` atomique).
pub fn temp_sibling(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.subsec_nanos())
        .unwrap_or(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    target.with_file_name(format!(".{name}.rf-{}-{nanos}-{sequence}.tmp", std::process::id()))
}

/// Ecrit `data` dans un fichier temporaire voisin, le synchronise sur le disque, puis le renomme sur
/// `target` (remplacement). En cas d'echec le fichier temporaire est supprime et `target` reste intact.
pub fn atomic_replace(target: &Path, data: &[u8], permissions_from: Option<&Metadata>) -> Result<()> {
    let temp = temp_sibling(target);
    let outcome = write_then_rename(&temp, target, data, permissions_from);
    if outcome.is_err() {
        let _ = fs::remove_file(&temp);
    }
    outcome
}

fn write_then_rename(temp: &Path, target: &Path, data: &[u8], permissions_from: Option<&Metadata>) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(temp)?;
    file.write_all(data)?;
    file.sync_all()?;
    drop(file);
    if let Some(metadata) = permissions_from {
        // Conserve les droits d'origine ; un echec n'est pas bloquant (systemes de fichiers sans droits POSIX).
        let _ = fs::set_permissions(temp, metadata.permissions());
    }
    fs::rename(temp, target)?;
    Ok(())
}

/// Empreinte courte et stable (32 caracteres hexadecimaux) d'un chemin relatif normalise.
pub fn key_hash(relative: &str) -> Result<String> {
    let key = normalize_key(relative)?;
    Ok(sha256_hex(key.as_bytes())[..32].to_string())
}
