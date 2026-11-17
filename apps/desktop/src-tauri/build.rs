include!("src/command_names.rs");

fn main() {
    let config: serde_json::Value = serde_json::from_str(include_str!("tauri.conf.json")).expect("tauri.conf.json invalide");
    let version = config["version"].as_str().expect("version absente de tauri.conf.json");
    println!("cargo:rustc-env=RUNEFORGE_RELEASE_VERSION={version}");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    // Manifeste d'application : seules les commandes listees existent comme permissions (`allow-<nom>`) ;
    // la fenetre principale ne peut appeler que celles accordees dans capabilities/default.json.
    let attributes = tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    if let Err(error) = tauri_build::try_build(attributes) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}
