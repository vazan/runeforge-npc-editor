//! Outils communs des tests d'integration : un GitHub simule et les fixtures signees (`scripts/release/make-update-fixtures.ts`).

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use runeforge_updater::release::RepoRef;
use runeforge_updater::transport::{RawResponse, Request, Transport};
use runeforge_updater::{Channel, Client, HostPolicy, UpdateConfig, UpdateError};
use semver::Version;

pub const API: &str = "https://api.github.com";
pub const CDN: &str = "https://release-assets.githubusercontent.com/signed";
pub const TOKEN: &str = "ghp_test_token_value";

pub fn fixture(name: &str) -> Vec<u8> {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "tests", "fixtures", name].iter().collect();
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

pub fn fixture_text(name: &str) -> String {
    String::from_utf8(fixture(name)).unwrap()
}

pub fn test_public_key() -> String {
    fixture_text("keys/test.key.pub")
}

pub enum Route {
    Body(Vec<u8>),
    Redirect(String),
    Status(u16),
}

/// Un GitHub simule : une table adresse -> reponse, et la liste de ce qu'on lui a demande (adresse, jeton recu).
#[derive(Default)]
pub struct World {
    routes: HashMap<String, Route>,
    pub seen: Mutex<Vec<(String, Option<String>)>>,
}

impl World {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn route(mut self, url: &str, route: Route) -> Self {
        self.routes.insert(url.to_string(), route);
        self
    }

    pub fn body(self, url: &str, bytes: &[u8]) -> Self {
        self.route(url, Route::Body(bytes.to_vec()))
    }

    /// Ajoute une release avec ses fichiers : le manifeste (nom d'une fixture) et son artefact eventuel (octets), la liste des releases
    /// etant composee par `releases_json`.
    pub fn asset(self, id: u64, bytes: &[u8]) -> Self {
        self.body(&asset_url(id), bytes)
    }

    pub fn seen_urls(&self) -> Vec<String> {
        self.seen.lock().unwrap().iter().map(|(url, _)| url.clone()).collect()
    }

    pub fn tokens_received_by(&self, url_prefix: &str) -> Vec<Option<String>> {
        self.seen.lock().unwrap().iter().filter(|(url, _)| url.starts_with(url_prefix)).map(|(_, token)| token.clone()).collect()
    }
}

impl Transport for World {
    fn execute(&self, request: &Request<'_>, sink: &mut dyn Write, limit: u64, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<RawResponse, UpdateError> {
        self.seen.lock().unwrap().push((request.url.to_string(), request.bearer.map(str::to_string)));
        match self.routes.get(request.url) {
            None => Ok(RawResponse { status: 404, ..RawResponse::default() }),
            Some(Route::Status(status)) => Ok(RawResponse { status: *status, ..RawResponse::default() }),
            Some(Route::Redirect(location)) => Ok(RawResponse { status: 302, location: Some(location.clone()), ..RawResponse::default() }),
            Some(Route::Body(bytes)) => {
                if bytes.len() as u64 > limit {
                    return Err(UpdateError::TooLarge);
                }
                sink.write_all(bytes)?;
                progress(bytes.len() as u64, Some(bytes.len() as u64));
                Ok(RawResponse { status: 200, content_length: Some(bytes.len() as u64), ..RawResponse::default() })
            }
        }
    }
}

pub fn client(world: World) -> Client<World> {
    Client::new(world, HostPolicy::Github)
}

pub fn config(current: &str, channel: Channel) -> UpdateConfig {
    config_for("windows-x86_64", current, channel)
}

/// La configuration d'un ordinateur de la plateforme `platform` (`windows-x86_64`, `linux-x86_64`...).
pub fn config_for(platform: &str, current: &str, channel: Channel) -> UpdateConfig {
    UpdateConfig {
        api_base: API.to_string(),
        repository: RepoRef::parse("o/r").unwrap(),
        channel,
        current_version: Version::parse(current).unwrap(),
        platform: platform.to_string(),
        public_key: test_public_key(),
    }
}

