/// Liste unique des commandes IPC exposees au frontend.
///
/// Elle sert a la fois au manifeste de permissions (`build.rs`, qui genere les permissions `allow-<nom>`)
/// et a la verification de coherence avec `capabilities/default.json` (test `capability_matches_command_list`).
/// Toute commande ajoutee doit apparaitre ici, dans `generate_handler!` et dans la capability.
pub const COMMANDS: &[&str] = &[
    "app_info",
    "pick_project_folder",
    "pick_destination_folder",
    "list_recent_projects",
    "open_recent_project",
    "forget_recent_project",
    "scan_project",
    "read_files",
    "write_file",
    "create_directory",
    "recovery_save",
    "recovery_list",
    "recovery_read",
    "recovery_clear",
    "history_list",
    "history_read",
    "config_get",
    "config_set",
    "set_dirty",
    "confirm_exit",
    "e2e_project",
    "log_event",
    "git_status",
    "git_head_file",
    "sftp_dry_run",
    "update_check",
    "update_install",
];
