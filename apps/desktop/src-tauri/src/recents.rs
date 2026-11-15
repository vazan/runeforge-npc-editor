use runeforge_filesystem::{ApprovedRoot, ConfigStore, FsError, Result};
use serde::{Deserialize, Serialize};

const NAME: &str = "recent-projects";
const MAX_RECENT: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_ms: i64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Document {
    version: u32,
    projects: Vec<RecentProject>,
}

/// Les projets recents ne sont ecrits que par ce module (jamais par le frontend) : un chemin n'est reouvrable
/// sans boite de dialogue que s'il a deja ete choisi par l'utilisateur.
pub fn load(config: &ConfigStore) -> Vec<RecentProject> {
    let Ok(Some(text)) = config.read(NAME) else { return Vec::new() };
    serde_json::from_str::<Document>(&text).map(|document| document.projects).unwrap_or_default()
}

fn save(config: &ConfigStore, projects: Vec<RecentProject>) -> Result<()> {
    let document = Document { version: 1, projects };
    let json = serde_json::to_string(&document).map_err(|error| FsError::Corrupt { message: error.to_string() })?;
    config.write(NAME, &json)
}

pub fn touch(config: &ConfigStore, root: &ApprovedRoot, now_ms: i64) -> Result<()> {
    let mut projects = load(config);
    projects.retain(|project| project.path != root.display_path);
    let name = root
        .path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| root.display_path.clone());
    projects.insert(0, RecentProject { path: root.display_path.clone(), name, last_opened_ms: now_ms });
    projects.truncate(MAX_RECENT);
    save(config, projects)
}

pub fn forget(config: &ConfigStore, path: &str) -> Result<()> {
    let mut projects = load(config);
    projects.retain(|project| project.path != path);
    save(config, projects)
}

pub fn contains(config: &ConfigStore, path: &str) -> bool {
    load(config).iter().any(|project| project.path == path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use runeforge_filesystem::RootRegistry;
    use tempfile::tempdir;

    #[test]
    fn touch_orders_by_recency_deduplicates_and_forgets() {
        let config_dir = tempdir().unwrap();
        let config = ConfigStore::new(config_dir.path());
        let a = tempdir().unwrap();
        let b = tempdir().unwrap();
        let registry = RootRegistry::new();
        let root_a = registry.approve(a.path()).unwrap();
        let root_b = registry.approve(b.path()).unwrap();
        touch(&config, &root_a, 1).unwrap();
        touch(&config, &root_b, 2).unwrap();
        touch(&config, &root_a, 3).unwrap();
        let projects = load(&config);
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].path, root_a.display_path);
        assert_eq!(projects[0].last_opened_ms, 3);
        assert!(contains(&config, &root_b.display_path));
        forget(&config, &root_b.display_path).unwrap();
        assert!(!contains(&config, &root_b.display_path));
        assert!(!contains(&config, "C:\\never-approved"));
    }

    #[test]
    fn corrupt_document_yields_an_empty_list() {
        let config_dir = tempdir().unwrap();
        std::fs::write(config_dir.path().join("recent-projects.json"), "{ not json").unwrap();
        assert!(load(&ConfigStore::new(config_dir.path())).is_empty());
    }
}
