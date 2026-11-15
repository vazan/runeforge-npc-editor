//! Commandes IPC exposees au frontend : une couche mince au-dessus de `runeforge-filesystem`.
//!
//! Regles (CLAUDE.md 14.1, 19.2) : le frontend ne fournit jamais de chemin absolu (il designe une racine
//! approuvee + un chemin relatif) ; toute entree est validee cote Rust ; les erreurs sont structurees et sans
//! chemin absolu ; les operations de disque s'executent hors du fil principal.

use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::PoisonError;

use runeforge_filesystem::util::now_millis;
use runeforge_filesystem::{
    read_file, scan, write_file as fs_write_file, ApprovedRoot, ConfigStore, DiagnosticLog, FsError, HistoryEntry, LogLevel,
    Precondition, RecoveryEntry, ScanOptions, ScanResult, WriteOutcome, DEFAULT_MAX_FILE_BYTES,
};
use runeforge_git::{GitError, GitStatus};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::app_state::AppState;
use crate::frames::{self, Frame};
use crate::headers::header_json;
use crate::recents::{self, RecentProject};

type CmdResult<T> = Result<T, FsError>;

/// En-tete portant les metadonnees JSON (encodees comme `encodeURIComponent`) des commandes a corps binaire.
const META_HEADER: &str = "x-rf-meta";
/// Nombre maximal de fichiers lus par appel `read_files` (le frontend decoupe en lots).
const MAX_BATCH: usize = 2048;
/// Taille maximale d'un fichier ecrit ou d'un instantane de recuperation.
const MAX_WRITE_BYTES: usize = 64 * 1024 * 1024;
/// Documents de configuration que le frontend a le droit de lire et ecrire (les projets recents sont geres cote Rust).
const CONFIG_NAMES: [&str; 3] = ["settings", "session", "layout"];

/// Execute une tache bloquante (disque) hors du fil principal.
async fn blocking<T, F>(task: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(task).await {
        Ok(result) => result,
        Err(error) => Err(FsError::Io { message: format!("background task failed: {error}") }),
    }
}

fn frame_for_error(path: &str, error: &FsError) -> Frame {
    Frame { meta: json!({ "path": path, "ok": false, "error": error }), data: Vec::new() }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    name: String,
    version: String,
    platform: &'static str,
    /// Vrai uniquement pour une construction de test E2E.
    e2e: bool,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let package = app.package_info();
    AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        platform: std::env::consts::OS,
        e2e: cfg!(feature = "e2e"),
    }
}

/// Ouvre le selecteur de dossier natif ; le dossier choisi devient une racine approuvee.
#[tauri::command]
pub async fn pick_project_folder(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<ApprovedRoot>> {
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || dialog_app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|error| FsError::Io { message: format!("dialog failed: {error}") })?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked
        .into_path()
        .map_err(|_| FsError::invalid_argument("unsupported folder location"))?;
    let state = state.inner().clone();
    blocking(move || {
        let root = state.roots.approve(&path)?;
        recents::touch(&state.config, &root, now_millis())?;
        Ok(Some(root))
    })
    .await
}

/// Ouvre le selecteur de dossier natif pour choisir la **destination d'un deploiement** ; le dossier devient une racine approuvee, comme un
/// projet, mais n'entre pas dans la liste des projets recents. Construction de test E2E : `RUNEFORGE_E2E_DESTINATION` le designe sans boite
/// de dialogue (jamais dans une version distribuee).
#[tauri::command]
pub async fn pick_destination_folder(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Option<ApprovedRoot>> {
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("RUNEFORGE_E2E_DESTINATION") {
        let state = state.inner().clone();
        return blocking(move || Ok(Some(state.roots.approve(Path::new(&path))?))).await;
    }
    let dialog_app = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || dialog_app.dialog().file().blocking_pick_folder())
        .await
        .map_err(|error| FsError::Io { message: format!("dialog failed: {error}") })?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|_| FsError::invalid_argument("unsupported folder location"))?;
    let state = state.inner().clone();
    blocking(move || Ok(Some(state.roots.approve(&path)?))).await
}

#[tauri::command]
pub async fn list_recent_projects(state: State<'_, AppState>) -> CmdResult<Vec<RecentProject>> {
    let state = state.inner().clone();
    blocking(move || Ok(recents::load(&state.config))).await
}

