//! Remplacer l'executable en cours d'execution, avec retour arriere.
//!
//! Le nouvel executable est toujours telecharge a cote de l'ancien (`<nom>.download`, meme dossier, donc meme volume et memes droits).
//! Le remplacement depend ensuite du systeme :
//!
//! **Windows** interdit d'ecraser ou de supprimer un executable qui tourne, mais autorise a le **renommer** :
//! 1. l'ancien est renomme `<nom>.old`, le nouveau prend le nom de l'ancien (`<nom>.new` puis `<nom>`) ;
//! 2. si l'une de ces etapes echoue, l'ancien est remis en place ; sinon l'application redemarre sur le nouveau.
//!
//! **Linux** (et les autres Unix) remplace un fichier par un renommage **atomique**, meme si c'est l'executable en cours d'execution : le
//! processus garde l'ancien fichier ouvert, et le chemin ne manque jamais. Les droits de l'ancienne version (dont le bit d'execution, que
//! GitHub ne conserve pas) passent au nouveau fichier ; l'ancienne version reste a cote sous `<nom>.old` (lien dur, ou copie), de quoi
//! revenir en arriere a la main si la nouvelle ne demarre pas.
//!
//! Au demarrage suivant, `cleanup_leftovers` supprime `<nom>.old` (ou ce qu'une tentative interrompue a laisse) : seule une nouvelle version
//! qui a demarre le fait, donc une version cassee laisse l'ancienne a portee.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use crate::error::UpdateError;

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|name| name.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

pub fn download_path(current_exe: &Path) -> PathBuf {
    with_suffix(current_exe, ".download")
}

pub fn staged_path(current_exe: &Path) -> PathBuf {
    with_suffix(current_exe, ".new")
}

pub fn backup_path(current_exe: &Path) -> PathBuf {
    with_suffix(current_exe, ".old")
}

/// Cree le fichier de telechargement a cote de l'executable : un dossier non modifiable echoue ici (`NotWritable`), avant de
/// telecharger quoi que ce soit.
pub fn create_download_file(current_exe: &Path) -> Result<(File, PathBuf), UpdateError> {
    let path = download_path(current_exe);
    let file = OpenOptions::new().write(true).create(true).truncate(true).open(&path)?;
    Ok((file, path))
}

/// Nombre d'essais d'un renommage et pause entre deux essais : un antivirus ouvre souvent, un instant, un executable qui vient d'etre ecrit.
const RENAME_ATTEMPTS: u32 = 6;
const RENAME_PAUSE: Duration = Duration::from_millis(250);

/// Refait `operation` jusqu'a `attempts` fois en tout, avec `pause` entre deux essais ; l'erreur du dernier essai est rendue.
fn retrying(attempts: u32, pause: Duration, mut operation: impl FnMut() -> io::Result<()>) -> io::Result<()> {
    let mut attempt = 1;
    loop {
        match operation() {
            Ok(()) => return Ok(()),
            Err(error) if attempt >= attempts => return Err(error),
            Err(_) => {
                attempt += 1;
                thread::sleep(pause);
            }
        }
    }
}

fn rename_with_retries(from: &Path, to: &Path) -> io::Result<()> {
    retrying(RENAME_ATTEMPTS, RENAME_PAUSE, || fs::rename(from, to))
}

/// Remplace `current_exe` par le fichier `downloaded` (du meme dossier), de la facon que permet le systeme (voir l'en-tete du module).
pub fn apply(current_exe: &Path, downloaded: &Path) -> Result<(), UpdateError> {
    if cfg!(windows) {
        apply_with(current_exe, downloaded, rename_with_retries)
    } else {
        apply_atomic_with(current_exe, downloaded, |from, to| fs::hard_link(from, to), rename_with_retries)
    }
}

