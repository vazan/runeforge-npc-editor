use std::ffi::OsString;
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use tempfile::{tempdir, TempDir};

use super::*;
use crate::process::{child_env, run_program, FORCED_ENV, SAFE_OPTIONS};

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture de la sortie de `git status` (octets fabriques d'apres la documentation du format)
// ---------------------------------------------------------------------------------------------------------------------------

const OID: &str = "0123456789abcdef0123456789abcdef01234567";

fn entry(path: &str, x: char, y: char) -> GitEntry {
    GitEntry { path: path.to_string(), x, y }
}

#[test]
fn parses_branch_head_and_every_kind_of_entry() {
    let output = format!(
        "# branch.oid {OID}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0\
         1 .M N... 100644 100644 100644 aaaa bbbb npc/a.txt\0\
         1 A. N... 000000 100644 100644 0000 cccc npc/new file.txt\0\
         ? notes/todo.txt\0! build.log\0"
    );
    let status = parse_status(output.as_bytes(), "", 100);
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.head.as_deref(), Some("0123456789ab"));
    assert!(!status.detached && !status.unborn && !status.truncated);
    assert_eq!(status.entries, vec![entry("npc/a.txt", '.', 'M'), entry("npc/new file.txt", 'A', '.'), entry("notes/todo.txt", '?', '?')]);
}

#[test]
fn parses_detached_and_unborn_heads() {
    let detached = parse_status(format!("# branch.oid {OID}\0# branch.head (detached)\0").as_bytes(), "", 10);
    assert!(detached.detached);
    assert_eq!(detached.branch, None);
    assert_eq!(detached.head.as_deref(), Some("0123456789ab"));

    let unborn = parse_status(b"# branch.oid (initial)\0# branch.head main\0? a.txt\0", "", 10);
    assert!(unborn.unborn);
    assert_eq!(unborn.head, None);
    assert_eq!(unborn.branch.as_deref(), Some("main"));
    assert_eq!(unborn.entries, vec![entry("a.txt", '?', '?')]);
}

#[test]
fn makes_paths_relative_to_the_project_and_drops_entries_elsewhere_in_the_repository() {
    let output = b"1 .M N... 100644 100644 100644 a b Software/npc/a.txt\x001 .M N... 100644 100644 100644 a b Other/b.txt\0? Software/c.txt\0? Software/\x001 .M N... 100644 100644 100644 a b SoftwareX/d.txt\0";
    let status = parse_status(output, "Software/", 100);
    assert_eq!(status.entries, vec![entry("npc/a.txt", '.', 'M'), entry("c.txt", '?', '?')]);
}

#[test]
fn reads_renames_without_taking_the_original_path_for_an_entry() {
    let output = b"2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\0old.txt\0? after.txt\0u UU N... 100644 100644 100644 100644 a b c conflict.txt\0";
    let status = parse_status(output, "", 100);
    assert_eq!(status.entries, vec![entry("new.txt", 'R', '.'), entry("after.txt", '?', '?'), entry("conflict.txt", 'U', 'U')]);
}

#[test]
fn the_original_path_of_a_rename_is_never_read_as_an_entry_even_if_it_looks_like_one() {
    // Le chemin d'origine est un element a part ; un nom qui ressemble au debut d'une ligne du format ne doit rien changer.
    let output = b"2 R. N... 100644 100644 100644 aaaa bbbb R100 nouveau.txt\0? ressemble a un non suivi.txt\0? vrai.txt\0";
    assert_eq!(parse_status(output, "", 100).entries, vec![entry("nouveau.txt", 'R', '.'), entry("vrai.txt", '?', '?')]);
}

#[test]
fn keeps_spaces_and_non_ascii_characters_of_paths() {
    let output = "1 .M N... 100644 100644 100644 a b dossier avec espaces/caf\u{e9} 2.txt\0".as_bytes();
    assert_eq!(parse_status(output, "", 10).entries, vec![entry("dossier avec espaces/caf\u{e9} 2.txt", '.', 'M')]);
}

#[test]
fn truncates_at_the_limit_and_says_so() {
    let output = b"? a\0? b\0? c\0? d\0? e\0";
    let status = parse_status(output, "", 3);
    assert_eq!(status.entries.len(), 3);
    assert!(status.truncated);
    let exact = parse_status(b"? a\0? b\0? c\0", "", 3);
    assert_eq!(exact.entries.len(), 3);
    assert!(!exact.truncated);
}

