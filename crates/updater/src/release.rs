//! Releases d'un depot GitHub (API REST) : lecture de la liste et choix des candidates.
//!
//! Ce que dit la liste (etiquette, indicateur de pre-version, noms de fichiers) sert seulement a **choisir quoi telecharger** ;
//! la decision d'installer ne repose que sur le manifeste signe (`verify`, `manifest`).

use semver::Version;
use serde::Deserialize;

use crate::error::UpdateError;
use crate::version::{parse_tag, Channel};

pub const MANIFEST_ASSET: &str = "update-manifest.json";
pub const SIGNATURE_ASSET: &str = "update-manifest.json.sig";
/// Taille maximale d'une page de releases (30 releases d'un depot ordinaire en pesent une centaine de Kio).
pub const MAX_LIST_BYTES: u64 = 2 * 1024 * 1024;
/// Nombre de releases lues par appel.
pub const PER_PAGE: u32 = 30;

/// `proprietaire/depot` : seuls les caracteres que GitHub admet, jamais un chemin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub owner: String,
    pub name: String,
}

fn is_name(part: &str, max: usize) -> bool {
    !part.is_empty()
        && part.len() <= max
        && part != "."
        && part != ".."
        && part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

impl RepoRef {
    pub fn parse(text: &str) -> Result<Self, UpdateError> {
        let (owner, name) = text.trim().split_once('/').ok_or(UpdateError::InvalidRepository)?;
        if !is_name(owner, 39) || !is_name(name, 100) || name.contains('/') {
            return Err(UpdateError::InvalidRepository);
        }
        Ok(RepoRef { owner: owner.to_string(), name: name.to_string() })
    }

    pub fn releases_url(&self, api_base: &str) -> String {
        format!("{api_base}/repos/{}/{}/releases?per_page={PER_PAGE}", self.owner, self.name)
    }

    /// Adresse d'un fichier de release. Construite ici, jamais copiee de la liste : un flux hostile ne peut pas detourner le telechargement.
    pub fn asset_url(&self, api_base: &str, id: u64) -> String {
        format!("{api_base}/repos/{}/{}/releases/assets/{id}", self.owner, self.name)
    }
}

#[derive(Deserialize)]
struct RawRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<RawAsset>,
}

#[derive(Deserialize)]
struct RawAsset {
    id: u64,
    name: String,
    size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub id: u64,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub tag: String,
    pub version: Version,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
}

impl Release {
    pub fn asset(&self, name: &str) -> Option<&Asset> {
        self.assets.iter().find(|asset| asset.name == name)
    }
}

/// Lit la liste des releases. Les brouillons et les etiquettes qui ne sont pas des versions (`nightly`, `v1`) sont ignores.
pub fn parse_releases(json: &[u8]) -> Result<Vec<Release>, UpdateError> {
    let raw: Vec<RawRelease> = serde_json::from_slice(json).map_err(|_| UpdateError::BadResponse)?;
    Ok(raw
        .into_iter()
        .filter(|release| !release.draft)
        .filter_map(|release| {
            let version = parse_tag(&release.tag_name)?;
            Some(Release {
                tag: release.tag_name,
                version,
                prerelease: release.prerelease,
                assets: release.assets.into_iter().map(|asset| Asset { id: asset.id, name: asset.name, size: asset.size }).collect(),
            })
        })
        .collect())
}

