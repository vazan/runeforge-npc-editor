use std::fs;
use std::path::PathBuf;

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::{Deserialize, Serialize};

use crate::error::{FsError, Result};
use crate::roots::ApprovedRoot;
use crate::stat::modified_millis;

const DEFAULT_MAX_FILES: usize = 200_000;
const DEFAULT_MAX_DEPTH: usize = 64;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanOptions {
    /// Motifs que les **fichiers** doivent satisfaire (vide = tous). Syntaxe glob relative a la racine, `/` comme separateur.
    pub include: Vec<String>,
    /// Motifs exclus : un dossier qui correspond n'est pas parcouru.
    pub exclude: Vec<String>,
    /// Nombre maximal d'entrees (0 = valeur par defaut).
    pub max_files: usize,
    /// Profondeur maximale (0 = valeur par defaut).
    pub max_depth: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanEntry {
    /// Chemin relatif a la racine, separateur `/`.
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Symlink,
    Unreadable,
    NonUtf8Name,
    TooDeep,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntry {
    pub path: String,
    pub reason: SkipReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub entries: Vec<ScanEntry>,
    pub skipped: Vec<SkippedEntry>,
    /// Vrai si la limite `max_files` a interrompu le parcours.
    pub truncated: bool,
}

fn build_set(patterns: &[String]) -> Result<Option<GlobSet>> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let normalized = pattern.replace('\\', "/");
        let glob = GlobBuilder::new(&normalized)
            .literal_separator(true)
            .build()
            .map_err(|error| FsError::invalid_argument(format!("invalid glob pattern: {error}")))?;
        builder.add(glob);
    }
    let set = builder
        .build()
        .map_err(|error| FsError::invalid_argument(format!("invalid glob set: {error}")))?;
    Ok(Some(set))
}

