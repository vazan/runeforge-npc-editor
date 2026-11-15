use std::fs::OpenOptions;
use std::io::Write;

use serde::{Deserialize, Serialize};

use crate::error::{FsError, Result};
use crate::history::HistoryStore;
use crate::roots::RootRegistry;
use crate::stat::{modified_millis, sha256_hex, stat_with_bytes, FileStat};
use crate::util::atomic_replace;

/// Condition a verifier avant d'ecrire (CLAUDE.md 9.2 : ne jamais ecraser un fichier modifie ailleurs).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Precondition {
    /// Ecrase sans verification. A reserver a un choix explicite de l'utilisateur ; cree le fichier s'il n'existe plus.
    Overwrite,
    /// Cree un nouveau fichier ; echoue avec `already_exists` si l'entree existe.
    MustNotExist,
    /// Ecrase uniquement si le contenu actuel du disque a cette empreinte SHA-256 (celle du dernier etat lu).
    MustMatch { sha256: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub stat: FileStat,
    pub created: bool,
    /// Vrai si la version precedente a ete conservee dans l'historique.
    pub history_saved: bool,
}

/// Ecrit `data` dans une racine approuvee.
///
/// - Creation : le fichier est cree avec `create_new` (jamais d'ecrasement silencieux).
/// - Remplacement : ecriture dans un fichier temporaire voisin, `fsync`, puis `rename` atomique ; un echec laisse
///   l'original intact. Un fichier en lecture seule est refuse. La version precedente est conservee dans
///   `history` (un echec d'historique n'empeche pas l'enregistrement mais est signale).
pub fn write_file(
    registry: &RootRegistry,
    root_id: &str,
    relative: &str,
    data: &[u8],
    precondition: &Precondition,
    history: Option<&HistoryStore>,
) -> Result<WriteOutcome> {
    if let Precondition::MustNotExist = precondition {
        return create_file(registry, root_id, relative, data);
    }

    let path = match registry.resolve_existing(root_id, relative) {
        Ok(path) => path,
        Err(FsError::NotFound) if matches!(precondition, Precondition::Overwrite) => {
            return create_file(registry, root_id, relative, data);
        }
        Err(error) => return Err(error),
    };
    let metadata = std::fs::metadata(&path)?;
    if !metadata.is_file() {
        return Err(FsError::NotAFile);
    }
    if metadata.permissions().readonly() {
        return Err(FsError::PermissionDenied);
    }

    let current = std::fs::read(&path)?;
    if let Precondition::MustMatch { sha256 } = precondition {
        if &sha256_hex(&current) != sha256 {
            return Err(FsError::ExternalModification { current: stat_with_bytes(&metadata, &current) });
        }
    }

    let mut history_saved = false;
    if let Some(store) = history {
        history_saved = matches!(store.snapshot(root_id, relative, &current), Ok(Some(_)));
    }

    atomic_replace(&path, data, Some(&metadata))?;
    let new_metadata = std::fs::metadata(&path)?;
    Ok(WriteOutcome {
        stat: FileStat {
            size: data.len() as u64,
            modified_ms: modified_millis(&new_metadata),
            sha256: sha256_hex(data),
            readonly: new_metadata.permissions().readonly(),
        },
        created: false,
        history_saved,
    })
}

