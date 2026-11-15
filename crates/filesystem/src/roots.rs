use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{PoisonError, RwLock};

use serde::Serialize;

use crate::error::{FsError, Result};
use crate::path_guard::validate_relative;
use crate::stat::sha256_hex;

/// Dossier de projet explicitement choisi par l'utilisateur. Toute operation sur des fichiers passe par
/// une racine approuvee : le frontend ne fournit jamais de chemin absolu (CLAUDE.md 14.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedRoot {
    /// Identifiant stable derive du chemin canonique ; sert de cle pour recuperation et historique.
    pub id: String,
    #[serde(skip)]
    pub path: PathBuf,
    /// Chemin affichable (informatif, jamais reutilise comme argument d'operation).
    pub display_path: String,
}

#[derive(Debug, Default)]
pub struct RootRegistry {
    roots: RwLock<HashMap<String, ApprovedRoot>>,
}

impl RootRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Approuve un dossier : chemin canonique (liens resolus), doit etre un dossier existant.
    pub fn approve(&self, path: &Path) -> Result<ApprovedRoot> {
        let canonical = dunce::canonicalize(path)?;
        if !std::fs::metadata(&canonical)?.is_dir() {
            return Err(FsError::NotADirectory);
        }
        let text = canonical.to_string_lossy().into_owned();
        let identity = if cfg!(windows) { text.to_lowercase() } else { text.clone() };
        let id = sha256_hex(identity.as_bytes())[..16].to_string();
        let root = ApprovedRoot { id: id.clone(), path: canonical, display_path: text };
        self.roots
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, root.clone());
        Ok(root)
    }

    pub fn get(&self, id: &str) -> Result<ApprovedRoot> {
        self.roots
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(id)
            .cloned()
            .ok_or(FsError::UnknownRoot)
    }

    pub fn forget(&self, id: &str) {
        self.roots.write().unwrap_or_else(PoisonError::into_inner).remove(id);
    }

    /// Resout un chemin relatif **existant** : valide les segments, suit les liens, puis verifie que le
    /// resultat canonique reste dans la racine (un lien vers l'exterieur est refuse).
    pub fn resolve_existing(&self, id: &str, relative: &str) -> Result<PathBuf> {
        let root = self.get(id)?;
        let segments = validate_relative(relative)?;
        let mut joined = root.path.clone();
        joined.extend(&segments);
        let canonical = dunce::canonicalize(&joined)?;
        if !canonical.starts_with(&root.path) {
            return Err(FsError::OutsideRoot);
        }
        Ok(canonical)
    }

    /// Resout le chemin d'un fichier **a creer** : le dossier parent doit exister et rester dans la racine.
    /// Retourne `AlreadyExists` si l'entree existe deja (y compris comme lien).
    pub fn resolve_new(&self, id: &str, relative: &str) -> Result<PathBuf> {
        let root = self.get(id)?;
        let segments = validate_relative(relative)?;
        let Some((name, parents)) = segments.split_last() else {
            return Err(FsError::invalid_path("empty path"));
        };
        let mut parent = root.path.clone();
        parent.extend(parents);
        let canonical_parent = dunce::canonicalize(&parent)?;
        if !canonical_parent.starts_with(&root.path) {
            return Err(FsError::OutsideRoot);
        }
        if !std::fs::metadata(&canonical_parent)?.is_dir() {
            return Err(FsError::NotADirectory);
        }
        let target = canonical_parent.join(name);
        if std::fs::symlink_metadata(&target).is_ok() {
            return Err(FsError::AlreadyExists);
        }
        Ok(target)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn approve_requires_an_existing_directory() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "x").unwrap();
        let registry = RootRegistry::new();
        assert_eq!(registry.approve(&file).unwrap_err().code(), "not_a_directory");
        assert_eq!(registry.approve(&dir.path().join("missing")).unwrap_err().code(), "not_found");
        assert!(registry.approve(dir.path()).is_ok());
    }

    #[test]
    fn id_is_stable_and_unknown_root_is_rejected() {
        let dir = tempdir().unwrap();
        let registry = RootRegistry::new();
        let first = registry.approve(dir.path()).unwrap();
        let second = registry.approve(dir.path()).unwrap();
        assert_eq!(first.id, second.id);
        assert_eq!(registry.resolve_existing("nope", "a.txt").unwrap_err().code(), "unknown_root");
        registry.forget(&first.id);
        assert_eq!(registry.get(&first.id).unwrap_err().code(), "unknown_root");
    }

    #[test]
    fn resolve_existing_checks_path_and_existence() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("npc")).unwrap();
        fs::write(dir.path().join("npc/a.txt"), "x").unwrap();
        let registry = RootRegistry::new();
        let root = registry.approve(dir.path()).unwrap();
        let resolved = registry.resolve_existing(&root.id, "npc/a.txt").unwrap();
        assert!(resolved.ends_with("a.txt"));
        assert_eq!(registry.resolve_existing(&root.id, "npc/missing.txt").unwrap_err().code(), "not_found");
        assert_eq!(registry.resolve_existing(&root.id, "../a.txt").unwrap_err().code(), "invalid_path");
    }

    #[test]
    fn resolve_new_requires_existing_parent_and_new_name() {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join("npc")).unwrap();
        fs::write(dir.path().join("npc/a.txt"), "x").unwrap();
        let registry = RootRegistry::new();
        let root = registry.approve(dir.path()).unwrap();
        assert!(registry.resolve_new(&root.id, "npc/b.txt").is_ok());
        assert_eq!(registry.resolve_new(&root.id, "npc/a.txt").unwrap_err().code(), "already_exists");
        assert_eq!(registry.resolve_new(&root.id, "missingdir/b.txt").unwrap_err().code(), "not_found");
    }

    #[test]
    fn symlink_escaping_the_root_is_rejected() {
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        let project = tempdir().unwrap();
        let link = project.path().join("link");
        if !try_symlink_dir(outside.path(), &link) {
            // Creation de liens impossible sans privilege sous Windows : test non applicable ici.
            eprintln!("symlink non disponible, test ignore");
            return;
        }
        let registry = RootRegistry::new();
        let root = registry.approve(project.path()).unwrap();
        assert_eq!(registry.resolve_existing(&root.id, "link/secret.txt").unwrap_err().code(), "outside_root");
        assert_eq!(registry.resolve_new(&root.id, "link/new.txt").unwrap_err().code(), "outside_root");
    }

    pub(crate) fn try_symlink_dir(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }
}
