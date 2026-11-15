use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{FsError, Result};
use crate::stat::sha256_hex;
use crate::util::{atomic_replace, key_hash, now_millis};

/// Une version anterieure d'un fichier, conservee juste avant un ecrasement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub saved_at_ms: i64,
    pub size: u64,
}

/// Historique local simple (CLAUDE.md 9.2) : les `max_versions` dernieres versions de chaque fichier,
/// stockees hors du dossier du projet (dans le dossier de donnees de l'application).
#[derive(Debug, Clone)]
pub struct HistoryStore {
    base: PathBuf,
    max_versions: usize,
}

pub(crate) fn check_component(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 64 || !value.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(FsError::invalid_argument("invalid identifier"));
    }
    Ok(())
}

impl HistoryStore {
    pub fn new(base: impl Into<PathBuf>, max_versions: usize) -> Self {
        Self { base: base.into(), max_versions: max_versions.max(1) }
    }

    fn directory(&self, root_id: &str, relative: &str) -> Result<PathBuf> {
        check_component(root_id)?;
        Ok(self.base.join("history").join(root_id).join(key_hash(relative)?))
    }

    /// Conserve `bytes`. Retourne `None` si le contenu est identique a la version la plus recente.
    pub fn snapshot(&self, root_id: &str, relative: &str, bytes: &[u8]) -> Result<Option<HistoryEntry>> {
        let directory = self.directory(root_id, relative)?;
        fs::create_dir_all(&directory)?;
        let digest = sha256_hex(bytes);
        let short = &digest[..8];
        let existing = Self::entries_in(&directory)?;
        if let Some(latest) = existing.first() {
            if latest.id.ends_with(&format!("-{short}.bak")) && latest.size == bytes.len() as u64 {
                return Ok(None);
            }
        }
        let saved_at_ms = now_millis();
        let id = format!("{saved_at_ms:016}-{short}.bak");
        atomic_replace(&directory.join(&id), bytes, None)?;
        let entry = HistoryEntry { id, saved_at_ms, size: bytes.len() as u64 };
        // Elagage : conserve les versions les plus recentes.
        let mut all = Self::entries_in(&directory)?;
        while all.len() > self.max_versions {
            if let Some(oldest) = all.pop() {
                let _ = fs::remove_file(directory.join(&oldest.id));
            }
        }
        Ok(Some(entry))
    }

    /// Versions conservees, de la plus recente a la plus ancienne.
    pub fn list(&self, root_id: &str, relative: &str) -> Result<Vec<HistoryEntry>> {
        let directory = self.directory(root_id, relative)?;
        if !directory.exists() {
            return Ok(Vec::new());
        }
        Self::entries_in(&directory)
    }

    pub fn read(&self, root_id: &str, relative: &str, id: &str) -> Result<Vec<u8>> {
        let valid = id.len() <= 48
            && id.ends_with(".bak")
            && id.chars().all(|c| c.is_ascii_digit() || matches!(c, 'a'..='f' | '-' | '.' | 'k'));
        if !valid {
            return Err(FsError::invalid_argument("invalid history id"));
        }
        Ok(fs::read(self.directory(root_id, relative)?.join(id))?)
    }

    fn entries_in(directory: &Path) -> Result<Vec<HistoryEntry>> {
        let mut entries = Vec::new();
        for item in fs::read_dir(directory)? {
            let item = item?;
            let name = item.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".bak") {
                continue;
            }
            let Some(timestamp) = name.split('-').next().and_then(|part| part.parse::<i64>().ok()) else {
                continue;
            };
            let size = item.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            entries.push(HistoryEntry { id: name, saved_at_ms: timestamp, size });
        }
        entries.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn snapshots_are_listed_newest_first_and_deduplicated() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new(dir.path(), 5);
        assert!(store.snapshot("root1", "npc/a.txt", b"one").unwrap().is_some());
        assert!(store.snapshot("root1", "npc/a.txt", b"one").unwrap().is_none());
        std::thread::sleep(std::time::Duration::from_millis(3));
        assert!(store.snapshot("root1", "npc/a.txt", b"two").unwrap().is_some());
        let entries = store.list("root1", "npc/a.txt").unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].saved_at_ms >= entries[1].saved_at_ms);
        assert_eq!(store.read("root1", "npc/a.txt", &entries[0].id).unwrap(), b"two");
        assert_eq!(store.read("root1", "npc/a.txt", &entries[1].id).unwrap(), b"one");
    }

    #[test]
    fn old_versions_are_pruned() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new(dir.path(), 3);
        for index in 0..6 {
            store.snapshot("root1", "a.txt", format!("v{index}").as_bytes()).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(3));
        }
        let entries = store.list("root1", "a.txt").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(store.read("root1", "a.txt", &entries[0].id).unwrap(), b"v5");
    }

    #[test]
    fn rejects_unsafe_identifiers() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new(dir.path(), 3);
        assert!(store.snapshot("../evil", "a.txt", b"x").is_err());
        assert!(store.snapshot("root1", "../a.txt", b"x").is_err());
        assert!(store.read("root1", "a.txt", "../../secret.bak").is_err());
        assert!(store.read("root1", "a.txt", "x.txt").is_err());
        assert!(store.list("root1", "never-saved.txt").unwrap().is_empty());
    }
}
