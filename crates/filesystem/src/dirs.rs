use std::fs;

use crate::error::{FsError, Result};
use crate::path_guard::validate_relative;
use crate::roots::RootRegistry;

/// Cree un dossier (et ses parents manquants) dans une racine approuvee. Retourne `true` s'il a ete cree,
/// `false` s'il existait deja. Chaque segment existant est verifie : un lien symbolique doit rester dans la
/// racine, et un fichier ordinaire a la place d'un dossier est refuse.
pub fn create_directory(registry: &RootRegistry, root_id: &str, relative: &str) -> Result<bool> {
    let root = registry.get(root_id)?;
    let segments = validate_relative(relative)?;
    let mut current = root.path.clone();
    let mut created = false;
    for segment in &segments {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let canonical = dunce::canonicalize(&current)?;
                if !canonical.starts_with(&root.path) {
                    return Err(FsError::OutsideRoot);
                }
                if !fs::metadata(&canonical)?.is_dir() {
                    return Err(FsError::NotADirectory);
                }
            }
            Ok(metadata) if metadata.is_dir() => {}
            Ok(_) => return Err(FsError::NotADirectory),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                created = true;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn creates_nested_directories_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let registry = RootRegistry::new();
        let id = registry.approve(dir.path()).unwrap().id;
        assert!(create_directory(&registry, &id, ".runeforge/cache").unwrap());
        assert!(dir.path().join(".runeforge/cache").is_dir());
        assert!(!create_directory(&registry, &id, ".runeforge/cache").unwrap());
        assert!(create_directory(&registry, &id, ".runeforge/other").unwrap());
    }

    #[test]
    fn refuses_files_in_the_way_and_unsafe_paths() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("file.txt"), "x").unwrap();
        let registry = RootRegistry::new();
        let id = registry.approve(dir.path()).unwrap().id;
        assert_eq!(create_directory(&registry, &id, "file.txt/sub").unwrap_err().code(), "not_a_directory");
        assert_eq!(create_directory(&registry, &id, "../outside").unwrap_err().code(), "invalid_path");
        assert_eq!(create_directory(&registry, "unknown", "a").unwrap_err().code(), "unknown_root");
        assert_eq!(create_directory(&registry, &id, "CON").unwrap_err().code(), "invalid_path");
    }

    #[test]
    fn a_symlink_leaving_the_root_is_refused() {
        let outside = tempdir().unwrap();
        let project = tempdir().unwrap();
        if !crate::roots::tests::try_symlink_dir(outside.path(), &project.path().join("link")) {
            eprintln!("symlink non disponible, test ignore");
            return;
        }
        let registry = RootRegistry::new();
        let id = registry.approve(project.path()).unwrap().id;
        assert_eq!(create_directory(&registry, &id, "link/new").unwrap_err().code(), "outside_root");
        assert!(!outside.path().join("new").exists());
    }
}
