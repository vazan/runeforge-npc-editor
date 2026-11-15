//! Mises a jour signees : commandes IPC (DEC-046).
//!
//! Tout ce qui se decide (que telecharger, qu'installer) se decide ici, d'apres le **manifeste signe** : la page fournit un depot, un canal
//! et un jeton d'acces (qu'elle garde en memoire), et ne voit jamais un octet de la mise a jour. L'installation exige en plus l'accord de
//! l'utilisateur dans une **boite de dialogue du systeme** que la page ne peut ni afficher ni valider (comme `sftp_dry_run`).

use std::time::{Duration, Instant};

use runeforge_updater::install;
use runeforge_updater::release::RepoRef;
use runeforge_updater::{check, download, supports_install, CheckOutcome, Channel, Client, HostPolicy, UpdateConfig, UpdateError, UreqTransport, VerifiedUpdate, Version, GITHUB_API};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::app_state::AppState;

/// Evenement emis vers l'interface pendant le telechargement : `{ received, total }`.
const PROGRESS_EVENT: &str = "runeforge://update-progress";
/// Delai minimal entre deux evenements de progression.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(120);

/// Cle publique de mise a jour des versions distribuees (voir docs/RELEASE.md). Tant qu'elle n'est pas configuree, aucune mise a jour n'est possible.
#[cfg_attr(feature = "e2e", allow(dead_code))]
const PRODUCTION_KEY: &str = include_str!("../update-public-key.txt");
/// Cle de test, celle qui signe les fixtures et la release simulee de l'E2E. **Jamais** celle d'une version distribuee.
#[cfg(any(feature = "e2e", test))]
const TEST_KEY: &str = include_str!("../../../../crates/updater/tests/fixtures/keys/test.key.pub");

#[cfg(feature = "e2e")]
fn public_key() -> &'static str {
    TEST_KEY
}

#[cfg(not(feature = "e2e"))]
fn public_key() -> &'static str {
    PRODUCTION_KEY
}

/// Construction E2E : une API locale simulee (`RUNEFORGE_E2E_UPDATE_API=http://127.0.0.1:<port>`). Ailleurs, toujours GitHub.
#[cfg(feature = "e2e")]
fn api_base() -> String {
    std::env::var("RUNEFORGE_E2E_UPDATE_API").unwrap_or_else(|_| GITHUB_API.to_string())
}

#[cfg(not(feature = "e2e"))]
fn api_base() -> String {
    GITHUB_API.to_string()
}

/// Cle de plateforme des manifestes : `windows-x86_64`.
fn platform_key() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRequest {
    /// `proprietaire/depot`.
    pub repository: String,
    /// `stable` ou `beta`.
    pub channel: String,
    /// Jeton d'acces en lecture (depot prive) ; jamais enregistre par l'application.
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallRequest {
    pub token: Option<String>,
    /// Langue de la boite de dialogue du systeme (`fr` ou autre).
    pub locale: Option<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckResult {
    UpToDate {
        current: String,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        current: String,
        version: String,
        channel: String,
        notes: String,
        published_at: String,
        size: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    received: u64,
    total: u64,
}

/// La mise a jour dont le manifeste signe a ete verifie par le dernier controle : l'installation ne telecharge que celle-la.
#[derive(Clone)]
pub struct PendingUpdate {
    pub config: UpdateConfig,
    pub update: VerifiedUpdate,
}

/// Un jeton n'est fait que de lettres, de chiffres, `_` et `-` (jamais d'espace ni de saut de ligne : il part dans un en-tete HTTP).
pub fn clean_token(token: Option<&str>) -> Result<Option<String>, UpdateError> {
    let Some(token) = token.map(str::trim).filter(|token| !token.is_empty()) else { return Ok(None) };
    if token.len() > 255 || !token.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-') {
        return Err(UpdateError::InvalidToken);
    }
    Ok(Some(token.to_string()))
}

fn prepare(current: &str, request: &CheckRequest) -> Result<(UpdateConfig, Option<String>), UpdateError> {
    let current_version = Version::parse(current).map_err(|_| UpdateError::NotConfigured)?;
    let config = UpdateConfig {
        api_base: api_base(),
        repository: RepoRef::parse(&request.repository)?,
        channel: Channel::parse(&request.channel)?,
        current_version,
        platform: platform_key(),
        public_key: public_key().to_string(),
    };
    Ok((config, clean_token(request.token.as_deref())?))
}

fn client_for(config: &UpdateConfig, version: &str) -> Result<Client<UreqTransport>, UpdateError> {
    let policy = HostPolicy::for_api_base(&config.api_base, cfg!(feature = "e2e"))?;
    let https_only = policy == HostPolicy::Github;
    Ok(Client::new(UreqTransport::new(&format!("RuneForgeStudio/{version} (updater)"), https_only), policy))
}

async fn blocking<T, F>(task: F) -> Result<T, UpdateError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, UpdateError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task).await.map_err(|_| UpdateError::Io { message: "background task failed".to_string() })?
}

