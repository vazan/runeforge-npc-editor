//! Chercher une mise a jour et la telecharger : tout passe par le manifeste signe.

use std::fs::File;
use std::io::{self, Write};

use semver::Version;
use sha2::{Digest, Sha256};

use crate::client::Client;
use crate::error::UpdateError;
use crate::manifest::{MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES};
use crate::platform::ExecutableKind;
use crate::release::{self, RepoRef, MANIFEST_ASSET, MAX_LIST_BYTES, SIGNATURE_ASSET};
use crate::transport::Transport;
use crate::verify::{self, MAX_SIGNATURE_BYTES};
use crate::version::Channel;

/// Nombre de releases recentes examinees au plus : une release plus recente sans fichier pour cette plateforme ne masque pas la suivante.
const MAX_CANDIDATES: usize = 3;

#[derive(Debug, Clone)]
pub struct UpdateConfig {
    /// `https://api.github.com` (une API locale seulement pour les tests et la construction E2E).
    pub api_base: String,
    pub repository: RepoRef,
    pub channel: Channel,
    pub current_version: Version,
    /// Cle de plateforme du manifeste : `windows-x86_64`.
    pub platform: String,
    /// Cle publique de mise a jour : le texte du fichier `.pub` (ou celui de minisign).
    pub public_key: String,
}

/// Une mise a jour dont le manifeste est signe par l'editeur : tout ce qu'il faut pour la telecharger puis la verifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedUpdate {
    pub version: Version,
    pub channel: Channel,
    pub notes: String,
    pub published_at: String,
    pub release_tag: String,
    pub file: String,
    pub size: u64,
    /// SHA-256 de l'executable, en hexadecimal minuscule.
    pub sha256: String,
    asset_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    UpToDate,
    Available(VerifiedUpdate),
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Cherche la release la plus recente que l'on peut installer.
///
/// Le jeton n'est joint qu'aux requetes a l'API (voir `client`). Une signature invalide sur la release la plus recente est une erreur,
/// pas une raison de proposer une release plus ancienne.
pub fn check<T: Transport>(client: &Client<T>, config: &UpdateConfig, token: Option<&str>) -> Result<CheckOutcome, UpdateError> {
    let key = verify::load_public_key(&config.public_key)?;
    let list = client.get_bytes(&config.repository.releases_url(&config.api_base), token, "application/vnd.github+json", MAX_LIST_BYTES)?;
    let releases = release::parse_releases(&list)?;
    let mut skipped = None;
    for candidate in release::candidates(&releases, &config.current_version, config.channel).into_iter().take(MAX_CANDIDATES) {
        // Une release encore en cours de publication n'a pas ses fichiers : on regarde la precedente.
        let (Some(manifest_asset), Some(signature_asset)) = (candidate.asset(MANIFEST_ASSET), candidate.asset(SIGNATURE_ASSET)) else { continue };
        if manifest_asset.size > MAX_MANIFEST_BYTES as u64 || signature_asset.size > MAX_SIGNATURE_BYTES as u64 {
            return Err(UpdateError::bad_manifest("size"));
        }
        let manifest_bytes = client.get_bytes(&config.repository.asset_url(&config.api_base, manifest_asset.id), token, "application/octet-stream", MAX_MANIFEST_BYTES as u64)?;
        let signature_bytes = client.get_bytes(&config.repository.asset_url(&config.api_base, signature_asset.id), token, "application/octet-stream", MAX_SIGNATURE_BYTES as u64)?;
        let signature = String::from_utf8(signature_bytes).map_err(|_| UpdateError::BadSignature)?;
        let manifest = verify::verify_manifest(&key, &manifest_bytes, &signature)?;

        // Le manifeste signe fait foi ; l'etiquette et l'indicateur de la release ne doivent pas le contredire.
        if manifest.version != candidate.version {
            return Err(UpdateError::bad_manifest("tag"));
        }
        if candidate.prerelease != (manifest.channel == Channel::Beta) {
            return Err(UpdateError::bad_manifest("channel"));
        }
        if let Some(minimum) = &manifest.minimum_version {
            if config.current_version < *minimum {
                skipped = Some(UpdateError::ManualUpdateRequired { minimum: minimum.to_string() });
                continue;
            }
        }
        let Some(entry) = manifest.platforms.get(&config.platform) else {
            skipped = Some(UpdateError::NoPlatformAsset);
            continue;
        };
        let Some(artifact) = candidate.asset(&entry.file) else {
            skipped = Some(UpdateError::NoPlatformAsset);
            continue;
        };
        if artifact.size != entry.size {
            return Err(UpdateError::bad_manifest("size"));
        }
        return Ok(CheckOutcome::Available(VerifiedUpdate {
            version: manifest.version,
            channel: manifest.channel,
            notes: manifest.notes,
            published_at: manifest.published_at,
            release_tag: candidate.tag.clone(),
            file: entry.file.clone(),
            size: entry.size,
            sha256: entry.sha256.clone(),
            asset_id: artifact.id,
        }));
    }
    match skipped {
        Some(error) => Err(error),
        None => Ok(CheckOutcome::UpToDate),
    }
}

/// Nombre d'octets du debut du fichier que l'on garde pour reconnaitre le format de l'executable (`MZ`, ou `\x7fELF`).
const HEAD_BYTES: usize = 4;

/// Ecrit dans le fichier en calculant l'empreinte au passage, et garde les premiers octets (l'en-tete de l'executable).
struct Sink<'a> {
    file: &'a mut File,
    hasher: Sha256,
    written: u64,
    head: [u8; HEAD_BYTES],
}

impl Write for Sink<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.file.write_all(buf)?;
        for (offset, byte) in buf.iter().take(HEAD_BYTES).enumerate() {
            let position = self.written as usize + offset;
            if position < HEAD_BYTES {
                self.head[position] = *byte;
            }
        }
        self.hasher.update(buf);
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// Telecharge l'executable annonce par le manifeste signe dans `file`, puis le verifie : taille, SHA-256 et en-tete d'executable.
/// En cas d'echec, le fichier est inutilisable (l'appelant le supprime).
pub fn download<T: Transport>(
    client: &Client<T>,
    config: &UpdateConfig,
    update: &VerifiedUpdate,
    token: Option<&str>,
    file: &mut File,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<(), UpdateError> {
    if update.size == 0 || update.size > MAX_ARTIFACT_BYTES {
        return Err(UpdateError::TooLarge);
    }
    // Le format attendu vient du systeme de la plateforme (`windows-*` : MZ, `linux-*` : ELF) : un executable d'un autre systeme, meme
    // signe, n'est pas celui de cet ordinateur. Un systeme que l'on ne sait pas installer ne telecharge rien.
    let kind = ExecutableKind::for_platform(&config.platform).ok_or(UpdateError::UnsupportedPlatform)?;
    let url = config.repository.asset_url(&config.api_base, update.asset_id);
    let mut sink = Sink { file, hasher: Sha256::new(), written: 0, head: [0; HEAD_BYTES] };
    client.get_to(&url, token, "application/octet-stream", &mut sink, update.size, &mut |received, _| progress(received, update.size))?;
    if sink.written != update.size || to_hex(&sink.hasher.finalize()) != update.sha256 {
        return Err(UpdateError::HashMismatch);
    }
    if !kind.matches(&sink.head) {
        return Err(UpdateError::NotExecutable);
    }
    sink.file.sync_all()?;
    Ok(())
}
