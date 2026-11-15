//! Remplacer un executable PENDANT qu'il tourne : la mecanique dont depend toute la mise a jour, essayee pour de vrai sur le systeme qui
//! execute les tests (Windows : renommages ; Linux : remplacement atomique), sans Tauri ni interface.
//!
//! Le test se joue lui-meme : il copie l'executable de test sous le nom d'une « application », la lance, et c'est cette copie qui, tant
//! qu'elle tourne, remplace son propre fichier par une « nouvelle version » avec `install::apply`. Le test verifie ensuite le fichier, la
//! sauvegarde, que la copie a continue de tourner, et que le fichier remplace est un executable que l'on peut relancer (le redemarrage),
//! droits d'execution compris sous Linux (GitHub ne conserve aucun bit d'execution : le nouveau fichier n'en a pas avant `apply`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::Duration;

use runeforge_updater::install;

/// Dans l'environnement de la copie : le chemin du fichier qui doit la remplacer.
const REPLACEMENT_ENV: &str = "RUNEFORGE_TEST_REPLACEMENT";
/// Ce que la « nouvelle version » a de plus que l'ancienne : des octets ignores par les chargeurs de Windows et de Linux.
const MARKER: &[u8] = b"\nRUNEFORGE-NEW-VERSION-MARKER\n";
const CHILD_TEST: &str = "act_as_the_running_application";

/// Ce que fait l'« application » : elle remplace son propre fichier pendant qu'elle tourne, puis continue a tourner. Lance seulement par
/// `a_running_executable_is_replaced_and_the_new_file_can_be_started`, dans la copie (d'ou `ignore` : jamais dans une serie ordinaire).
#[test]
#[ignore = "lance par un autre test, dans une copie de ce programme"]
fn act_as_the_running_application() {
    let replacement = PathBuf::from(std::env::var_os(REPLACEMENT_ENV).expect("variable de l'environnement de la copie"));
    let me = std::env::current_exe().unwrap();
    install::apply(&me, &replacement).expect("le remplacement de l'executable en cours d'execution");
    // Le chemin porte deja la nouvelle version, et ce processus, lui, execute encore l'ancienne.
    assert!(fs::read(&me).unwrap().ends_with(MARKER));
    thread::sleep(Duration::from_millis(300));
    println!("REPLACED-WHILE-RUNNING");
}

/// Lance un programme tout juste ecrit : sous Linux, un `fork` d'un autre thread peut tenir le fichier ouvert un instant (`ETXTBSY`).
fn run(program: &Path, arguments: &[&str], replacement: Option<&Path>) -> io::Result<Output> {
    let mut attempt = 0;
    loop {
        let mut command = Command::new(program);
        command.args(arguments).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(path) = replacement {
            command.env(REPLACEMENT_ENV, path);
        }
        match command.output() {
            Err(error) if error.raw_os_error() == Some(26) && attempt < 20 => {
                attempt += 1;
                thread::sleep(Duration::from_millis(100));
            }
            other => return other,
        }
    }
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(directory).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn a_running_executable_is_replaced_and_the_new_file_can_be_started() {
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let name = if cfg!(windows) { "application.exe" } else { "application" };
    let application = directory.path().join(name);
    // La copie garde les droits d'execution de l'original (`fs::copy`).
    fs::copy(std::env::current_exe().unwrap(), &application).unwrap();
    let original = fs::read(&application).unwrap();

    // La « nouvelle version », telechargee a cote comme le fait l'application : un fichier ordinaire, sans bit d'execution sous Linux.
    let (mut file, downloaded) = install::create_download_file(&application).unwrap();
    io::Write::write_all(&mut file, &original).unwrap();
    io::Write::write_all(&mut file, MARKER).unwrap();
    file.sync_all().unwrap();
    drop(file);
    let expected: Vec<u8> = [original.as_slice(), MARKER].concat();

    // L'application tourne, et c'est elle qui se remplace.
    let output = run(&application, &["--ignored", "--exact", CHILD_TEST, "--nocapture", "--test-threads=1"], Some(&downloaded)).unwrap();
    let (stdout, stderr) = (String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "la copie a echoue\n--- stdout\n{stdout}\n--- stderr\n{stderr}");
    assert!(stdout.contains("REPLACED-WHILE-RUNNING"), "la copie a cesse de tourner apres le remplacement\n{stdout}\n{stderr}");

    // Le chemin porte la nouvelle version, l'ancienne est a cote, et rien d'autre ne traine.
    assert_eq!(fs::read(&application).unwrap(), expected);
    assert_eq!(fs::read(install::backup_path(&application)).unwrap(), original);
    assert_eq!(names(directory.path()), [name.to_string(), format!("{name}.old")]);

    // Le « redemarrage » : le nouveau fichier est un executable que l'on peut lancer (droits d'execution compris).
    let restarted = run(&application, &["--list"], None).unwrap();
    assert!(restarted.status.success(), "le nouveau fichier ne demarre pas : {}", String::from_utf8_lossy(&restarted.stderr));
    assert!(String::from_utf8_lossy(&restarted.stdout).contains(CHILD_TEST), "le nouveau fichier n'est pas le programme attendu");

    // Au demarrage suivant, l'ancienne version est supprimee.
    install::cleanup_leftovers(&application);
    assert_eq!(names(directory.path()), [name.to_string()]);
    assert_eq!(fs::read(&application).unwrap(), expected);
}

#[cfg(unix)]
#[test]
fn the_replaced_file_keeps_the_permissions_of_the_old_one() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir_in(env!("CARGO_TARGET_TMPDIR")).unwrap();
    let application = directory.path().join("application");
    fs::write(&application, b"\x7fELF old").unwrap();
    fs::set_permissions(&application, fs::Permissions::from_mode(0o750)).unwrap();
    let (mut file, downloaded) = install::create_download_file(&application).unwrap();
    io::Write::write_all(&mut file, b"\x7fELF new").unwrap();
    drop(file);
    // GitHub ne conserve aucun bit d'execution : le fichier telecharge n'en a pas.
    assert_eq!(fs::metadata(&downloaded).unwrap().permissions().mode() & 0o111, 0);
    install::apply(&application, &downloaded).unwrap();
    assert_eq!(fs::metadata(&application).unwrap().permissions().mode() & 0o777, 0o750);
    assert_eq!(fs::read(&application).unwrap(), b"\x7fELF new");
}
