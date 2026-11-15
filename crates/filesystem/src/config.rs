use std::fs;
use std::path::PathBuf;

use crate::error::{FsError, Result};
use crate::util::atomic_replace;

const MAX_CONFIG_BYTES: usize = 1024 * 1024;

/// Stockage de petits documents JSON de configuration de l'application (preferences, projets recents).
/// Jamais de secret ici : mots de passe et cles vont dans le stockage securise de l'OS (CLAUDE.md 14.4).
#[derive(Debug, Clone)]
pub struct ConfigStore {
    directory: PathBuf,
}

fn check_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && name.len() <= 40
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if valid {
        Ok(())
    } else {
        Err(FsError::invalid_argument("invalid config name"))
    }
}

impl ConfigStore {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self { directory: directory.into() }
    }

    fn path(&self, name: &str) -> Result<PathBuf> {
        check_name(name)?;
        Ok(self.directory.join(format!("{name}.json")))
    }

    /// Contenu JSON du document, ou `None` s'il n'existe pas.
    pub fn read(&self, name: &str) -> Result<Option<String>> {
        match fs::read_to_string(self.path(name)?) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Enregistre atomiquement un document JSON valide (1 Mio maximum).
    pub fn write(&self, name: &str, json: &str) -> Result<()> {
        let path = self.path(name)?;
        if json.len() > MAX_CONFIG_BYTES {
            return Err(FsError::TooLarge { size: json.len() as u64, limit: MAX_CONFIG_BYTES as u64 });
        }
        serde_json::from_str::<serde_json::Value>(json).map_err(|_| FsError::invalid_argument("not valid JSON"))?;
        fs::create_dir_all(&self.directory)?;
        atomic_replace(&path, json.as_bytes(), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn roundtrip_and_missing_document() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path().join("config"));
        assert_eq!(store.read("settings").unwrap(), None);
        store.write("settings", r#"{"theme":"dark"}"#).unwrap();
        assert_eq!(store.read("settings").unwrap().as_deref(), Some(r#"{"theme":"dark"}"#));
        store.write("settings", r#"{"theme":"light"}"#).unwrap();
        assert_eq!(store.read("settings").unwrap().as_deref(), Some(r#"{"theme":"light"}"#));
    }

    #[test]
    fn rejects_bad_names_invalid_json_and_oversize_documents() {
        let dir = tempdir().unwrap();
        let store = ConfigStore::new(dir.path());
        for name in ["", "../x", "A", "a b", "a/b", &"x".repeat(41)] {
            assert!(store.write(name, "{}").is_err(), "devrait refuser {name:?}");
            assert!(store.read(name).is_err());
        }
        assert_eq!(store.write("ok", "{not json").unwrap_err().code(), "invalid_argument");
        assert_eq!(store.write("ok", &format!("\"{}\"", "a".repeat(2 * 1024 * 1024))).unwrap_err().code(), "too_large");
        assert_eq!(store.read("ok").unwrap(), None);
    }
}