#[test]
fn ignores_lines_the_format_does_not_define_and_truncated_ones() {
    let output = b"garbage\0# branch.unknown x\0z unknown\x001 .M short\0u UU too short\0? kept.txt\0";
    assert_eq!(parse_status(output, "", 10).entries, vec![entry("kept.txt", '?', '?')]);
    assert_eq!(parse_status(b"", "", 10), GitStatus::default());
    assert_eq!(parse_status(b"\0\0\0", "", 10), GitStatus::default());
}

// ---------------------------------------------------------------------------------------------------------------------------
// Nature d'un echec de git (jamais son texte)
// ---------------------------------------------------------------------------------------------------------------------------

#[test]
fn an_object_id_is_only_ever_lowercase_hexadecimal_of_the_right_length() {
    assert!(is_object_id(&"0123456789abcdef".repeat(3).chars().take(40).collect::<String>()));
    assert!(is_object_id(&"a".repeat(64)));
    for bad in ["", "abc", &"a".repeat(39), &"a".repeat(41), &"a".repeat(63), &"A".repeat(40), &"g".repeat(40), "--output=/tmp/x", &format!("{} ", "a".repeat(39)), &format!("-{}", "a".repeat(39))] {
        assert!(!is_object_id(bad), "{bad:?}");
    }
}