/// Releases plus recentes que `current`, la plus recente d'abord. Le canal stable exclut toute pre-version, que GitHub la marque ou non.
pub fn candidates<'a>(releases: &'a [Release], current: &Version, channel: Channel) -> Vec<&'a Release> {
    let mut found: Vec<&Release> = releases
        .iter()
        .filter(|release| release.version > *current)
        .filter(|release| channel == Channel::Beta || (!release.prerelease && release.version.pre.is_empty()))
        .collect();
    found.sort_by(|a, b| b.version.cmp(&a.version));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, prerelease: bool) -> Release {
        Release { tag: tag.to_string(), version: parse_tag(tag).unwrap(), prerelease, assets: Vec::new() }
    }

    #[test]
    fn repository_names_are_validated() {
        let ok = RepoRef::parse("vazan/KingdomOfValhalla").unwrap();
        assert_eq!((ok.owner.as_str(), ok.name.as_str()), ("vazan", "KingdomOfValhalla"));
        assert!(RepoRef::parse(" owner/repo.name_1 ").is_ok());
        for bad in ["", "owner", "owner/", "/repo", "a/b/c", "../x", "owner/..", "o w/r", "owner/re po", "owner/re?po", "own:er/repo", "o/r#x", &format!("{}/r", "a".repeat(40)), &format!("o/{}", "r".repeat(101))] {
            assert_eq!(RepoRef::parse(bad), Err(UpdateError::InvalidRepository), "{bad}");
        }
    }

    #[test]
    fn urls_are_built_from_validated_parts_only() {
        let repo = RepoRef::parse("o/r").unwrap();
        assert_eq!(repo.releases_url("https://api.github.com"), "https://api.github.com/repos/o/r/releases?per_page=30");
        assert_eq!(repo.asset_url("https://api.github.com", 42), "https://api.github.com/repos/o/r/releases/assets/42");
    }

    #[test]
    fn reads_the_github_release_list_and_ignores_drafts_and_foreign_tags() {
        let json = br#"[
          {"tag_name":"v0.3.0","draft":false,"prerelease":false,"assets":[{"id":11,"name":"update-manifest.json","size":500,"url":"https://evil.example/x","extra":1},{"id":12,"name":"update-manifest.json.sig","size":400}]},
          {"tag_name":"v0.4.0","draft":true,"prerelease":false,"assets":[]},
          {"tag_name":"nightly","draft":false,"prerelease":true,"assets":[]},
          {"tag_name":"0.2.0","draft":false,"prerelease":false}
        ]"#;
        let releases = parse_releases(json).unwrap();
        assert_eq!(releases.iter().map(|r| r.tag.as_str()).collect::<Vec<_>>(), ["v0.3.0", "0.2.0"]);
        let first = &releases[0];
        assert_eq!(first.asset(MANIFEST_ASSET), Some(&Asset { id: 11, name: "update-manifest.json".to_string(), size: 500 }));
        assert_eq!(first.asset(SIGNATURE_ASSET).map(|a| a.id), Some(12));
        assert_eq!(first.asset("missing.exe"), None);
        assert!(releases[1].assets.is_empty());
    }

    #[test]
    fn refuses_a_response_that_is_not_a_release_list() {
        for bad in [&b"{}"[..], b"[1,2]", b"", b"<html>", br#"[{"draft":false}]"#] {
            assert_eq!(parse_releases(bad), Err(UpdateError::BadResponse));
        }
    }

    #[test]
    fn candidates_are_newer_than_the_current_version_newest_first() {
        let releases = vec![release("v0.1.0", false), release("v0.3.0", false), release("v0.2.0", false), release("v0.0.9", false)];
        let found = candidates(&releases, &Version::new(0, 1, 0), Channel::Stable);
        assert_eq!(found.iter().map(|r| r.tag.as_str()).collect::<Vec<_>>(), ["v0.3.0", "v0.2.0"]);
        assert!(candidates(&releases, &Version::new(0, 3, 0), Channel::Stable).is_empty());
    }

    #[test]
    fn the_stable_channel_never_offers_a_pre_release_the_beta_channel_does() {
        let releases = vec![release("v0.2.0", false), release("v0.3.0-beta.1", true), release("v0.4.0-rc.1", false)];
        let stable = candidates(&releases, &Version::new(0, 1, 0), Channel::Stable);
        assert_eq!(stable.iter().map(|r| r.tag.as_str()).collect::<Vec<_>>(), ["v0.2.0"]);
        let beta = candidates(&releases, &Version::new(0, 1, 0), Channel::Beta);
        assert_eq!(beta.iter().map(|r| r.tag.as_str()).collect::<Vec<_>>(), ["v0.4.0-rc.1", "v0.3.0-beta.1", "v0.2.0"]);
        // Une release marquee pre-version est exclue du canal stable meme avec une version finale.
        let flagged = vec![release("v0.5.0", true)];
        assert!(candidates(&flagged, &Version::new(0, 1, 0), Channel::Stable).is_empty());
    }
}