/// Cherche une mise a jour. Ne modifie rien sur le disque ; retient, pour l'installation, la mise a jour dont le manifeste est signe.
#[tauri::command]
pub async fn update_check(request: CheckRequest, app: AppHandle, state: State<'_, AppState>) -> Result<CheckResult, UpdateError> {
    let state = state.inner().clone();
    let current = app.package_info().version.to_string();
    blocking(move || {
        let _one_at_a_time = state.update_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // Un controle remplace le precedent : jamais d'installation d'une mise a jour issue d'un controle plus ancien.
        *state.pending_update.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        let (config, token) = prepare(&current, &request)?;
        let client = client_for(&config, &current)?;
        match check(&client, &config, token.as_deref())? {
            CheckOutcome::UpToDate => Ok(CheckResult::UpToDate { current }),
            CheckOutcome::Available(update) => {
                let result = CheckResult::Available {
                    current,
                    version: update.version.to_string(),
                    channel: update.channel.as_str().to_string(),
                    notes: update.notes.clone(),
                    published_at: update.published_at.clone(),
                    size: update.size,
                };
                *state.pending_update.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(PendingUpdate { config, update });
                Ok(result)
            }
        }
    })
    .await
}

fn confirm_install(app: &AppHandle, update: &VerifiedUpdate, locale: Option<&str>) -> bool {
    let size = format!("{:.1}", update.size as f64 / (1024.0 * 1024.0));
    let (title, text) = if locale == Some("fr") {
        (
            "Installer la mise à jour",
            format!("Remplacer RuneForge Studio par la version {} ({size} Mio) ?\n\nL'application redémarrera. Les modifications non enregistrées empêchent l'installation.", update.version),
        )
    } else {
        (
            "Install the update",
            format!("Replace RuneForge Studio with version {} ({size} MiB)?\n\nThe application will restart. Unsaved changes prevent the installation.", update.version),
        )
    };
    // Construction E2E : l'accord est donne par l'environnement (aucune boite de dialogue a piloter) ; jamais dans une version distribuee.
    #[cfg(feature = "e2e")]
    if std::env::var_os("RUNEFORGE_E2E_UPDATE_CONFIRM").is_some() {
        return true;
    }
    app.dialog().message(text).title(title).kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancel).blocking_show()
}

fn refuse_unsaved(state: &AppState) -> Result<(), UpdateError> {
    if state.dirty.load(std::sync::atomic::Ordering::SeqCst) {
        Err(UpdateError::UnsavedChanges)
    } else {
        Ok(())
    }
}

/// Telecharge, verifie puis installe la mise a jour retenue par le dernier controle ; en cas de succes l'application redemarre (la commande
/// ne rend alors pas la main). Refuse tant que des modifications ne sont pas enregistrees.
#[tauri::command]
pub async fn update_install(request: InstallRequest, app: AppHandle, state: State<'_, AppState>) -> Result<(), UpdateError> {
    let state = state.inner().clone();
    let progress_app = app.clone();
    let dialog_app = app.clone();
    let current = app.package_info().version.to_string();
    blocking(move || {
        let _one_at_a_time = state.update_lock.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        // Windows (renommages) et Linux (remplacement atomique) : voir `runeforge_updater::install`.
        if !supports_install(std::env::consts::OS) {
            return Err(UpdateError::UnsupportedPlatform);
        }
        refuse_unsaved(&state)?;
        let pending = state.pending_update.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone().ok_or(UpdateError::NoPendingUpdate)?;
        let token = clean_token(request.token.as_deref())?;
        if !confirm_install(&dialog_app, &pending.update, request.locale.as_deref()) {
            return Err(UpdateError::InstallFailed { reason: "cancelled".to_string() });
        }
        // Le fichier a remplacer est celui que Tauri relancera : l'executable demarre, ou l'AppImage (`$APPIMAGE`) sous Linux.
        let exe = tauri::process::current_binary(&dialog_app.env())?;
        let client = client_for(&pending.config, &current)?;
        // Le fichier est cree a cote de l'application avant tout telechargement : un dossier non modifiable echoue ici.
        let (mut file, path) = install::create_download_file(&exe)?;
        let mut last_emit = Instant::now().checked_sub(PROGRESS_INTERVAL).unwrap_or_else(Instant::now);
        let downloaded = download(&client, &pending.config, &pending.update, token.as_deref(), &mut file, &mut |received, total| {
            if received == total || last_emit.elapsed() >= PROGRESS_INTERVAL {
                last_emit = Instant::now();
                let _ = progress_app.emit(PROGRESS_EVENT, Progress { received, total });
            }
        });
        drop(file);
        let outcome = downloaded.and_then(|()| {
            // Des modifications ont pu etre faites pendant le telechargement : rien n'est remplace alors.
            refuse_unsaved(&state)?;
            install::apply(&exe, &path)
        });
        if outcome.is_err() {
            let _ = std::fs::remove_file(&path);
        }
        outcome
    })
    .await?;
    // L'executable a ete remplace : l'application redemarre sur la nouvelle version (le processus se termine ici).
    app.restart()
}