pub fn releases_url() -> String {
    format!("{API}/repos/o/r/releases?per_page=30")
}

pub fn asset_url(id: u64) -> String {
    format!("{API}/repos/o/r/releases/assets/{id}")
}

/// Une release de la liste : `(identifiant, nom, taille)` par fichier.
pub struct ReleaseSpec {
    pub tag: &'static str,
    pub prerelease: bool,
    pub assets: Vec<(u64, String, u64)>,
}

pub fn releases_json(releases: &[ReleaseSpec]) -> Vec<u8> {
    let list: Vec<serde_json::Value> = releases
        .iter()
        .map(|release| {
            serde_json::json!({
                "tag_name": release.tag,
                "draft": false,
                "prerelease": release.prerelease,
                "assets": release.assets.iter().map(|(id, name, size)| serde_json::json!({ "id": id, "name": name, "size": size })).collect::<Vec<_>>(),
            })
        })
        .collect();
    serde_json::to_vec(&list).unwrap()
}

/// Une release complete a partir d'une fixture de manifeste : fichiers `update-manifest.json`, sa signature et l'executable annonce.
/// Les identifiants sont `base`, `base + 1` et `base + 2`.
pub fn published(world: World, base: u64, tag: &'static str, prerelease: bool, fixture_name: &str, artifact_name: &str, artifact: &[u8]) -> (World, ReleaseSpec) {
    published_with(world, base, tag, prerelease, fixture_name, artifact_name, artifact, artifact)
}

/// Une release a plusieurs executables (un par plateforme) : le manifeste signe de la fixture, sa signature, puis chaque fichier
/// `(nom, octets)` dans l'ordre donne. Les identifiants sont `base`, `base + 1`, puis `base + 2`, `base + 3`...
pub fn published_multi(world: World, base: u64, tag: &'static str, fixture_name: &str, artifacts: &[(&str, &[u8])]) -> (World, ReleaseSpec) {
    let manifest = fixture(&format!("{fixture_name}.manifest.json"));
    let signature = fixture(&format!("{fixture_name}.manifest.json.sig"));
    let mut assets = vec![(base, "update-manifest.json".to_string(), manifest.len() as u64), (base + 1, "update-manifest.json.sig".to_string(), signature.len() as u64)];
    let mut world = world.asset(base, &manifest).asset(base + 1, &signature);
    for (index, (name, bytes)) in artifacts.iter().enumerate() {
        let id = base + 2 + index as u64;
        assets.push((id, name.to_string(), bytes.len() as u64));
        world = world.route(&asset_url(id), Route::Redirect(format!("{CDN}/{id}"))).body(&format!("{CDN}/{id}"), bytes);
    }
    (world, ReleaseSpec { tag, prerelease: false, assets })
}

/// Comme `published`, mais le stockage sert `served` alors que la liste annonce la taille de `listed` (un serveur qui ment).
#[allow(clippy::too_many_arguments)]
pub fn published_with(world: World, base: u64, tag: &'static str, prerelease: bool, fixture_name: &str, artifact_name: &str, listed: &[u8], served: &[u8]) -> (World, ReleaseSpec) {
    let manifest = fixture(&format!("{fixture_name}.manifest.json"));
    let signature = fixture(&format!("{fixture_name}.manifest.json.sig"));
    let spec = ReleaseSpec {
        tag,
        prerelease,
        assets: vec![
            (base, "update-manifest.json".to_string(), manifest.len() as u64),
            (base + 1, "update-manifest.json.sig".to_string(), signature.len() as u64),
            (base + 2, artifact_name.to_string(), listed.len() as u64),
        ],
    };
    // L'executable est servi par une redirection vers le stockage, comme le fait GitHub.
    let world = world
        .asset(base, &manifest)
        .asset(base + 1, &signature)
        .route(&asset_url(base + 2), Route::Redirect(format!("{CDN}/{base}")))
        .body(&format!("{CDN}/{base}"), served);
    (world, spec)
}