/// Rouvre un projet deja choisi par l'utilisateur lors d'une session precedente (sans nouvelle boite de dialogue).
#[tauri::command]
pub async fn open_recent_project(path: String, state: State<'_, AppState>) -> CmdResult<ApprovedRoot> {
    let state = state.inner().clone();
    blocking(move || {
        if !recents::contains(&state.config, &path) {
            return Err(FsError::UnknownRoot);
        }
        let root = state.roots.approve(Path::new(&path))?;
        recents::touch(&state.config, &root, now_millis())?;
        Ok(root)
    })
    .await
}

#[tauri::command]
pub async fn forget_recent_project(path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let state = state.inner().clone();
    blocking(move || recents::forget(&state.config, &path)).await
}

#[tauri::command]
pub async fn scan_project(
    root_id: String,
    options: Option<ScanOptions>,
    state: State<'_, AppState>,
) -> CmdResult<ScanResult> {
    let state = state.inner().clone();
    blocking(move || {
        let root = state.roots.get(&root_id)?;
        scan(&root, &options.unwrap_or_default())
    })
    .await
}

fn read_frame(state: &AppState, root_id: &str, path: &str, limit: u64) -> Frame {
    match read_file(&state.roots, root_id, path, limit) {
        Ok(read) => Frame { meta: json!({ "path": path, "ok": true, "stat": read.stat }), data: read.bytes },
        Err(error) => frame_for_error(path, &error),
    }
}

