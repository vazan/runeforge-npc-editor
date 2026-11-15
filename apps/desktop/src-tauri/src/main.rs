// Evite la fenetre console supplementaire sous Windows en build release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_state;
// Utilise par build.rs (via include!) et par les tests de coherence ; inutile au binaire lui-meme.
#[cfg(test)]
mod command_names;
mod commands;
mod frames;
mod headers;
mod recents;
mod sftp;
mod update;

use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

/// Evenement emis vers l'interface quand l'utilisateur ferme la fenetre alors que des modifications ne sont pas enregistrees.
const CLOSE_REQUESTED_EVENT: &str = "runeforge://close-requested";

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Une mise a jour precedente laisse l'ancien executable a cote du nouveau : on le supprime au demarrage suivant.
            update::cleanup_after_update(&app.env());
            let config_dir = app.path().app_config_dir()?;
            let data_dir = app.path().app_local_data_dir()?;
            // Construction de test uniquement : dossier de donnees isole (aucun effet sur le profil de l'utilisateur).
            #[cfg(feature = "e2e")]
            let (config_dir, data_dir) = match std::env::var_os("RUNEFORGE_E2E_DATA_DIR") {
                Some(base) => {
                    let base = std::path::PathBuf::from(base);
                    (base.join("config"), base.join("data"))
                }
                None => (config_dir, data_dir),
            };
            let state = app_state::AppState::new(config_dir, data_dir);
            #[cfg(feature = "e2e")]
            commands::preapprove_e2e_project(&state);
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let dirty = window.state::<app_state::AppState>().dirty.load(Ordering::SeqCst);
                if dirty {
                    api.prevent_close();
                    let _ = window.emit(CLOSE_REQUESTED_EVENT, ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::pick_project_folder,
            commands::pick_destination_folder,
            commands::list_recent_projects,
            commands::open_recent_project,
            commands::forget_recent_project,
            commands::scan_project,
            commands::read_files,
            commands::write_file,
            commands::create_directory,
            commands::recovery_save,
            commands::recovery_list,
            commands::recovery_read,
            commands::recovery_clear,
            commands::history_list,
            commands::history_read,
            commands::config_get,
            commands::config_set,
            commands::set_dirty,
            commands::confirm_exit,
            commands::e2e_project,
            commands::log_event,
            commands::git_status,
            commands::git_head_file,
            sftp::sftp_dry_run,
            update::update_check,
            update::update_install,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("RuneForge Studio n'a pas pu demarrer : {error}");
        std::process::exit(1);
    }
}
