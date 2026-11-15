use std::sync::Mutex;

use runeforge_remote_transport::{self as transport, Error, Preview, Target, TargetInput};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::app_state::AppState;

static ACTIVE: Mutex<()> = Mutex::new(());

#[tauri::command]
pub async fn sftp_dry_run(
    app: AppHandle,
    state: State<'_, AppState>,
    root_id: String,
    target: TargetInput,
    paths: Vec<String>,
    locale: Option<String>,
) -> Result<Preview, Error> {
    let target = Target::parse(target)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _active = ACTIVE.try_lock().map_err(|_| Error::Busy)?;
        let (title, intro) = if locale.as_deref() == Some("fr") {
            ("Comparer par SFTP", "Autoriser la lecture SFTP de cette destination ? Aucun fichier ne sera transféré vers le serveur.")
        } else {
            ("Compare over SFTP", "Allow a read-only SFTP connection to this destination? No files will be uploaded.")
        };
        let confirmed = app
            .dialog()
            .message(format!("{intro}\n\n{}", target.confirmation()))
            .title(title)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if !confirmed {
            return Err(Error::Cancelled);
        }
        transport::preview(target, &state.roots, &root_id, paths)
    })
    .await
    .map_err(|_| Error::Unavailable)?
}