fn create_file(registry: &RootRegistry, root_id: &str, relative: &str, data: &[u8]) -> Result<WriteOutcome> {
    let path = registry.resolve_new(root_id, relative)?;
    let mut file = OpenOptions::new().write(true).create_new(true).open(&path)?;
    let written = file.write_all(data).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written {
        let _ = std::fs::remove_file(&path);
        return Err(error.into());
    }
    let metadata = std::fs::metadata(&path)?;
    Ok(WriteOutcome { stat: stat_with_bytes(&metadata, data), created: true, history_saved: false })
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

    fn leftovers(dir: &std::path::Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect()
    }

    #[test]
    fn creates_new_file_and_refuses_to_overwrite_with_must_not_exist() {
        let (dir, registry, id) = setup();
        let outcome = write_file(&registry, &id, "a.txt", b"hello", &Precondition::MustNotExist, None).unwrap();
        assert!(outcome.created);
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"hello");
        let second = write_file(&registry, &id, "a.txt", b"other", &Precondition::MustNotExist, None);
        assert_eq!(second.unwrap_err().code(), "already_exists");
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"hello");
    }

    #[test]
    fn replaces_when_the_expected_hash_matches_and_leaves_no_temp_file() {
        let (dir, registry, id) = setup();
        fs::write(dir.path().join("a.txt"), b"v1").unwrap();
        let precondition = Precondition::MustMatch { sha256: sha256_hex(b"v1") };
        let outcome = write_file(&registry, &id, "a.txt", b"v2\r\n", &precondition, None).unwrap();
        assert!(!outcome.created);
        assert_eq!(outcome.stat.sha256, sha256_hex(b"v2\r\n"));
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"v2\r\n");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn detects_external_modification_and_keeps_the_disk_content() {
        let (dir, registry, id) = setup();
        fs::write(dir.path().join("a.txt"), b"v1").unwrap();
        let read_state = sha256_hex(b"v1");
        // Un autre programme modifie le fichier entre la lecture et l'enregistrement.
        fs::write(dir.path().join("a.txt"), b"changed elsewhere").unwrap();
        let result = write_file(&registry, &id, "a.txt", b"my edit", &Precondition::MustMatch { sha256: read_state }, None);
        match result.unwrap_err() {
            FsError::ExternalModification { current } => {
                assert_eq!(current.sha256, sha256_hex(b"changed elsewhere"));
            }
            other => panic!("erreur inattendue : {other:?}"),
        }
        assert_eq!(fs::read(dir.path().join("a.txt")).unwrap(), b"changed elsewhere");
        assert!(leftovers(dir.path()).is_empty());
    }

    #[test]
    fn a_touched_file_with_identical_content_is_not_a_conflict() {
        let (dir, registry, id) = setup();
        fs::write(dir.path().join("a.txt"), b"same").unwrap();
        let state = sha256_hex(b"same");
        fs::write(dir.path().join("a.txt"), b"same").unwrap(); // date de modification differente, contenu identique
        let outcome = write_file(&registry, &id, "a.txt", b"new", &Precondition::MustMatch { sha256: state }, None);
        assert!(outcome.is_ok());
    }

    #[test]
    fn overwrite_creates_a_missing_file_and_replaces_without_checking() {
        let (dir, registry, id) = setup();
        assert!(write_file(&registry, &id, "n.txt", b"x", &Precondition::Overwrite, None).unwrap().created);
        fs::write(dir.path().join("n.txt"), b"changed").unwrap();
        let outcome = write_file(&registry, &id, "n.txt", b"forced", &Precondition::Overwrite, None).unwrap();
        assert!(!outcome.created);
        assert_eq!(fs::read(dir.path().join("n.txt")).unwrap(), b"forced");
    }

    #[test]
    fn must_match_on_a_deleted_file_reports_not_found() {
        let (_dir, registry, id) = setup();
        let result = write_file(&registry, &id, "gone.txt", b"x", &Precondition::MustMatch { sha256: "00".into() }, None);
        assert_eq!(result.unwrap_err().code(), "not_found");
    }

    #[test]
    fn read_only_files_are_refused_untouched() {
        let (dir, registry, id) = setup();
        let path = dir.path().join("ro.txt");
        fs::write(&path, b"locked").unwrap();
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions).unwrap();
        let result = write_file(&registry, &id, "ro.txt", b"x", &Precondition::Overwrite, None);
        assert_eq!(result.unwrap_err().code(), "permission_denied");
        assert_eq!(fs::read(&path).unwrap(), b"locked");
        // Nettoyage : le dossier temporaire doit pouvoir etre supprime.
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&path, permissions).unwrap();
    }

    #[test]
    fn previous_version_is_kept_in_history() {
        let (dir, registry, id) = setup();
        let store_dir = tempdir().unwrap();
        let history = HistoryStore::new(store_dir.path(), 5);
        fs::write(dir.path().join("a.txt"), b"before").unwrap();
        let outcome = write_file(&registry, &id, "a.txt", b"after", &Precondition::Overwrite, Some(&history)).unwrap();
        assert!(outcome.history_saved);
        let entries = history.list(&id, "a.txt").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(history.read(&id, "a.txt", &entries[0].id).unwrap(), b"before");
    }

    #[test]
    fn rejects_paths_outside_the_root_and_directories() {
        let (dir, registry, id) = setup();
        fs::create_dir(dir.path().join("sub")).unwrap();
        assert_eq!(write_file(&registry, &id, "../x.txt", b"x", &Precondition::Overwrite, None).unwrap_err().code(), "invalid_path");
        assert_eq!(write_file(&registry, &id, "sub", b"x", &Precondition::Overwrite, None).unwrap_err().code(), "not_a_file");
        assert_eq!(write_file(&registry, &id, "nodir/x.txt", b"x", &Precondition::MustNotExist, None).unwrap_err().code(), "not_found");
    }

    #[test]
    fn byte_content_is_written_verbatim() {
        let (dir, registry, id) = setup();
        let bytes: Vec<u8> = (0..=255u8).collect();
        write_file(&registry, &id, "bin.txt", &bytes, &Precondition::MustNotExist, None).unwrap();
        assert_eq!(fs::read(dir.path().join("bin.txt")).unwrap(), bytes);
    }
}
