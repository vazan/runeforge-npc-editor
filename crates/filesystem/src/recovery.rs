use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{FsError, Result};
use crate::history::check_component;
use crate::path_guard::normalize_key;
use crate::util::{atomic_replace, key_hash, now_millis};

const MAGIC: &[u8] = b"RFREC1\n";
const EXTENSION: &str = "rfrec";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryMeta {
    pub version: u32,
    pub relative: String,
    pub saved_at_ms: i64,
    /// Empreinte du fichier sur disque au moment ou la modification a commence (pour detecter un conflit au retablissement).
    pub base_sha256: Option<String>,
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub relative: String,
    pub saved_at_ms: i64,
    pub size: u64,
    pub base_sha256: Option<String>,
}

/// Instantanes de documents modifies mais non enregistres (RF-016). Le contenu est stocke tel quel, hors du
/// dossier du projet. Un instantane est supprime des que le document est enregistre ou ferme volontairement.
#[derive(Debug, Clone)]
pub struct RecoveryStore {
    base: PathBuf,
}

impl RecoveryStore {
    pub fn new(base: impl Into<PathBuf>) -> Self {
        Self { base: base.into() }
    }

    fn directory(&self, root_id: &str) -> Result<PathBuf> {
        check_component(root_id)?;
        Ok(self.base.join("recovery").join(root_id))
    }

    fn file(&self, root_id: &str, relative: &str) -> Result<PathBuf> {
        Ok(self.directory(root_id)?.join(format!("{}.{EXTENSION}", key_hash(relative)?)))
    }

    pub fn save(
        &self,
        root_id: &str,
        relative: &str,
        data: &[u8],
        base_sha256: Option<String>,
        encoding: Option<String>,
    ) -> Result<()> {
        let path = self.file(root_id, relative)?;
        fs::create_dir_all(self.directory(root_id)?)?;
        let meta = RecoveryMeta {
            version: 1,
            relative: normalize_key(relative)?,
            saved_at_ms: now_millis(),
            base_sha256,
            encoding,
        };
        let header = serde_json::to_vec(&meta).map_err(|error| FsError::Corrupt { message: error.to_string() })?;
        let mut content = Vec::with_capacity(MAGIC.len() + header.len() + 1 + data.len());
        content.extend_from_slice(MAGIC);
        content.extend_from_slice(&header);
        content.push(b'\n');
        content.extend_from_slice(data);
        atomic_replace(&path, &content, None)
    }

    pub fn read(&self, root_id: &str, relative: &str) -> Result<(RecoveryMeta, Vec<u8>)> {
        let content = fs::read(self.file(root_id, relative)?)?;
        let (meta, offset) = parse_header(&content)?;
        if meta.relative != normalize_key(relative)? {
            return Err(FsError::Corrupt { message: "recovery entry does not match its key".into() });
        }
        Ok((meta, content[offset..].to_vec()))
    }

    pub fn clear(&self, root_id: &str, relative: &str) -> Result<()> {
        match fs::remove_file(self.file(root_id, relative)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    /// Instantanes disponibles pour une racine ; les fichiers illisibles sont ignores (jamais bloquants).
    pub fn list(&self, root_id: &str) -> Result<Vec<RecoveryEntry>> {
        let directory = self.directory(root_id)?;
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for item in fs::read_dir(&directory)? {
            let item = item?;
            if item.path().extension().and_then(|ext| ext.to_str()) != Some(EXTENSION) {
                continue;
            }
            let Ok(file) = fs::File::open(item.path()) else { continue };
            let total = file.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            let mut reader = BufReader::new(file);
            let mut magic = vec![0u8; MAGIC.len()];
            if reader.read_exact(&mut magic).is_err() || magic != MAGIC {
                continue;
            }
            let mut line = String::new();
            if reader.by_ref().take(16 * 1024).read_line(&mut line).is_err() {
                continue;
            }
            let Ok(meta) = serde_json::from_str::<RecoveryMeta>(line.trim_end()) else { continue };
            let header_len = (MAGIC.len() + line.len()) as u64;
            entries.push(RecoveryEntry {
                relative: meta.relative,
                saved_at_ms: meta.saved_at_ms,
                size: total.saturating_sub(header_len),
                base_sha256: meta.base_sha256,
            });
        }
        entries.sort_by(|a, b| a.relative.cmp(&b.relative));
        Ok(entries)
    }
}

fn parse_header(content: &[u8]) -> Result<(RecoveryMeta, usize)> {
    if !content.starts_with(MAGIC) {
        return Err(FsError::Corrupt { message: "bad recovery header".into() });
    }
    let rest = &content[MAGIC.len()..];
    let newline = rest
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| FsError::Corrupt { message: "missing header end".into() })?;
    let meta: RecoveryMeta = serde_json::from_slice(&rest[..newline])
        .map_err(|error| FsError::Corrupt { message: error.to_string() })?;
    Ok((meta, MAGIC.len() + newline + 1))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn save_list_read_clear_roundtrip_preserves_bytes() {
        let dir = tempdir().unwrap();
        let store = RecoveryStore::new(dir.path());
        let data = b"\xFF\xFEmes \"x\";\r\n\n\x00binary-safe\n";
        store.save("root1", "npc/a.txt", data, Some("abc".into()), Some("windows-1252".into())).unwrap();
        let listed = store.list("root1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].relative, "npc/a.txt");
        assert_eq!(listed[0].size, data.len() as u64);
        assert_eq!(listed[0].base_sha256.as_deref(), Some("abc"));
        let (meta, read) = store.read("root1", "npc\\a.txt").unwrap();
        assert_eq!(read, data);
        assert_eq!(meta.encoding.as_deref(), Some("windows-1252"));
        store.clear("root1", "npc/a.txt").unwrap();
        assert!(store.list("root1").unwrap().is_empty());
        // Idempotent.
        store.clear("root1", "npc/a.txt").unwrap();
    }

    #[test]
    fn corrupt_files_are_ignored_by_list_and_rejected_by_read() {
        let dir = tempdir().unwrap();
        let store = RecoveryStore::new(dir.path());
        store.save("root1", "a.txt", b"ok", None, None).unwrap();
        let folder = dir.path().join("recovery").join("root1");
        fs::write(folder.join("deadbeef.rfrec"), b"not a recovery file").unwrap();
        fs::write(folder.join("truncated.rfrec"), MAGIC).unwrap();
        let listed = store.list("root1").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].relative, "a.txt");
        let file = store.file("root1", "a.txt").unwrap();
        fs::write(&file, b"garbage").unwrap();
        assert_eq!(store.read("root1", "a.txt").unwrap_err().code(), "corrupt");
    }

    #[test]
    fn rejects_unsafe_keys() {
        let dir = tempdir().unwrap();
        let store = RecoveryStore::new(dir.path());
        assert!(store.save("../x", "a.txt", b"x", None, None).is_err());
        assert!(store.save("root1", "../a.txt", b"x", None, None).is_err());
        assert!(store.list("root1").unwrap().is_empty());
    }
}
