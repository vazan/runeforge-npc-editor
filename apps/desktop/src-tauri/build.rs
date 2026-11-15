include!("src/command_names.rs");

fn main() {
    // Manifeste d'application : seules les commandes listees existent comme permissions (`allow-<nom>`) ;
    // la fenetre principale ne peut appeler que celles accordees dans capabilities/default.json.
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
