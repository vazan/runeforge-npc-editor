//! Etat Git d'un projet, **en lecture seule** (CLAUDE.md 14.2 : statut, fichiers modifies, comparaison ; jamais de commit ni de push).
//!
//! C'est le **seul code du produit qui lance un processus** (le programme `git` de la machine, jamais un shell). Il le fait avec :
//! - un environnement vide, sauf une liste blanche de variables (de quoi trouver `git` et sa configuration globale) : aucune
//!   variable `GIT_*` heritee (`GIT_DIR`, `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`...) ne peut le detourner ;
//! - des options qui evitent d'ecrire dans le depot (`--no-optional-locks`) et de lancer le programme de surveillance du depot
//!   (`core.fsmonitor=false`), et des sous-modules ignores (un autre depot, une autre configuration) ;
//! - des arguments construits un par un (aucune interpretation par un shell) et des chemins valides comme ceux du reste de l'application ;
//! - un delai (15 s) et une taille de sortie maximaux : au-dela, le processus est tue.
//!
//! Ce qui n'est **pas** neutralise : un depot dont la configuration locale declare un filtre (`filter.x.clean`) ou un autre
//! programme que `git status` peut lancer. C'est pourquoi l'application ne l'appelle qu'apres le consentement explicite de
//! l'utilisateur pour ce projet (DEC-039) ; elle ne lit jamais ce consentement dans le projet lui-meme.

mod process;
mod status;

use std::path::Path;

use runeforge_filesystem::path_guard::validate_relative;
use runeforge_filesystem::FsError;
use serde::Serialize;

pub use status::{parse_status, GitEntry, GitStatus};

/// Nombre maximal d'entrees rendues ; au-dela le statut est marque `truncated`.
pub const MAX_ENTRIES: usize = 5000;
/// Taille maximale d'un fichier lu dans `HEAD`.
pub const MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
/// Taille maximale de la sortie de `git status` (au-dela le processus est tue).
const MAX_STATUS_BYTES: usize = 8 * 1024 * 1024;

/// Erreur structuree renvoyee a l'interface (`{ "code": "..." }`). Aucun message de `git` n'est transmis : il peut contenir des chemins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum GitError {
    UnknownRoot,
    InvalidPath,
    /// L'utilisateur n'a pas (encore) autorise Git pour ce projet.
    NotTrusted,
    /// `git` est introuvable ou ne se lance pas.
    GitUnavailable,
    NotARepository,
    /// Git refuse le depot (« dubious ownership » : il appartient a un autre utilisateur).
    UnsafeRepository,
    /// Le fichier n'existe pas dans `HEAD` (fichier neuf, dossier, ou depot sans commit).
    NotInHead,
    Timeout,
    TooLarge,
    Failed,
}

impl GitError {
    /// Code stable utilisable par l'interface et les tests.
    pub fn code(&self) -> &'static str {
        match self {
            GitError::UnknownRoot => "unknown_root",
            GitError::InvalidPath => "invalid_path",
            GitError::NotTrusted => "not_trusted",
            GitError::GitUnavailable => "git_unavailable",
            GitError::NotARepository => "not_a_repository",
            GitError::UnsafeRepository => "unsafe_repository",
            GitError::NotInHead => "not_in_head",
            GitError::Timeout => "timeout",
            GitError::TooLarge => "too_large",
            GitError::Failed => "failed",
        }
    }
}

impl From<FsError> for GitError {
    fn from(error: FsError) -> Self {
        match error {
            FsError::UnknownRoot => GitError::UnknownRoot,
            _ => GitError::InvalidPath,
        }
    }
}

pub type Result<T> = std::result::Result<T, GitError>;

