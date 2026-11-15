//! Lecture de `git status --porcelain=v2 --branch -z`.
//!
//! Format (documentation de Git, « Porcelain Format Version 2 »), chaque element termine par un octet nul :
//! - `# branch.oid <commit>|(initial)` et `# branch.head <branche>|(detached)` : en-tetes ;
//! - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <chemin>` : entree ordinaire ;
//! - `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <chemin>` suivi, apres un octet nul, du chemin d'origine : renommage ou copie ;
//! - `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <chemin>` : conflit de fusion ;
//! - `? <chemin>` : non suivi ; `! <chemin>` : ignore.
//!
//! `X` est l'etat dans l'index (a commiter), `Y` celui du dossier de travail ; `.` veut dire « inchange ».

use serde::Serialize;

/// Un fichier dont l'etat differe de `HEAD`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GitEntry {
    /// Chemin relatif au dossier du projet, avec des `/`.
    pub path: String,
    /// Etat dans l'index : `M` modifie, `A` ajoute, `D` supprime, `T` type change, `.` inchange, `?` non suivi, `U` conflit.
    pub x: char,
    /// Etat dans le dossier de travail (memes lettres).
    pub y: char,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Nom de la branche courante ; `None` en `HEAD` detache.
    pub branch: Option<String>,
    pub detached: bool,
    /// Aucun commit n'existe encore.
    pub unborn: bool,
    /// Debut (12 caracteres) de l'identifiant du commit de `HEAD`.
    pub head: Option<String>,
    pub entries: Vec<GitEntry>,
    /// Plus d'entrees que `max_entries` : la liste est coupee.
    pub truncated: bool,
}

fn state(letter: Option<char>) -> char {
    letter.unwrap_or('.')
}

/// Lit la sortie de `git status --porcelain=v2 --branch -z`. `prefix` : dossier du projet par rapport a la racine du depot
/// (`Software/`, ou vide) ; les chemins sont rendus relatifs au projet et les entrees d'ailleurs dans le depot sont ignorees.
/// Les lignes que le format ne prevoit pas sont ignorees : une version future de Git n'empeche pas d'afficher le reste.
pub fn parse_status(output: &[u8], prefix: &str, max_entries: usize) -> GitStatus {
    let mut status = GitStatus::default();
    let mut tokens = output.split(|&byte| byte == 0).filter(|token| !token.is_empty());
    while let Some(token) = tokens.next() {
        let line = String::from_utf8_lossy(token);
        let (x, y, path): (char, char, String) = if let Some(header) = line.strip_prefix("# ") {
            read_header(&mut status, header);
            continue;
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // 1 XY sub mH mI mW hH hI chemin
            let fields: Vec<&str> = rest.splitn(8, ' ').collect();
            match (fields.first(), fields.get(7)) {
                (Some(xy), Some(path)) => (state(xy.chars().next()), state(xy.chars().nth(1)), (*path).to_string()),
                _ => continue,
            }
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // 2 XY sub mH mI mW hH hI Xscore chemin, puis le chemin d'origine dans l'element suivant.
            let _origin = tokens.next();
            let fields: Vec<&str> = rest.splitn(9, ' ').collect();
            match (fields.first(), fields.get(8)) {
                (Some(xy), Some(path)) => (state(xy.chars().next()), state(xy.chars().nth(1)), (*path).to_string()),
                _ => continue,
            }
        } else if let Some(rest) = line.strip_prefix("u ") {
            // u XY sub m1 m2 m3 mW h1 h2 h3 chemin
            let fields: Vec<&str> = rest.splitn(10, ' ').collect();
            match fields.get(9) {
                Some(path) => ('U', 'U', (*path).to_string()),
                None => continue,
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            ('?', '?', path.to_string())
        } else {
            // `! chemin` (ignore) et tout ce que ce format ne prevoit pas.
            continue;
        };
        let Some(relative) = path.strip_prefix(prefix) else { continue };
        if relative.is_empty() {
            continue;
        }
        if status.entries.len() >= max_entries {
            status.truncated = true;
            break;
        }
        status.entries.push(GitEntry { path: relative.to_string(), x, y });
    }
    status
}

fn read_header(status: &mut GitStatus, header: &str) {
    if let Some(oid) = header.strip_prefix("branch.oid ") {
        if oid == "(initial)" {
            status.unborn = true;
        } else {
            status.head = Some(oid.chars().take(12).collect());
        }
    } else if let Some(head) = header.strip_prefix("branch.head ") {
        if head == "(detached)" {
            status.detached = true;
        } else {
            status.branch = Some(head.to_string());
        }
    }
}