/// Lit plusieurs fichiers en parallele. Reponse binaire (voir `frames::encode`) : un enregistrement par chemin demande,
/// dans le meme ordre ; un echec de lecture n'interrompt pas les autres fichiers.
#[tauri::command]
pub async fn read_files(
    root_id: String,
    paths: Vec<String>,
    max_bytes: Option<u64>,
    state: State<'_, AppState>,
) -> CmdResult<Response> {
    if paths.len() > MAX_BATCH {
        return Err(FsError::invalid_argument("too many files in one request"));
    }
    let limit = max_bytes.unwrap_or(DEFAULT_MAX_FILE_BYTES).min(DEFAULT_MAX_FILE_BYTES);
    let state = state.inner().clone();
    blocking(move || {
        let workers = std::thread::available_parallelism().map(|count| count.get()).unwrap_or(2).clamp(1, 8);
        let chunk_size = paths.len().div_ceil(workers).max(1);
        let frames: Vec<Frame> = std::thread::scope(|scope| {
            let handles: Vec<_> = paths
                .chunks(chunk_size)
                .map(|chunk| {
                    let state = &state;
                    let root_id = &root_id;
                    scope.spawn(move || {
                        chunk.iter().map(|path| read_frame(state, root_id, path, limit)).collect::<Vec<Frame>>()
                    })
                })
                .collect();
            handles.into_iter().flat_map(|handle| handle.join().unwrap_or_default()).collect()
        });
        if frames.len() != paths.len() {
            return Err(FsError::Io { message: "a reader thread failed".into() });
        }
        Ok(Response::new(frames::encode(&frames)))
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteMeta {
    root_id: String,
    path: String,
    precondition: Precondition,
    #[serde(default = "default_true")]
    keep_history: bool,
}

fn default_true() -> bool {
    true
}

fn raw_body<'a>(request: &'a Request<'_>) -> CmdResult<&'a Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_WRITE_BYTES => Ok(bytes),
        InvokeBody::Raw(bytes) => Err(FsError::TooLarge { size: bytes.len() as u64, limit: MAX_WRITE_BYTES as u64 }),
        InvokeBody::Json(_) => Err(FsError::invalid_argument("expected a binary body")),
    }
}

/// Ecrit un fichier (corps binaire = contenu ; metadonnees dans l'en-tete `x-rf-meta`).
#[tauri::command]
pub async fn write_file(request: Request<'_>, state: State<'_, AppState>) -> CmdResult<WriteOutcome> {
    let meta: WriteMeta = header_json(request.headers(), META_HEADER)?;
    let data = raw_body(&request)?.clone();
    let state = state.inner().clone();
    blocking(move || {
        let history = if meta.keep_history { Some(&state.history) } else { None };
        fs_write_file(&state.roots, &meta.root_id, &meta.path, &data, &meta.precondition, history)
    })
    .await
}

/// Cree un dossier dans le projet (ex. `.runeforge`). Retourne `true` s'il a ete cree.
#[tauri::command]
pub async fn create_directory(root_id: String, path: String, state: State<'_, AppState>) -> CmdResult<bool> {
    let state = state.inner().clone();
    blocking(move || runeforge_filesystem::create_directory(&state.roots, &root_id, &path)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryMeta {
    root_id: String,
    path: String,
    base_sha256: Option<String>,
    encoding: Option<String>,
}

#[tauri::command]
pub async fn recovery_save(request: Request<'_>, state: State<'_, AppState>) -> CmdResult<()> {
    let meta: RecoveryMeta = header_json(request.headers(), META_HEADER)?;
    let data = raw_body(&request)?.clone();
    let state = state.inner().clone();
    blocking(move || {
        // La racine doit etre approuvee : on n'ecrit pas d'instantane pour un projet inconnu.
        state.roots.get(&meta.root_id)?;
        state.recovery.save(&meta.root_id, &meta.path, &data, meta.base_sha256, meta.encoding)
    })
    .await
}

#[tauri::command]
pub async fn recovery_list(root_id: String, state: State<'_, AppState>) -> CmdResult<Vec<RecoveryEntry>> {
    let state = state.inner().clone();
    blocking(move || {
        state.roots.get(&root_id)?;
        state.recovery.list(&root_id)
    })
    .await
}

#[tauri::command]
pub async fn recovery_read(root_id: String, path: String, state: State<'_, AppState>) -> CmdResult<Response> {
    let state = state.inner().clone();
    blocking(move || {
        state.roots.get(&root_id)?;
        let (meta, data) = state.recovery.read(&root_id, &path)?;
        Ok(Response::new(frames::encode(&[Frame {
            meta: json!({ "path": path, "ok": true, "recovery": meta }),
            data,
        }])))
    })
    .await
}

#[tauri::command]
pub async fn recovery_clear(root_id: String, path: String, state: State<'_, AppState>) -> CmdResult<()> {
    let state = state.inner().clone();
    blocking(move || {
        state.roots.get(&root_id)?;
        state.recovery.clear(&root_id, &path)
    })
    .await
}

#[tauri::command]
pub async fn history_list(root_id: String, path: String, state: State<'_, AppState>) -> CmdResult<Vec<HistoryEntry>> {
    let state = state.inner().clone();
    blocking(move || {
        state.roots.get(&root_id)?;
        state.history.list(&root_id, &path)
    })
    .await
}

#[tauri::command]
pub async fn history_read(
    root_id: String,
    path: String,
    id: String,
    state: State<'_, AppState>,
) -> CmdResult<Response> {
    let state = state.inner().clone();
    blocking(move || {
        state.roots.get(&root_id)?;
        let data = state.history.read(&root_id, &path, &id)?;
        Ok(Response::new(frames::encode(&[Frame { meta: json!({ "path": path, "ok": true, "id": id }), data }])))
    })
    .await
}

fn check_config_name(name: &str) -> CmdResult<()> {
    if CONFIG_NAMES.contains(&name) {
        Ok(())
    } else {
        Err(FsError::invalid_argument("unknown config document"))
    }
}

#[tauri::command]
pub async fn config_get(name: String, state: State<'_, AppState>) -> CmdResult<Option<String>> {
    check_config_name(&name)?;
    let state = state.inner().clone();
    blocking(move || state.config.read(&name)).await
}

/// Vrai si l'utilisateur a active le journal de diagnostic local (`logging.enabled` du document `settings`). Toute anomalie de
/// lecture (document absent, JSON invalide, valeur d'un autre type) vaut « desactive » : sans accord explicite, rien n'est ecrit.
fn logging_enabled(config: &ConfigStore) -> bool {
    config
        .read("settings")
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value["logging"]["enabled"].as_bool())
        .unwrap_or(false)
}

/// Ajoute un evenement au journal de diagnostic local **si l'utilisateur l'a active**, sinon ne fait rien (retourne `false`).
/// Le journal valide le schéma de chaque événement dans `runeforge_filesystem::log`.
#[tauri::command]
pub async fn log_event(level: String, code: String, detail: String, state: State<'_, AppState>) -> CmdResult<bool> {
    let state = state.inner().clone();
    blocking(move || log_if_enabled(&state.config, &state.log, &level, &code, &detail)).await
}

/// Le coeur de `log_event` : sans accord de l'utilisateur rien n'est ecrit **et rien n'est valide** (une entree refusee ne doit pas
/// reveler a une page malveillante si le journal est actif) ; avec, l'entree est validee puis ajoutee.
fn log_if_enabled(config: &ConfigStore, log: &DiagnosticLog, level: &str, code: &str, detail: &str) -> CmdResult<bool> {
    if !logging_enabled(config) {
        return Ok(false);
    }
    log.append(LogLevel::parse(level)?, code, detail)?;
    Ok(true)
}

#[tauri::command]
pub async fn config_set(name: String, json: String, state: State<'_, AppState>) -> CmdResult<()> {
    check_config_name(&name)?;
    let state = state.inner().clone();
    blocking(move || state.config.write(&name, &json)).await
}

// ---------------------------------------------------------------------------------------------
// Git, en lecture seule, apres consentement (CLAUDE.md 14.2, DEC-039)
// ---------------------------------------------------------------------------------------------

/// Document de configuration propre au coeur natif — absent de `CONFIG_NAMES` : la page ne peut ni le lire ni l'ecrire — qui retient les
/// projets pour lesquels l'utilisateur a autorise Git. Il n'est jamais lu dans le projet : un dossier recu d'un tiers ne peut pas
/// s'accorder lui-meme cette confiance.
const GIT_TRUST_DOC: &str = "git-trust";
/// Nombre maximal de projets retenus (le plus ancien est oublie).
const MAX_GIT_TRUSTED: usize = 500;

fn trusted_git_roots(config: &ConfigStore) -> Vec<String> {
    config
        .read(GIT_TRUST_DOC)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value["roots"].as_array().map(|roots| roots.iter().filter_map(|root| root.as_str().map(str::to_string)).collect()))
        .unwrap_or_default()
}

/// Verifie que l'utilisateur a autorise Git pour cette racine ; avec `grant`, l'autorise (l'interface ne le demande qu'apres l'accord explicite
/// de l'utilisateur dans sa boite de dialogue).
fn ensure_git_trust(config: &ConfigStore, root_id: &str, grant: bool) -> Result<(), GitError> {
    let mut roots = trusted_git_roots(config);
    if roots.iter().any(|known| known == root_id) {
        return Ok(());
    }
    if !grant {
        return Err(GitError::NotTrusted);
    }
    if roots.len() >= MAX_GIT_TRUSTED {
        roots.remove(0);
    }
    roots.push(root_id.to_string());
    config.write(GIT_TRUST_DOC, &json!({ "roots": roots }).to_string()).map_err(|_| GitError::Failed)
}

/// Comme `blocking`, pour Git : un seul `git` a la fois (une page qui inonderait la commande ne lancerait pas des dizaines de processus).
async fn git_blocking<T, F>(state: AppState, task: F) -> Result<T, GitError>
where
    T: Send + 'static,
    F: FnOnce(&AppState) -> Result<T, GitError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(move || {
        let _one_at_a_time = state.git.lock().unwrap_or_else(PoisonError::into_inner);
        task(&state)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => Err(GitError::Failed),
    }
}

/// Etat Git du projet : branche, `HEAD`, fichiers modifies, ajoutes, supprimes ou non suivis (lecture seule). `grant_trust` : l'utilisateur
/// vient d'autoriser Git pour ce projet ; sinon, un projet non autorise est refuse (`not_trusted`).
#[tauri::command]
pub async fn git_status(root_id: String, grant_trust: bool, state: State<'_, AppState>) -> Result<GitStatus, GitError> {
    git_blocking(state.inner().clone(), move |app| {
        let root = app.roots.get(&root_id)?;
        ensure_git_trust(&app.config, &root.id, grant_trust)?;
        runeforge_git::status(&root.path)
    })
    .await
}

/// Contenu, dans `HEAD`, d'un fichier du projet (une trame binaire, comme `history_read`). `not_in_head` : fichier neuf.
#[tauri::command]
pub async fn git_head_file(root_id: String, path: String, state: State<'_, AppState>) -> Result<Response, GitError> {
    git_blocking(state.inner().clone(), move |app| {
        let root = app.roots.get(&root_id)?;
        ensure_git_trust(&app.config, &root.id, false)?;
        let data = runeforge_git::head_file(&root.path, &path)?;
        Ok(Response::new(frames::encode(&[Frame { meta: json!({ "path": path, "ok": true }), data }])))
    })
    .await
}

/// L'interface signale la presence de modifications non enregistrees : la fermeture de la fenetre est alors differee.
#[tauri::command]
pub fn set_dirty(dirty: bool, state: State<'_, AppState>) {
    state.dirty.store(dirty, Ordering::SeqCst);
}

/// Ferme l'application (apres confirmation de l'utilisateur dans l'interface).
#[tauri::command]
pub fn confirm_exit(app: AppHandle) {
    app.exit(0);
}

/// Projet pre-approuve par une construction de test E2E. Toujours `None` dans une version distribuee.
#[tauri::command]
pub fn e2e_project(state: State<'_, AppState>) -> Option<ApprovedRoot> {
    state.e2e_project.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

/// Construction de test uniquement : approuve le dossier designe par `RUNEFORGE_E2E_PROJECT`.
#[cfg(feature = "e2e")]
pub fn preapprove_e2e_project(state: &AppState) {
    if let Ok(path) = std::env::var("RUNEFORGE_E2E_PROJECT") {
        if let Ok(root) = state.roots.approve(Path::new(&path)) {
            *state.e2e_project.lock().unwrap_or_else(PoisonError::into_inner) = Some(root);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_names::COMMANDS;

    #[test]
    fn config_names_are_whitelisted() {
        assert!(check_config_name("settings").is_ok());
        assert!(check_config_name("recent-projects").is_err());
        assert!(check_config_name("../settings").is_err());
    }

    #[test]
    fn logging_is_off_unless_the_user_turned_it_on() {
        let dir = tempfile::tempdir().unwrap();
        let config = ConfigStore::new(dir.path());
        assert!(!logging_enabled(&config), "document absent");
        config.write("settings", r#"{"logging":{"enabled":true}}"#).unwrap();
        assert!(logging_enabled(&config));
        for off in [r#"{"logging":{"enabled":false}}"#, r#"{"logging":{"enabled":"true"}}"#, r#"{"logging":{}}"#, r#"{"logging":null}"#, r#"{}"#, r#"[]"#, r#"42"#] {
            config.write("settings", off).unwrap();
            assert!(!logging_enabled(&config), "{off}");
        }
    }

    #[test]
    fn log_event_writes_only_with_the_users_consent_and_only_valid_entries() {
        let dir = tempfile::tempdir().unwrap();
        let config = ConfigStore::new(dir.path().join("config"));
        let logs = dir.path().join("logs");
        let log = DiagnosticLog::new(&logs);

        // Sans accord : rien n'est ecrit, et une entree invalide ne produit pas d'erreur (pas de sondage du reglage).
        let indexed = "files=1 functions=0 npcs=0 ms=12";
        assert!(!log_if_enabled(&config, &log, "info", "INDEX_DONE", indexed).unwrap());
        assert!(!log_if_enabled(&config, &log, "bogus", "not a code", "C:\\secret").unwrap());
        assert!(!logs.exists());

        config.write("settings", r#"{"logging":{"enabled":true}}"#).unwrap();
        assert!(log_if_enabled(&config, &log, "info", "INDEX_DONE", indexed).unwrap());
        assert!(log_if_enabled(&config, &log, "bogus", "INDEX_DONE", indexed).is_err());
        assert!(log_if_enabled(&config, &log, "info", "PRIVATE_TOKEN", "").is_err());
        assert!(log_if_enabled(&config, &log, "error", "UI_ERROR", "name=F_PrivateNpc").is_err());
        let written = std::fs::read_to_string(logs.join("runeforge.log")).unwrap();
        assert_eq!(written.lines().count(), 1);
        assert!(written.ends_with(&format!(" INFO INDEX_DONE {indexed}\n")), "{written:?}");

        // Le reglage est relu a chaque evenement : desactiver coupe le journal immediatement.
        config.write("settings", r#"{"logging":{"enabled":false}}"#).unwrap();
        assert!(!log_if_enabled(&config, &log, "info", "INDEX_DONE", indexed).unwrap());
        assert_eq!(std::fs::read_to_string(logs.join("runeforge.log")).unwrap().lines().count(), 1);
    }

    #[test]
    fn git_is_refused_until_the_user_grants_it_for_that_project() {
        let dir = tempfile::tempdir().unwrap();
        let config = ConfigStore::new(dir.path());
        assert_eq!(ensure_git_trust(&config, "aaaa", false), Err(GitError::NotTrusted));
        // Refuser n'ecrit rien.
        assert_eq!(config.read(GIT_TRUST_DOC).unwrap(), None);
        assert_eq!(ensure_git_trust(&config, "aaaa", true), Ok(()));
        // L'accord est retenu pour ce projet, et pour lui seul.
        assert_eq!(ensure_git_trust(&config, "aaaa", false), Ok(()));
        assert_eq!(ensure_git_trust(&config, "bbbb", false), Err(GitError::NotTrusted));
        assert_eq!(ensure_git_trust(&config, "bbbb", true), Ok(()));
        assert_eq!(trusted_git_roots(&config), vec!["aaaa".to_string(), "bbbb".to_string()]);
        // Accorder deux fois ne duplique pas.
        assert_eq!(ensure_git_trust(&config, "aaaa", true), Ok(()));
        assert_eq!(trusted_git_roots(&config).len(), 2);
    }

    #[test]
    fn the_git_trust_document_is_out_of_reach_of_the_page() {
        // La page lit et ecrit des documents de configuration par leur nom, en liste blanche : celui-ci n'en fait pas partie.
        assert!(check_config_name(GIT_TRUST_DOC).is_err());
        assert!(!CONFIG_NAMES.contains(&GIT_TRUST_DOC));
    }

    #[test]
    fn a_damaged_trust_document_trusts_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let config = ConfigStore::new(dir.path());
        for damaged in [r#"{"roots":5}"#, r#"{"roots":"aaaa"}"#, r#"{"roots":[1,2]}"#, r#"{}"#, r#"[]"#, r#"null"#] {
            config.write(GIT_TRUST_DOC, damaged).unwrap();
            assert_eq!(ensure_git_trust(&config, "aaaa", false), Err(GitError::NotTrusted), "{damaged}");
        }
    }

    #[test]
    fn the_git_trust_list_is_bounded_and_forgets_the_oldest_project() {
        let dir = tempfile::tempdir().unwrap();
        let config = ConfigStore::new(dir.path());
        for index in 0..=MAX_GIT_TRUSTED {
            ensure_git_trust(&config, &format!("root{index}"), true).unwrap();
        }
        let roots = trusted_git_roots(&config);
        assert_eq!(roots.len(), MAX_GIT_TRUSTED);
        assert_eq!(roots.first().map(String::as_str), Some("root1"));
        assert_eq!(roots.last().map(String::as_str), Some(format!("root{MAX_GIT_TRUSTED}").as_str()));
        assert_eq!(ensure_git_trust(&config, "root0", false), Err(GitError::NotTrusted));
    }

    #[test]
    fn capability_matches_command_list() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).expect("capability is valid JSON");
        let mut granted: Vec<String> = capability["permissions"]
            .as_array()
            .expect("permissions array")
            .iter()
            .filter_map(|value| value.as_str())
            .filter_map(|value| value.strip_prefix("allow-"))
            .map(str::to_string)
            .collect();
        granted.sort();
        let mut expected: Vec<String> = COMMANDS.iter().map(|name| name.replace('_', "-")).collect();
        expected.sort();
        assert_eq!(granted, expected, "capabilities/default.json et command_names.rs doivent lister les memes commandes");
    }

    #[test]
    fn error_frames_carry_the_structured_error() {
        let frame = frame_for_error("a.txt", &FsError::NotFound);
        assert_eq!(frame.meta["ok"], false);
        assert_eq!(frame.meta["error"]["code"], "not_found");
        assert!(frame.data.is_empty());
    }
}