/// Au demarrage : supprime ce qu'une mise a jour precedente a laisse a cote de l'executable (ancienne version, fichiers interrompus).
pub fn cleanup_after_update(env: &tauri::Env) {
    if let Ok(exe) = tauri::process::current_binary(env) {
        install::cleanup_leftovers(&exe);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(repository: &str, channel: &str, token: Option<&str>) -> CheckRequest {
        CheckRequest { repository: repository.to_string(), channel: channel.to_string(), token: token.map(str::to_string) }
    }

    #[test]
    fn tokens_are_trimmed_and_limited_to_the_characters_github_uses() {
        assert_eq!(clean_token(None), Ok(None));
        assert_eq!(clean_token(Some("   ")), Ok(None));
        assert_eq!(clean_token(Some(" ghp_abc123 ")), Ok(Some("ghp_abc123".to_string())));
        assert_eq!(clean_token(Some("github_pat_11AAA_bbb-ccc")), Ok(Some("github_pat_11AAA_bbb-ccc".to_string())));
        for bad in ["ghp abc", "ghp_abc\r\nX-Evil: 1", "ghp_é", "tok;en", &"a".repeat(256)] {
            assert_eq!(clean_token(Some(bad)), Err(UpdateError::InvalidToken), "{bad:?}");
        }
    }

    #[test]
    fn a_check_request_is_validated_before_anything_is_sent() {
        assert!(prepare("0.1.0", &request("vazan/KingdomOfValhalla", "stable", Some("ghp_x"))).is_ok());
        assert_eq!(prepare("0.1.0", &request("../x", "stable", None)).unwrap_err(), UpdateError::InvalidRepository);
        assert_eq!(prepare("0.1.0", &request("o/r", "nightly", None)).unwrap_err(), UpdateError::InvalidChannel);
        assert_eq!(prepare("0.1.0", &request("o/r", "stable", Some("bad token"))).unwrap_err(), UpdateError::InvalidToken);
        assert_eq!(prepare("not a version", &request("o/r", "stable", None)).unwrap_err(), UpdateError::NotConfigured);
    }

    #[test]
    fn the_platform_key_has_the_shape_the_manifests_use() {
        let key = platform_key();
        let (os, arch) = key.split_once('-').expect("os-arch");
        assert!(!os.is_empty() && !arch.is_empty() && !arch.contains('-'), "{key}");
        #[cfg(all(windows, target_arch = "x86_64"))]
        assert_eq!(key, "windows-x86_64");
    }

    #[test]
    fn the_distributed_key_is_never_the_test_key_and_is_either_unconfigured_or_a_real_key() {
        assert_ne!(PRODUCTION_KEY.trim(), TEST_KEY.trim(), "a release must not trust the test key, whose private half is in the repository");
        match runeforge_updater::verify::load_public_key(PRODUCTION_KEY) {
            Err(error) => assert_eq!(error, UpdateError::NotConfigured, "the placeholder keeps updates disabled"),
            Ok(_) => assert!(runeforge_updater::verify::load_public_key(TEST_KEY).is_ok(), "the test key is a valid key too"),
        }
        assert!(runeforge_updater::verify::load_public_key(TEST_KEY).is_ok());
    }

    #[test]
    fn results_and_errors_have_the_shape_the_interface_reads() {
        let available = CheckResult::Available {
            current: "0.1.0".into(),
            version: "0.2.0".into(),
            channel: "stable".into(),
            notes: "n".into(),
            published_at: "2026-11-15T10:00:00Z".into(),
            size: 42,
        };
        assert_eq!(
            serde_json::to_value(&available).unwrap(),
            serde_json::json!({ "kind": "available", "current": "0.1.0", "version": "0.2.0", "channel": "stable", "notes": "n", "publishedAt": "2026-11-15T10:00:00Z", "size": 42 })
        );
        assert_eq!(serde_json::to_value(CheckResult::UpToDate { current: "0.1.0".into() }).unwrap(), serde_json::json!({ "kind": "upToDate", "current": "0.1.0" }));
        assert_eq!(serde_json::to_value(UpdateError::BadSignature).unwrap(), serde_json::json!({ "code": "bad_signature" }));
        assert_eq!(serde_json::to_value(UpdateError::ManualUpdateRequired { minimum: "0.3.0".into() }).unwrap(), serde_json::json!({ "code": "manual_update_required", "minimum": "0.3.0" }));
        let request: CheckRequest = serde_json::from_str(r#"{"repository":"o/r","channel":"beta","token":null}"#).unwrap();
        assert_eq!((request.channel.as_str(), request.token), ("beta", None));
    }
}