#[test]
fn recognises_what_failed_from_git_messages_without_keeping_them() {
    let repository = "fatal: not a git repository (or any of the parent directories): .git";
    let ownership = "fatal: detected dubious ownership in repository at 'C:/Users/autre/projet'";
    assert_eq!(failure(repository, false), GitError::NotARepository);
    assert_eq!(failure(repository, true), GitError::NotARepository);
    assert_eq!(failure(ownership, false), GitError::UnsafeRepository);
    assert_eq!(failure(&ownership.to_uppercase(), true), GitError::UnsafeRepository);
    for missing in [
        "fatal: path 'neuf.txt' exists on disk, but not in 'HEAD'",
        "fatal: path 'absent/x.txt' does not exist in 'HEAD'",
        "fatal: Not a valid object name HEAD:a.txt",
        "fatal: invalid object name 'HEAD'.",
    ] {
        assert_eq!(failure(missing, true), GitError::NotInHead, "{missing}");
        // Pour une commande qui ne cherche pas un fichier, ces messages ne veulent pas dire « absent ».
        assert_eq!(failure(missing, false), GitError::Failed, "{missing}");
    }
    // Un fichier qui est dans HEAD mais dont le contenu n'est pas local (clone partiel) n'est pas « absent ».
    assert_eq!(failure("fatal: git cat-file HEAD:a.txt: bad file", true), GitError::Failed);
    assert_eq!(failure("fatal: unable to read tree", true), GitError::Failed);
    assert_eq!(failure("", true), GitError::Failed);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Environnement et processus
// ---------------------------------------------------------------------------------------------------------------------------

fn os(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
    pairs.iter().map(|(name, value)| (OsString::from(name), OsString::from(value))).collect()
}

#[test]
fn the_child_environment_keeps_only_the_allowed_variables_and_forces_its_own() {
    let parent = os(&[
        ("Path", "C:\\bin"),
        ("HOME", "/home/me"),
        ("GIT_DIR", "/elsewhere/.git"),
        ("GIT_EXTERNAL_DIFF", "evil"),
        ("GIT_SSH_COMMAND", "evil"),
        ("GIT_PAGER", "evil"),
        ("LC_ALL", "fr_FR.UTF-8"),
        ("PAGER", "evil"),
        ("SECRET_TOKEN", "x"),
    ]);
    let env = child_env(parent);
    let names: Vec<String> = env.iter().map(|(name, _)| name.to_string_lossy().into_owned()).collect();
    // Les noms sont compares sans tenir compte de la casse (Windows) et gardent celle du parent.
    assert!(names.contains(&"Path".to_string()) && names.contains(&"HOME".to_string()));
    for refused in ["GIT_DIR", "GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "PAGER", "SECRET_TOKEN"] {
        assert!(!names.contains(&refused.to_string()), "{refused}");
    }
    let value = |name: &str| env.iter().find(|(candidate, _)| candidate == name).map(|(_, value)| value.to_string_lossy().into_owned());
    assert_eq!(value("GIT_PAGER").as_deref(), Some("cat"));
    assert_eq!(value("LC_ALL").as_deref(), Some("C"));
    assert_eq!(value("GIT_TERMINAL_PROMPT").as_deref(), Some("0"));
    assert_eq!(value("GIT_OPTIONAL_LOCKS").as_deref(), Some("0"));
    assert_eq!(env.iter().filter(|(name, _)| name == "GIT_PAGER" || name == "LC_ALL").count(), 2);
}

#[test]
fn the_fixed_options_and_variables_keep_git_read_only_and_offline() {
    let options: Vec<&str> = SAFE_OPTIONS.to_vec();
    let has_pair = |flag: &str, value: &str| options.windows(2).any(|pair| pair == [flag, value]);
    assert!(options.contains(&"--no-optional-locks"), "git ecrirait dans l'index");
    assert!(options.contains(&"--no-pager"));
    assert!(has_pair("-c", "core.fsmonitor=false"), "le programme de surveillance du depot serait lance");
    assert!(has_pair("-c", "core.quotePath=false"), "le prefixe d'un dossier accentue serait imprime entre guillemets");
    assert!(has_pair("-c", "protocol.allow=never"), "git pourrait ouvrir un transport reseau ou fichier");
    let forced = |name: &str| FORCED_ENV.iter().find(|(key, _)| *key == name).map(|(_, value)| *value);
    assert_eq!(forced("GIT_NO_LAZY_FETCH"), Some("1"), "un clone partiel telechargerait ses objets manquants");
    assert_eq!(forced("GIT_TERMINAL_PROMPT"), Some("0"));
    assert_eq!(forced("GIT_OPTIONAL_LOCKS"), Some("0"));
}

#[cfg(windows)]
fn sleeper() -> (&'static str, Vec<&'static str>) {
    // `ping` seul (sans `cmd` autour) : tuer le processus tue tout ce qui tient les tubes.
    ("ping", vec!["-n", "20", "127.0.0.1"])
}
#[cfg(not(windows))]
fn sleeper() -> (&'static str, Vec<&'static str>) {
    ("sleep", vec!["20"])
}

#[cfg(windows)]
fn chatterbox() -> (&'static str, Vec<&'static str>) {
    ("cmd", vec!["/C", "for /L %i in (1,1,50000000) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"])
}
#[cfg(not(windows))]
fn chatterbox() -> (&'static str, Vec<&'static str>) {
    ("yes", vec![])
}

#[test]
fn kills_a_program_that_runs_too_long() {
    let (program, args) = sleeper();
    let started = Instant::now();
    let result = run_program(program, &[], &args, Path::new("."), 1024, Duration::from_millis(300));
    assert_eq!(result.err(), Some(GitError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(10), "le processus n'a pas ete tue : {:?}", started.elapsed());
}

#[test]
fn stops_a_program_that_writes_too_much() {
    let (program, args) = chatterbox();
    let started = Instant::now();
    let result = run_program(program, &[], &args, Path::new("."), 10_000, Duration::from_secs(20));
    assert_eq!(result.err(), Some(GitError::TooLarge));
    // Detecte tout de suite : le programme (des dizaines de millions de lignes) ne va pas jusqu'au delai de 20 s.
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
}

#[test]
fn reports_a_missing_program_as_git_unavailable() {
    let result = run_program("runeforge-no-such-program", &[], &[], Path::new("."), 1024, Duration::from_secs(5));
    assert_eq!(result.err(), Some(GitError::GitUnavailable));
}

// ---------------------------------------------------------------------------------------------------------------------------
// Avec un vrai depot (ignores si `git` est absent de la machine)
// ---------------------------------------------------------------------------------------------------------------------------

fn git_available() -> bool {
    Command::new("git").arg("--version").output().map(|output| output.status.success()).unwrap_or(false)
}

macro_rules! require_git {
    () => {
        if !git_available() {
            eprintln!("git est absent de cette machine : test ignore");
            return;
        }
    };
}

/// `git` ordinaire (celui de l'utilisateur, avec toute sa configuration), pour preparer les depots de test.
fn git(directory: &Path, args: &[&str]) {
    let status = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"])
        .args(args)
        .current_dir(directory)
        .status()
        .expect("git doit se lancer");
    assert!(status.success(), "git {args:?} a echoue");
}

fn repository() -> TempDir {
    let directory = tempdir().expect("dossier temporaire");
    git(directory.path(), &["init", "-q", "-b", "main"]);
    directory
}

fn write(directory: &Path, relative: &str, content: &[u8]) {
    let path = directory.join(relative);
    fs::create_dir_all(path.parent().expect("parent")).expect("dossier");
    fs::write(path, content).expect("fichier");
}

fn commit_all(directory: &Path) {
    git(directory, &["add", "-A"]);
    git(directory, &["commit", "-q", "-m", "etat"]);
}

fn sorted(mut status: GitStatus) -> Vec<GitEntry> {
    status.entries.sort_by(|a, b| a.path.cmp(&b.path));
    status.entries
}

#[test]
fn a_folder_or_a_submodule_entry_is_not_a_file_of_head() {
    require_git!();
    let repo = repository();
    write(repo.path(), "npc/a.txt", b"a\n");
    commit_all(repo.path());
    // Un lien vers un commit (sous-module) a le meme chemin qu'un dossier : ce n'est pas un fichier.
    let id = String::from_utf8(Command::new("git").args(["rev-parse", "HEAD"]).current_dir(repo.path()).output().expect("git").stdout).expect("utf8");
    git(repo.path(), &["update-index", "--add", "--cacheinfo", &format!("160000,{},module", id.trim())]);
    // Pas `add -A` : il retirerait de l'index le lien dont le dossier n'existe pas.
    git(repo.path(), &["commit", "-q", "-m", "lien"]);
    assert_eq!(head_file(repo.path(), "npc").err(), Some(GitError::NotInHead));
    assert_eq!(head_file(repo.path(), "module").err(), Some(GitError::NotInHead));
    assert_eq!(head_file(repo.path(), "npc/a.txt").expect("head"), b"a\n");
    // Pas de motif : un nom qui ressemble a un joker ne designe que lui-meme.
    assert_eq!(head_file(repo.path(), "npc/*.txt").err(), Some(GitError::InvalidPath));
}

#[test]
fn a_clean_repository_has_a_branch_a_head_and_no_entry() {
    require_git!();
    let repo = repository();
    write(repo.path(), "a.txt", b"un\n");
    commit_all(repo.path());
    let status = status(repo.path()).expect("statut");
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(status.head.as_ref().map(String::len), Some(12));
    assert!(!status.detached && !status.unborn && status.entries.is_empty() && !status.truncated);
}

#[test]
fn lists_modified_deleted_staged_and_untracked_files() {
    require_git!();
    let repo = repository();
    write(repo.path(), "npc/a.txt", b"a\n");
    write(repo.path(), "npc/b.txt", b"b\n");
    commit_all(repo.path());
    write(repo.path(), "npc/a.txt", b"a modifie\n");
    fs::remove_file(repo.path().join("npc/b.txt")).expect("suppression");
    write(repo.path(), "npc/c.txt", b"c\n");
    git(repo.path(), &["add", "npc/c.txt"]);
    write(repo.path(), "npc/sous dossier/d e.txt", b"d\n");
    assert_eq!(
        sorted(status(repo.path()).expect("statut")),
        vec![entry("npc/a.txt", '.', 'M'), entry("npc/b.txt", '.', 'D'), entry("npc/c.txt", 'A', '.'), entry("npc/sous dossier/d e.txt", '?', '?')]
    );
}

#[test]
fn a_renamed_file_is_a_deletion_and_an_addition_not_a_rename() {
    require_git!();
    let repo = repository();
    write(repo.path(), "npc/ancien.txt", b"un contenu assez long pour que git reconnaisse le renommage\nsur plusieurs lignes\n");
    commit_all(repo.path());
    git(repo.path(), &["mv", "npc/ancien.txt", "npc/nouveau.txt"]);
    assert_eq!(sorted(status(repo.path()).expect("statut")), vec![entry("npc/ancien.txt", 'D', '.'), entry("npc/nouveau.txt", 'A', '.')]);
}

#[test]
fn an_unborn_repository_says_so_and_has_no_head_file() {
    require_git!();
    let repo = repository();
    write(repo.path(), "a.txt", b"un\n");
    let status = status(repo.path()).expect("statut");
    assert!(status.unborn);
    assert_eq!(status.head, None);
    assert_eq!(status.entries, vec![entry("a.txt", '?', '?')]);
    assert_eq!(head_file(repo.path(), "a.txt").err(), Some(GitError::NotInHead));
}

#[test]
fn a_project_in_a_subfolder_sees_only_its_own_files_with_project_relative_paths() {
    require_git!();
    let repo = repository();
    write(repo.path(), "projet/npc/a.txt", b"a\n");
    write(repo.path(), "ailleurs/b.txt", b"b\n");
    commit_all(repo.path());
    write(repo.path(), "projet/npc/a.txt", b"a2\n");
    write(repo.path(), "ailleurs/b.txt", b"b2\n");
    write(repo.path(), "projet/neuf.txt", b"n\n");
    let root = repo.path().join("projet");
    assert_eq!(sorted(status(&root).expect("statut")), vec![entry("neuf.txt", '?', '?'), entry("npc/a.txt", '.', 'M')]);
    assert_eq!(head_file(&root, "npc/a.txt").expect("head"), b"a\n");
}

#[test]
fn a_project_in_an_accented_folder_works() {
    require_git!();
    let repo = repository();
    write(repo.path(), "projet \u{e9}t\u{e9}/npc/a.txt", b"a\n");
    commit_all(repo.path());
    write(repo.path(), "projet \u{e9}t\u{e9}/npc/a.txt", b"a2\n");
    let root = repo.path().join("projet \u{e9}t\u{e9}");
    assert_eq!(status(&root).expect("statut"), GitStatus { branch: Some("main".into()), head: status(&root).expect("statut").head, entries: vec![entry("npc/a.txt", '.', 'M')], ..GitStatus::default() });
    assert_eq!(head_file(&root, "npc/a.txt").expect("head"), b"a\n");
}

#[test]
fn submodules_are_not_entered() {
    require_git!();
    let repo = repository();
    write(repo.path(), "a.txt", b"a\n");
    // Un depot imbrique, enregistre comme sous-module (un lien vers un commit) dans le depot principal.
    let nested = repo.path().join("sous");
    fs::create_dir_all(&nested).expect("dossier");
    git(&nested, &["init", "-q", "-b", "main"]);
    write(&nested, "x.txt", b"x\n");
    commit_all(&nested);
    let id = String::from_utf8(Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&nested).output().expect("git").stdout).expect("utf8");
    git(repo.path(), &["update-index", "--add", "--cacheinfo", &format!("160000,{},sous", id.trim())]);
    commit_all(repo.path());
    // Le sous-module avance d'un commit : un `git status` ordinaire le signale, pas le produit (autre depot, autre configuration).
    write(&nested, "y.txt", b"y\n");
    commit_all(&nested);
    let plain = String::from_utf8(Command::new("git").args(["status", "--porcelain=v1"]).current_dir(repo.path()).output().expect("git").stdout).expect("utf8");
    assert!(plain.contains("sous"), "controle : un git status ordinaire signale le sous-module ({plain:?})");
    assert!(status(repo.path()).expect("statut").entries.is_empty());
}

#[test]
fn never_downloads_a_missing_object_from_a_remote_repository() {
    require_git!();
    // Un depot distant (local) qui accepte les clones partiels, et deux clones sans le contenu des fichiers.
    let origin = repository();
    git(origin.path(), &["config", "uploadpack.allowFilter", "true"]);
    git(origin.path(), &["config", "uploadpack.allowAnySHA1InWant", "true"]);
    write(origin.path(), "a.txt", b"contenu distant\n");
    commit_all(origin.path());
    let url = format!("file:///{}", origin.path().to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    let clones = tempdir().expect("dossier temporaire");
    for name in ["controle", "produit"] {
        let status = Command::new("git").args(["clone", "-q", "--filter=blob:none", "--no-checkout", &url, name]).current_dir(clones.path()).status().expect("git");
        if !status.success() {
            eprintln!("clone partiel impossible avec ce git : test ignore");
            return;
        }
    }
    let missing = |clone: &Path| -> String {
        let output = Command::new("git").args(["rev-list", "--objects", "--missing=print", "HEAD"]).current_dir(clone).output().expect("git");
        String::from_utf8_lossy(&output.stdout).lines().filter(|line| line.starts_with('?')).collect::<Vec<_>>().join("\n")
    };
    let control = clones.path().join("controle");
    let product = clones.path().join("produit");
    assert!(!missing(&control).is_empty() && !missing(&product).is_empty(), "le clone devrait manquer du contenu de a.txt");
    // Controle : un `git cat-file` ordinaire telecharge l'objet depuis le depot distant.
    let plain = Command::new("git").args(["cat-file", "blob", "HEAD:a.txt"]).current_dir(&control).output().expect("git");
    assert_eq!(plain.stdout, b"contenu distant\n", "controle : git telecharge l'objet manquant");
    assert!(missing(&control).is_empty());
    // Le produit, lui, echoue sans rien telecharger.
    assert_eq!(head_file(&product, "a.txt").err(), Some(GitError::Failed));
    assert!(!missing(&product).is_empty(), "l'objet manquant a ete telecharge");
    // Le statut d'un clone partiel ne telecharge rien non plus.
    status(&product).ok();
    assert!(!missing(&product).is_empty());
}

#[test]
fn head_file_returns_the_committed_bytes_exactly_not_the_working_copy() {
    require_git!();
    let repo = repository();
    write(repo.path(), "a.txt", b"mes \"a\";\r\nclose;\r\n");
    commit_all(repo.path());
    write(repo.path(), "a.txt", b"modifie\n");
    assert_eq!(head_file(repo.path(), "a.txt").expect("head"), b"mes \"a\";\r\nclose;\r\n");
    // Les barres obliques inverses de Windows sont acceptees comme celles du reste de l'application.
    write(repo.path(), "npc/b.txt", b"b\n");
    commit_all(repo.path());
    assert_eq!(head_file(repo.path(), "npc\\b.txt").expect("head"), b"b\n");
}

#[test]
fn head_file_of_a_new_file_or_a_folder_is_not_in_head() {
    require_git!();
    let repo = repository();
    write(repo.path(), "npc/a.txt", b"a\n");
    commit_all(repo.path());
    write(repo.path(), "neuf.txt", b"n\n");
    assert_eq!(head_file(repo.path(), "neuf.txt").err(), Some(GitError::NotInHead));
    assert_eq!(head_file(repo.path(), "npc").err(), Some(GitError::NotInHead));
    assert_eq!(head_file(repo.path(), "absent/x.txt").err(), Some(GitError::NotInHead));
}

#[test]
fn head_file_refuses_unsafe_paths_before_running_git() {
    // Aucun depot n'est necessaire : le chemin est refuse avant tout lancement.
    let directory = tempdir().expect("dossier temporaire");
    for bad in ["", "../x", "/x", "\\x", "a/../b", "a//b", "c:x", "a:b", "x\ny", "con"] {
        assert_eq!(head_file(directory.path(), bad).err(), Some(GitError::InvalidPath), "{bad:?}");
    }
}

#[test]
fn a_folder_that_is_not_a_repository_is_reported() {
    require_git!();
    let directory = tempdir().expect("dossier temporaire");
    assert_eq!(status(directory.path()).err(), Some(GitError::NotARepository));
    assert_eq!(head_file(directory.path(), "a.txt").err(), Some(GitError::NotARepository));
}

#[test]
fn status_does_not_write_anything_in_the_repository() {
    require_git!();
    let repo = repository();
    write(repo.path(), "a.txt", b"a\n");
    commit_all(repo.path());
    let index = repo.path().join(".git/index");
    let before = fs::read(&index).expect("index");
    // Un fichier touche (meme taille, autre date) obligerait un `git status` ordinaire a rafraichir l'index.
    std::thread::sleep(Duration::from_millis(1100));
    write(repo.path(), "a.txt", b"a\n");
    status(repo.path()).expect("statut");
    assert_eq!(fs::read(&index).expect("index"), before, "l'index a ete reecrit");
    assert!(!repo.path().join(".git/index.lock").exists());
}

#[test]
fn does_not_run_the_program_a_repository_configures_to_watch_its_files() {
    require_git!();
    let repo = repository();
    write(repo.path(), "a.txt", b"a\n");
    commit_all(repo.path());
    let marker = repo.path().join("marqueur.txt");
    let marker_text = marker.to_string_lossy().replace('\\', "/");
    git(repo.path(), &["config", "core.fsmonitor", &format!("echo declenche > '{marker_text}'")]);
    // Controle : un `git status` ordinaire (celui de l'utilisateur) execute bien ce programme.
    git(repo.path(), &["status", "-s"]);
    let plain_ran = marker.exists();
    fs::remove_file(&marker).ok();
    // Le produit, lui, ne l'execute pas.
    status(repo.path()).expect("statut");
    head_file(repo.path(), "a.txt").expect("head");
    assert!(!marker.exists(), "le programme de surveillance du depot a ete execute");
    if !plain_ran {
        eprintln!("note : cette version de git n'a pas execute le programme avec `git status -s` ; le controle est sans portee ici");
    }
}
