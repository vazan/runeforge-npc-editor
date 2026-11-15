use crate::error::{FsError, Result};
use crate::roots::RootRegistry;
use crate::stat::{stat_with_bytes, FileStat};

/// Taille maximale lue par defaut (CLAUDE.md 16.1 : fichiers enormes = menace).
pub const DEFAULT_MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct FileRead {
    pub bytes: Vec<u8>,
    pub stat: FileStat,
}

/// Lit un fichier d'une racine approuvee. Le contenu est renvoye tel quel (octets) : aucun decodage,
/// aucune conversion d'encodage ou de fin de ligne n'est faite ici.
pub fn read_file(registry: &RootRegistry, root_id: &str, relative: &str, max_bytes: u64) -> Result<FileRead> {
    let path = registry.resolve_existing(root_id, relative)?;
    let metadata = std::fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(FsError::NotAFile);
    }
    if metadata.len() > max_bytes {
        return Err(FsError::TooLarge { size: metadata.len(), limit: max_bytes });
    }
    let bytes = std::fs::read(&path)?;
    if bytes.len() as u64 > max_bytes {
        return Err(FsError::TooLarge { size: bytes.len() as u64, limit: max_bytes });
    }
    let stat = stat_with_bytes(&metadata, &bytes);
    Ok(FileRead { bytes, stat })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn setup() -> (tempfile::TempDir, RootRegistry, String) {
        let dir = tempdir().unwrap();
        let registry = RootRegistry::new();
        let id = registry.approve(dir.path()).unwrap().id;
        (dir, registry, id)
    }

    #[test]
    fn reads_bytes_exactly_with_stat() {
        let (dir, registry, id) = setup();
        let content = b"\xEF\xBB\xBFmes \"caf\xE9\";\r\n";
        fs::write(dir.path().join("a.txt"), content).unwrap();
        let read = read_file(&registry, &id, "a.txt", DEFAULT_MAX_FILE_BYTES).unwrap();
        assert_eq!(read.bytes, content);
        assert_eq!(read.stat.size, content.len() as u64);
        assert_eq!(read.stat.sha256, crate::stat::sha256_hex(content));
        assert!(!read.stat.readonly);
    }

    #[test]
    fn refuses_directories_and_oversized_files() {
        let (dir, registry, id) = setup();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join("big.txt"), vec![b'a'; 100]).unwrap();
        assert_eq!(read_file(&registry, &id, "sub", 10).unwrap_err().code(), "not_a_file");
        match read_file(&registry, &id, "big.txt", 10).unwrap_err() {
            FsError::TooLarge { size, limit } => {
                assert_eq!((size, limit), (100, 10));
            }
            other => panic!("erreur inattendue : {other:?}"),
        }
    }

    #[test]
    fn missing_file_is_not_found() {
        let (_dir, registry, id) = setup();
        assert_eq!(read_file(&registry, &id, "nope.txt", 10).unwrap_err().code(), "not_found");
    }
}