/// Ce que dit `git` quand il echoue : on ne garde que la nature de l'echec, jamais son message (il peut contenir des chemins).
/// `file_lookup` : la commande cherchait un fichier de `HEAD` (« absent » est alors une reponse, pas une panne).
fn failure(stderr: &str, file_lookup: bool) -> GitError {
    let text = stderr.to_ascii_lowercase();
    if text.contains("not a git repository") {
        return GitError::NotARepository;
    }
    if text.contains("dubious ownership") {
        return GitError::UnsafeRepository;
    }
    // « path 'x' exists on disk, but not in 'HEAD' » (fichier neuf), « path 'x' does not exist in 'HEAD' », « bad file » (un dossier),
    // « Not a valid object name HEAD:x » ou « invalid object name 'HEAD' » (depot sans commit).
    let missing = ["exists on disk, but not in", "does not exist", "not a valid object name", "invalid object name", "unknown revision"];
    if file_lookup && missing.iter().any(|phrase| text.contains(phrase)) {
        return GitError::NotInHead;
    }
    GitError::Failed
}

/// Dossier du projet par rapport a la racine du depot (`Software/`, ou vide a la racine), ou l'erreur de Git.
fn prefix_of(root: &Path) -> Result<String> {
    let output = process::run(&["rev-parse", "--show-prefix"], root, 4096)?;
    if !output.success {
        return Err(failure(&output.stderr, false));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim_end_matches(['\n', '\r']).to_string())
}

/// Etat du depot qui contient `root` : branche, commit de `HEAD`, et fichiers modifies, ajoutes, supprimes ou non suivis **du dossier du
/// projet** (chemins relatifs a `root`). Lecture seule : rien n'est ecrit dans le depot.
pub fn status(root: &Path) -> Result<GitStatus> {
    let prefix = prefix_of(root)?;
    let output = process::run(
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all", "--", "."],
        root,
        MAX_STATUS_BYTES,
    )?;
    if !output.success {
        return Err(failure(&output.stderr, false));
    }
    Ok(parse_status(&output.stdout, &prefix, MAX_ENTRIES))
}

/// L'identifiant d'objet que `git ls-tree` donne a `relative` dans `HEAD` quand c'est un fichier ; `NotInHead` pour un fichier neuf, un dossier, un
/// sous-module ou un depot sans commit. Lu dans l'arbre : aucun contenu n'est lu ici, donc rien n'est telecharge dans un clone partiel.
fn blob_in_head(root: &Path, relative: &str) -> Result<String> {
    let segments = validate_relative(relative)?;
    let path = segments.join("/");
    let output = process::run(&["ls-tree", "-z", "HEAD", "--", &path], root, 64 * 1024)?;
    if !output.success {
        return Err(failure(&output.stderr, true));
    }
    // `<mode> <type> <identifiant>\t<chemin>`, termine par un octet nul ; au plus une entree (le chemin est exact).
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let Some((meta, _name)) = text.trim_end_matches('\0').split_once('\t') else { return Err(GitError::NotInHead) };
    let fields: Vec<&str> = meta.split(' ').collect();
    match fields.as_slice() {
        [_mode, "blob", id] if is_object_id(id) => Ok((*id).to_string()),
        _ => Err(GitError::NotInHead),
    }
}

/// Un identifiant d'objet git (SHA-1 ou SHA-256) : jamais autre chose que de l'hexadecimal, donc jamais pris pour une option.
fn is_object_id(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Contenu, dans `HEAD`, du fichier `relative` (chemin relatif a `root`). `NotInHead` si le fichier n'y est pas (fichier neuf, dossier). Un fichier
/// qui est dans `HEAD` mais dont le contenu n'est pas local (clone partiel) est une erreur (`Failed`) : il n'est jamais telecharge.
pub fn head_file(root: &Path, relative: &str) -> Result<Vec<u8>> {
    let id = blob_in_head(root, relative)?;
    let output = process::run(&["cat-file", "blob", &id], root, MAX_FILE_BYTES)?;
    if !output.success {
        return Err(failure(&output.stderr, false));
    }
    Ok(output.stdout)
}

#[cfg(test)]
mod tests;