/// Parcourt un projet sans suivre les liens symboliques (ils sont listes dans `skipped`). Lecture seule.
pub fn scan(root: &ApprovedRoot, options: &ScanOptions) -> Result<ScanResult> {
    let include = build_set(&options.include)?;
    let exclude = build_set(&options.exclude)?;
    let max_files = if options.max_files == 0 { DEFAULT_MAX_FILES } else { options.max_files };
    let max_depth = if options.max_depth == 0 { DEFAULT_MAX_DEPTH } else { options.max_depth };

    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    let mut truncated = false;
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(root.path.clone(), String::new(), 0)];

    'walk: while let Some((directory, prefix, depth)) = stack.pop() {
        let Ok(read_dir) = fs::read_dir(&directory) else {
            skipped.push(SkippedEntry { path: prefix.trim_end_matches('/').to_string(), reason: SkipReason::Unreadable });
            continue;
        };
        for item in read_dir {
            let Ok(item) = item else { continue };
            let Some(name) = item.file_name().to_str().map(str::to_string) else {
                skipped.push(SkippedEntry { path: format!("{prefix}?"), reason: SkipReason::NonUtf8Name });
                continue;
            };
            let relative = format!("{prefix}{name}");
            let Ok(file_type) = item.file_type() else {
                skipped.push(SkippedEntry { path: relative, reason: SkipReason::Unreadable });
                continue;
            };
            if file_type.is_symlink() {
                skipped.push(SkippedEntry { path: relative, reason: SkipReason::Symlink });
                continue;
            }
            if file_type.is_dir() {
                if let Some(set) = &exclude {
                    if set.is_match(&relative) || set.is_match(format!("{relative}/_")) {
                        continue;
                    }
                }
                if depth + 1 > max_depth {
                    skipped.push(SkippedEntry { path: relative, reason: SkipReason::TooDeep });
                    continue;
                }
                if entries.len() >= max_files {
                    truncated = true;
                    break 'walk;
                }
                entries.push(ScanEntry { path: relative.clone(), kind: EntryKind::Directory, size: 0, modified_ms: 0 });
                stack.push((item.path(), format!("{relative}/"), depth + 1));
            } else if file_type.is_file() {
                if let Some(set) = &exclude {
                    if set.is_match(&relative) {
                        continue;
                    }
                }
                if let Some(set) = &include {
                    if !set.is_match(&relative) {
                        continue;
                    }
                }
                if entries.len() >= max_files {
                    truncated = true;
                    break 'walk;
                }
                let (size, modified_ms) = match item.metadata() {
                    Ok(metadata) => (metadata.len(), modified_millis(&metadata)),
                    Err(_) => (0, 0),
                };
                entries.push(ScanEntry { path: relative, kind: EntryKind::File, size, modified_ms });
            }
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    skipped.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(ScanResult { entries, skipped, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roots::RootRegistry;
    use tempfile::tempdir;

    fn project() -> (tempfile::TempDir, ApprovedRoot) {
        let dir = tempdir().unwrap();
        for file in ["npc/cities/a.txt", "npc/cities/b.txt", "npc/quests/q.txt", "db/item_db.yml", "readme.md", ".git/config", "node_modules/x/y.txt"] {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        fs::create_dir_all(dir.path().join("empty")).unwrap();
        let root = RootRegistry::new().approve(dir.path()).unwrap();
        (dir, root)
    }

    fn files(result: &ScanResult) -> Vec<&str> {
        result.entries.iter().filter(|e| e.kind == EntryKind::File).map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn lists_everything_sorted_with_forward_slashes_and_empty_directories() {
        let (_dir, root) = project();
        let result = scan(&root, &ScanOptions::default()).unwrap();
        assert!(files(&result).contains(&"npc/cities/a.txt"));
        assert!(result.entries.iter().any(|e| e.path == "empty" && e.kind == EntryKind::Directory));
        let paths: Vec<&str> = result.entries.iter().map(|e| e.path.as_str()).collect();
        let mut sorted = paths.clone();
        sorted.sort();
        assert_eq!(paths, sorted);
        assert!(!result.truncated);
    }

    #[test]
    fn include_filters_files_only_and_exclude_prunes_directories() {
        let (_dir, root) = project();
        let options = ScanOptions {
            include: vec!["npc/**/*.txt".into()],
            exclude: vec!["**/.git/**".into(), "**/node_modules/**".into()],
            ..ScanOptions::default()
        };
        let result = scan(&root, &options).unwrap();
        assert_eq!(files(&result), vec!["npc/cities/a.txt", "npc/cities/b.txt", "npc/quests/q.txt"]);
        assert!(!result.entries.iter().any(|e| e.path.starts_with(".git") || e.path.starts_with("node_modules")));
    }

    #[test]
    fn backslash_patterns_are_accepted() {
        let (_dir, root) = project();
        let options = ScanOptions { include: vec!["npc\\cities\\*.txt".into()], ..ScanOptions::default() };
        assert_eq!(files(&scan(&root, &options).unwrap()), vec!["npc/cities/a.txt", "npc/cities/b.txt"]);
    }

    #[test]
    fn max_files_truncates_and_flags_the_result() {
        let (_dir, root) = project();
        let result = scan(&root, &ScanOptions { max_files: 3, ..ScanOptions::default() }).unwrap();
        assert_eq!(result.entries.len(), 3);
        assert!(result.truncated);
    }

    #[test]
    fn max_depth_skips_deeper_directories() {
        let (_dir, root) = project();
        let result = scan(&root, &ScanOptions { max_depth: 1, ..ScanOptions::default() }).unwrap();
        assert!(result.skipped.iter().any(|s| s.reason == SkipReason::TooDeep));
        assert!(!files(&result).contains(&"npc/cities/a.txt"));
        assert!(files(&result).contains(&"readme.md"));
    }

    #[test]
    fn invalid_pattern_is_an_argument_error() {
        let (_dir, root) = project();
        let result = scan(&root, &ScanOptions { include: vec!["[".into()], ..ScanOptions::default() });
        assert_eq!(result.unwrap_err().code(), "invalid_argument");
    }

    #[test]
    fn symlinked_directories_are_skipped_not_followed() {
        let (dir, _root) = project();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "s").unwrap();
        if !crate::roots::tests::try_symlink_dir(outside.path(), &dir.path().join("link")) {
            eprintln!("symlink non disponible, test ignore");
            return;
        }
        let root = RootRegistry::new().approve(dir.path()).unwrap();
        let result = scan(&root, &ScanOptions::default()).unwrap();
        assert!(result.skipped.iter().any(|s| s.path == "link" && s.reason == SkipReason::Symlink));
        assert!(!result.entries.iter().any(|e| e.path.starts_with("link")));
    }
}