/// Unix : le renommage de `downloaded` sur `current_exe` est l'unique etape qui change quelque chose, et elle est atomique. `link` fait
/// la sauvegarde (un lien dur ; une copie si le systeme de fichiers n'en admet pas) et `rename` le remplacement : les tests y font echouer
/// une etape. Compile et est teste sur tous les systemes ; `apply` ne l'emploie que hors de Windows.
fn apply_atomic_with(
    current_exe: &Path,
    downloaded: &Path,
    mut link: impl FnMut(&Path, &Path) -> io::Result<()>,
    mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<(), UpdateError> {
    let backup = backup_path(current_exe);
    let failed = |reason: &str| UpdateError::InstallFailed { reason: reason.to_string() };

    // Le fichier telecharge a ete cree comme un fichier ordinaire : il prend les droits de l'ancienne version, bit d'execution compris.
    let permissions = fs::metadata(current_exe).and_then(|metadata| fs::set_permissions(downloaded, metadata.permissions()));
    if permissions.is_err() {
        let _ = fs::remove_file(downloaded);
        return Err(failed("permissions"));
    }

    // Restes d'une tentative precedente, puis l'ancienne version mise a cote : l'executable en place n'est ni deplace ni modifie.
    let _ = fs::remove_file(&backup);
    if link(current_exe, &backup).is_err() && fs::copy(current_exe, &backup).is_err() {
        let _ = fs::remove_file(&backup);
        let _ = fs::remove_file(downloaded);
        return Err(failed("backup"));
    }

    if rename(downloaded, current_exe).is_err() {
        // L'ancienne version n'a pas bouge : la sauvegarde ne sert a rien.
        let _ = fs::remove_file(downloaded);
        let _ = fs::remove_file(&backup);
        return Err(failed("replace"));
    }
    Ok(())
}

/// Windows : `apply` avec l'operation de renommage en parametre : les tests y font echouer une etape pour verifier le retour arriere.
fn apply_with(current_exe: &Path, downloaded: &Path, mut rename: impl FnMut(&Path, &Path) -> io::Result<()>) -> Result<(), UpdateError> {
    let staged = staged_path(current_exe);
    let backup = backup_path(current_exe);
    let failed = |reason: &str| UpdateError::InstallFailed { reason: reason.to_string() };

    // Restes d'une tentative precedente.
    let _ = fs::remove_file(&staged);
    if backup.exists() && fs::remove_file(&backup).is_err() {
        let _ = fs::remove_file(downloaded);
        return Err(failed("backup_in_use"));
    }

    if rename(downloaded, &staged).is_err() {
        let _ = fs::remove_file(downloaded);
        return Err(failed("stage"));
    }
    if rename(current_exe, &backup).is_err() {
        let _ = fs::remove_file(&staged);
        return Err(failed("backup"));
    }
    if rename(&staged, current_exe).is_err() {
        // Retour arriere : l'ancienne version reprend sa place.
        let restored = fs::rename(&backup, current_exe).is_ok();
        let _ = fs::remove_file(&staged);
        return Err(failed(if restored { "replace_rolled_back" } else { "replace_kept_backup" }));
    }
    Ok(())
}

/// Au demarrage : supprime ce qu'une mise a jour a laisse (`.old`) ou qu'une mise a jour interrompue n'a pas termine (`.new`, `.download`).
/// Au mieux : un fichier encore verrouille (l'ancien processus quitte) sera supprime au demarrage suivant.
pub fn cleanup_leftovers(current_exe: &Path) {
    for path in [backup_path(current_exe), staged_path(current_exe), download_path(current_exe)] {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("runeforge-studio.exe");
        fs::write(&exe, b"MZ old version").unwrap();
        (dir, exe)
    }

    fn download(exe: &Path, content: &[u8]) -> PathBuf {
        let (mut file, path) = create_download_file(exe).unwrap();
        io::Write::write_all(&mut file, content).unwrap();
        path
    }

    #[test]
    fn temporary_files_live_next_to_the_executable() {
        let exe = Path::new("C:/apps/runeforge-studio.exe");
        assert_eq!(download_path(exe), Path::new("C:/apps/runeforge-studio.exe.download"));
        assert_eq!(staged_path(exe), Path::new("C:/apps/runeforge-studio.exe.new"));
        assert_eq!(backup_path(exe), Path::new("C:/apps/runeforge-studio.exe.old"));
    }

    #[test]
    fn replaces_the_executable_and_keeps_the_previous_one_aside() {
        let (dir, exe) = setup();
        let downloaded = download(&exe, b"MZ new version");
        apply(&exe, &downloaded).unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"MZ new version");
        assert_eq!(fs::read(backup_path(&exe)).unwrap(), b"MZ old version");
        assert!(!downloaded.exists() && !staged_path(&exe).exists());
        let mut names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["runeforge-studio.exe", "runeforge-studio.exe.old"]);
    }

    #[test]
    fn a_stale_backup_from_a_previous_update_is_replaced() {
        let (_dir, exe) = setup();
        fs::write(backup_path(&exe), b"MZ ancient").unwrap();
        let downloaded = download(&exe, b"MZ new version");
        apply(&exe, &downloaded).unwrap();
        assert_eq!(fs::read(backup_path(&exe)).unwrap(), b"MZ old version");
    }

    #[test]
    fn puts_the_old_version_back_when_the_last_step_fails() {
        let (_dir, exe) = setup();
        let downloaded = download(&exe, b"MZ new version");
        let mut calls = 0;
        let result = apply_with(&exe, &downloaded, |from, to| {
            calls += 1;
            if calls == 3 {
                Err(io::Error::other("simulated sharing violation"))
            } else {
                fs::rename(from, to)
            }
        });
        assert_eq!(result, Err(UpdateError::InstallFailed { reason: "replace_rolled_back".into() }));
        assert_eq!(fs::read(&exe).unwrap(), b"MZ old version", "the application is untouched");
        assert!(!staged_path(&exe).exists() && !backup_path(&exe).exists() && !downloaded.exists());
    }

    #[test]
    fn leaves_the_application_untouched_when_the_first_steps_fail() {
        for failing_call in [1, 2] {
            let (_dir, exe) = setup();
            let downloaded = download(&exe, b"MZ new version");
            let mut calls = 0;
            let result = apply_with(&exe, &downloaded, |from, to| {
                calls += 1;
                if calls == failing_call {
                    Err(io::Error::other("simulated"))
                } else {
                    fs::rename(from, to)
                }
            });
            assert!(matches!(result, Err(UpdateError::InstallFailed { .. })), "call {failing_call}");
            assert_eq!(fs::read(&exe).unwrap(), b"MZ old version");
            assert!(!staged_path(&exe).exists() && !downloaded.exists());
        }
    }

    #[test]
    fn startup_cleanup_removes_what_an_update_left_behind() {
        let (_dir, exe) = setup();
        for path in [backup_path(&exe), staged_path(&exe), download_path(&exe)] {
            fs::write(path, b"left over").unwrap();
        }
        cleanup_leftovers(&exe);
        assert!(!backup_path(&exe).exists() && !staged_path(&exe).exists() && !download_path(&exe).exists());
        assert_eq!(fs::read(&exe).unwrap(), b"MZ old version");
        cleanup_leftovers(&exe);
    }

    #[test]
    fn a_step_that_is_briefly_locked_is_retried_and_a_lasting_failure_is_reported_after_the_last_attempt() {
        let mut calls = 0;
        assert!(retrying(6, Duration::ZERO, || {
            calls += 1;
            if calls < 3 { Err(io::Error::other("antivirus scan")) } else { Ok(()) }
        })
        .is_ok());
        assert_eq!(calls, 3);

        let mut calls = 0;
        let result = retrying(6, Duration::ZERO, || {
            calls += 1;
            Err(io::Error::other(format!("attempt {calls}")))
        });
        assert_eq!(calls, 6);
        assert_eq!(result.unwrap_err().to_string(), "attempt 6");

        let (_dir, exe) = setup();
        let downloaded = download(&exe, b"MZ new version");
        // `apply` retries real renames too: with nothing locked it succeeds at the first attempt.
        apply(&exe, &downloaded).unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"MZ new version");
    }

    fn atomic(exe: &Path, downloaded: &Path) -> Result<(), UpdateError> {
        apply_atomic_with(exe, downloaded, |from, to| fs::hard_link(from, to), |from, to| fs::rename(from, to))
    }

    #[test]
    fn the_atomic_replacement_swaps_the_file_in_one_rename_and_keeps_the_previous_version_aside() {
        let (dir, exe) = setup();
        let downloaded = download(&exe, b"MZ new version");
        let mut intact_at_the_swap = false;
        let result = apply_atomic_with(
            &exe,
            &downloaded,
            |from, to| fs::hard_link(from, to),
            |from, to| {
                // Au moment du remplacement l'executable est encore a sa place, intact : le chemin ne manque jamais.
                intact_at_the_swap = fs::read(&exe).is_ok_and(|bytes| bytes == b"MZ old version");
                fs::rename(from, to)
            },
        );
        assert_eq!(result, Ok(()));
        assert!(intact_at_the_swap, "the old executable stays in place until the single swapping rename");
        assert_eq!(fs::read(&exe).unwrap(), b"MZ new version");
        assert_eq!(fs::read(backup_path(&exe)).unwrap(), b"MZ old version");
        let mut names: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["runeforge-studio.exe", "runeforge-studio.exe.old"]);
    }

    #[test]
    fn a_filesystem_without_hard_links_gets_a_copy_as_the_backup() {
        let (_dir, exe) = setup();
        let downloaded = download(&exe, b"MZ new version");
        let result = apply_atomic_with(&exe, &downloaded, |_, _| Err(io::Error::other("hard links are not supported")), |from, to| fs::rename(from, to));
        assert_eq!(result, Ok(()));
        assert_eq!(fs::read(&exe).unwrap(), b"MZ new version");
        assert_eq!(fs::read(backup_path(&exe)).unwrap(), b"MZ old version");
    }

    #[test]
    fn a_stale_backup_is_replaced_by_the_version_being_replaced() {
        let (_dir, exe) = setup();
        fs::write(backup_path(&exe), b"MZ ancient").unwrap();
        let downloaded = download(&exe, b"MZ new version");
        atomic(&exe, &downloaded).unwrap();
        assert_eq!(fs::read(backup_path(&exe)).unwrap(), b"MZ old version");
    }

    #[cfg(unix)]
    #[test]
    fn a_backup_left_by_an_interrupted_attempt_as_a_link_to_the_current_file_never_damages_it() {
        // Une tentative interrompue entre le lien et le renommage laisse `.old` lie au MEME fichier que l'executable : si la sauvegarde
        // perimee n'etait pas retiree avant d'etre refaite, la copie de secours ecrirait « par-dessus » l'application elle-meme.
        let (_dir, exe) = setup();
        fs::hard_link(&exe, backup_path(&exe)).unwrap();
        let downloaded = download(&exe, b"MZ new version");
        atomic(&exe, &downloaded).unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"MZ new version");
        assert_eq!(fs::read(backup_path(&exe)).unwrap(), b"MZ old version", "the previous version is intact, not truncated through the old link");
    }

    #[test]
    fn the_application_is_untouched_when_no_backup_can_be_made_or_the_swap_fails() {
        // Un dossier occupe le nom de la sauvegarde : ni lien ni copie.
        let (_dir, exe) = setup();
        fs::create_dir(backup_path(&exe)).unwrap();
        fs::write(backup_path(&exe).join("occupied"), b"x").unwrap();
        let downloaded = download(&exe, b"MZ new version");
        assert_eq!(atomic(&exe, &downloaded), Err(UpdateError::InstallFailed { reason: "backup".into() }));
        assert_eq!(fs::read(&exe).unwrap(), b"MZ old version");
        assert!(!downloaded.exists());

        // Le remplacement lui-meme echoue : l'ancienne version n'a pas bouge et ne laisse pas de sauvegarde inutile.
        let (_dir, exe) = setup();
        let downloaded = download(&exe, b"MZ new version");
        let result = apply_atomic_with(&exe, &downloaded, |from, to| fs::hard_link(from, to), |_, _| Err(io::Error::other("simulated")));
        assert_eq!(result, Err(UpdateError::InstallFailed { reason: "replace".into() }));
        assert_eq!(fs::read(&exe).unwrap(), b"MZ old version");
        assert!(!downloaded.exists() && !backup_path(&exe).exists());
    }

    #[test]
    fn nothing_is_replaced_when_the_current_executable_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("missing.exe");
        let downloaded = download(&exe, b"MZ new version");
        assert_eq!(atomic(&exe, &downloaded), Err(UpdateError::InstallFailed { reason: "permissions".into() }));
        assert!(!downloaded.exists() && !exe.exists() && !backup_path(&exe).exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_new_file_takes_the_permissions_of_the_old_one_including_the_execute_bit() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, exe) = setup();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o750)).unwrap();
        let downloaded = download(&exe, b"\x7fELF new version");
        // Le fichier telecharge est cree sans bit d'execution : GitHub n'en conserve aucun.
        assert_eq!(fs::metadata(&downloaded).unwrap().permissions().mode() & 0o111, 0);
        apply(&exe, &downloaded).unwrap();
        assert_eq!(fs::metadata(&exe).unwrap().permissions().mode() & 0o777, 0o750);
        assert_eq!(fs::metadata(backup_path(&exe)).unwrap().permissions().mode() & 0o777, 0o750);
    }

    #[test]
    fn a_folder_that_cannot_be_written_fails_before_any_download() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("missing-dir").join("runeforge-studio.exe");
        assert!(create_download_file(&exe).is_err());
    }
}
