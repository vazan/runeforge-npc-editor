//! Lancement de `git` : sans shell, sans heritage de l'environnement, borne en temps et en taille.

use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use crate::{GitError, Result};

/// Delai maximal d'une commande ; au-dela, `git` est tue.
const TIMEOUT: Duration = Duration::from_secs(15);
/// Part de `stderr` conservee (elle ne sert qu'a reconnaitre la nature d'un echec).
const MAX_STDERR_BYTES: usize = 64 * 1024;
/// Temps laisse aux lecteurs des tubes pour finir apres la fin du processus (un descendant qui les garde ouverts ne doit pas nous bloquer).
const READER_GRACE: Duration = Duration::from_secs(2);

/// Variables heritees du processus parent : de quoi trouver `git`, sa configuration globale (`safe.directory`, `core.autocrlf`...)
/// et un dossier temporaire. Rien d'autre : en particulier aucune variable `GIT_*`.
const INHERITED_ENV: [&str; 18] = [
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SystemRoot",
    "SYSTEMROOT",
    "windir",
    "USERPROFILE",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_CONFIG_HOME",
];

/// Variables imposees. `LC_ALL=C` : messages d'erreur en anglais, que `failure` sait reconnaitre. `GIT_NO_LAZY_FETCH=1` : dans un clone partiel
/// (`--filter=blob:none`), un objet absent n'est pas telecharge en cachette depuis le depot distant — aucune lecture ne doit ouvrir le reseau.
pub(crate) const FORCED_ENV: [(&str, &str); 5] =
    [("GIT_TERMINAL_PROMPT", "0"), ("GIT_OPTIONAL_LOCKS", "0"), ("GIT_PAGER", "cat"), ("LC_ALL", "C"), ("GIT_NO_LAZY_FETCH", "1")];

/// Options placees avant la commande : pas de verrou ni de reecriture de l'index, pas de programme de surveillance du depot, aucun transport
/// reseau (ni fichier : meme pour un clone partiel), chemins non echappes (`rev-parse --show-prefix` imprime le dossier du projet tel quel).
pub(crate) const SAFE_OPTIONS: [&str; 10] = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.quotePath=false",
    "-c",
    "protocol.allow=never",
    "--no-pager",
    "-c",
    "core.pager=cat",
];

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// L'environnement du processus fils : parmi `parent`, les seules variables de `INHERITED_ENV` (les noms Windows ne distinguent pas la
/// casse), puis celles qu'on impose, qui l'emportent. Fonction pure : testee avec un environnement parent factice.
pub(crate) fn child_env(parent: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = parent
        .into_iter()
        .filter(|(name, _)| INHERITED_ENV.iter().any(|allowed| name.to_str().is_some_and(|name| name.eq_ignore_ascii_case(allowed))))
        .collect();
    // Aucune variable imposee n'est dans la liste blanche : `Command::envs` garderait de toute facon la derniere en cas de doublon.
    env.extend(FORCED_ENV.iter().map(|(name, value)| (OsString::from(name), OsString::from(value))));
    env
}

pub(crate) struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    /// Debut de `stderr`, tel quel : pour reconnaitre la nature d'un echec, jamais pour l'afficher.
    pub stderr: String,
}

/// Lit `reader` jusqu'a sa fin ou jusqu'a `limit` octets ; au-dela, `exceeded` passe a vrai et la lecture s'arrete.
fn read_limited<R: Read>(mut reader: R, limit: usize, exceeded: &AtomicBool) -> Vec<u8> {
    let mut data = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(count) => {
                if data.len() + count > limit {
                    exceeded.store(true, Ordering::SeqCst);
                    break;
                }
                data.extend_from_slice(&buffer[..count]);
            }
        }
    }
    data
}

/// Lance `git <options sures> <args>` dans `cwd` et rend sa sortie, ou `Timeout` / `TooLarge` / `GitUnavailable`.
/// `max_stdout` : taille maximale de la sortie standard.
pub(crate) fn run(args: &[&str], cwd: &Path, max_stdout: usize) -> Result<Output> {
    run_program("git", &SAFE_OPTIONS, args, cwd, max_stdout, TIMEOUT)
}

/// Comme `run`, pour n'importe quel programme et avec un delai donne (les tests y mettent un programme qui bavarde ou qui dort).
pub(crate) fn run_program(program: &str, options: &[&str], args: &[&str], cwd: &Path, max_stdout: usize, timeout: Duration) -> Result<Output> {
    let mut command = Command::new(program);
    command.args(options).args(args).current_dir(cwd).env_clear().stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.envs(child_env(std::env::vars_os()));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| GitError::GitUnavailable)?;
    let stdout = child.stdout.take().ok_or(GitError::Failed)?;
    let stderr = child.stderr.take().ok_or(GitError::Failed)?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout_flag = Arc::clone(&exceeded);
    let (stdout_sender, stdout_receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = stdout_sender.send(read_limited(stdout, max_stdout, &stdout_flag));
    });
    let stderr_flag = Arc::new(AtomicBool::new(false));
    let (stderr_sender, stderr_receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = stderr_sender.send(read_limited(stderr, MAX_STDERR_BYTES, &stderr_flag));
    });

    let started = Instant::now();
    let mut outcome: Result<bool> = Err(GitError::Failed);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                outcome = Ok(status.success());
                break;
            }
            Ok(None) => {}
            Err(_) => break,
        }
        if exceeded.load(Ordering::SeqCst) {
            outcome = Err(GitError::TooLarge);
            break;
        }
        if started.elapsed() >= timeout {
            outcome = Err(GitError::Timeout);
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    if outcome.is_err() {
        // Delai ou taille depasses : on ne laisse pas `git` tourner.
        let _ = child.kill();
        let _ = child.wait();
    }
    // Les lecteurs finissent quand les tubes se ferment, c'est-a-dire a la mort du processus... et de ses eventuels descendants, qui
    // peuvent les garder ouverts : on n'attend donc qu'un instant (les fils restes en route s'arretent d'eux-memes).
    let success = outcome?;
    let stdout = stdout_receiver.recv_timeout(READER_GRACE).map_err(|_| GitError::Timeout)?;
    let stderr = stderr_receiver.recv_timeout(READER_GRACE).map_err(|_| GitError::Timeout)?;
    if exceeded.load(Ordering::SeqCst) {
        return Err(GitError::TooLarge);
    }
    Ok(Output { success, stdout, stderr: String::from_utf8_lossy(&stderr).into_owned() })
}
