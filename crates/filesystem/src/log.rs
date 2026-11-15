//! Journal de diagnostic local, facultatif (CLAUDE.md §2.1 n° 16 ; §4 : « aucun secret, chemin sensible ou source complet par défaut »).
//!
//! Chaque événement a un niveau, un code et un schéma de champs fixés ici. Les champs acceptent uniquement des compteurs,
//! des booléens ou des valeurs prédéfinies.
//! Le fichier est borné (512 Kio, plus une génération précédente) : le journal ne grossit jamais sans limite.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::{FsError, Result};
use crate::util::now_millis;

/// Taille au-delà de laquelle le fichier courant devient la génération précédente.
pub const MAX_LOG_BYTES: u64 = 512 * 1024;
const LOG_NAME: &str = "runeforge.log";
const PREVIOUS_NAME: &str = "runeforge.log.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "info" => Ok(LogLevel::Info),
            "warn" => Ok(LogLevel::Warn),
            "error" => Ok(LogLevel::Error),
            _ => Err(FsError::invalid_argument("invalid log level")),
        }
    }

    fn label(self) -> &'static str {
        match self {
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
        }
    }
}

const ERROR_NAMES: &[&str] = &[
    "unknown", "Error", "AggregateError", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
];
const SAVE_CODES: &[&str] = &[
    "unknown", "invalid_path", "outside_root", "unknown_root", "not_found", "already_exists", "permission_denied",
    "too_large", "external_modification", "not_a_file", "not_a_directory", "invalid_argument", "corrupt", "io",
];
/// Codes d'erreur des mises a jour (`UpdateError::code` de `crates/updater`, que ce crate ne connait pas) ; un test de l'interface verifie
/// que cette liste suit celle du coeur de mise a jour.
const UPDATE_CODES: &[&str] = &[
    "unknown", "not_configured", "invalid_repository", "invalid_channel", "invalid_token", "repository_not_found", "unauthorized",
    "rate_limited", "network", "bad_response", "bad_manifest", "bad_signature", "unsupported_schema", "no_platform_asset",
    "manual_update_required", "too_large", "hash_mismatch", "not_executable", "unsafe_redirect", "insecure_url", "no_pending_update",
    "unsaved_changes", "unsupported_platform", "not_writable", "install_failed", "io",
];

fn valid_fields(detail: &str, counters: &[&str], choice: Option<(&str, &[&str])>) -> bool {
    let mut fields = detail.split(' ');
    for &prefix in counters {
        let Some(value) = fields.next().and_then(|field| field.strip_prefix(prefix)) else {
            return false;
        };
        if value.len() > 10 || !value.bytes().all(|byte| byte.is_ascii_digit()) || value.parse::<u32>().is_err() {
            return false;
        }
    }
    if let Some((prefix, allowed)) = choice {
        let Some(value) = fields.next().and_then(|field| field.strip_prefix(prefix)) else {
            return false;
        };
        if !allowed.contains(&value) {
            return false;
        }
    }
    fields.next().is_none()
}

fn valid_event(level: LogLevel, code: &str, detail: &str) -> bool {
    use LogLevel::{Error, Info, Warn};
    let boolean = &["false", "true"];
    match (level, code) {
        (Info, "LOG_ENABLED") | (Error, "INDEX_ERROR") => detail.is_empty(),
        (Info, "PROJECT_OPENED") => valid_fields(detail, &["files="], Some(("truncated=", boolean))),
        (Warn, "RECOVERY_OFFERED") => valid_fields(detail, &["count="], None),
        (Info, "INDEX_DONE") => valid_fields(detail, &["files=", "functions=", "npcs=", "ms="], None),
        (Warn, "SAVE_CONFLICT") => valid_fields(detail, &[], Some(("deleted=", boolean))),
        (Error, "SAVE_FAILED") => valid_fields(detail, &[], Some(("code=", SAVE_CODES))),
        (Error, "UI_ERROR" | "UI_REJECTION") => valid_fields(detail, &[], Some(("name=", ERROR_NAMES))),
        (Info | Warn, "DEPLOY_DONE") => {
            valid_fields(detail, &["created=", "updated=", "overwritten=", "unchanged=", "failed=", "skipped="], None)
        }
        (Info | Warn, "DEPLOY_ROLLBACK") => valid_fields(detail, &["restored=", "failed="], None),
        // Mises a jour : jamais le depot, le jeton, la version ni un message du serveur, seulement un resultat ou un code.
        (Info, "UPDATE_CHECK") => valid_fields(detail, &[], Some(("result=", &["up_to_date", "available"]))),
        (Info, "UPDATE_INSTALL") => detail.is_empty(),
        (Error, "UPDATE_FAILED") => valid_fields(detail, &[], Some(("code=", UPDATE_CODES))),
        _ => false,
    }
}

#[derive(Debug)]
pub struct DiagnosticLog {
    directory: PathBuf,
    limit: u64,
    write_lock: Mutex<()>,
}

impl DiagnosticLog {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self::with_limit(directory, MAX_LOG_BYTES)
    }

    /// Journal dont le fichier courant est limité à `limit` octets (pour les tests).
    pub fn with_limit(directory: impl Into<PathBuf>, limit: u64) -> Self {
        Self { directory: directory.into(), limit, write_lock: Mutex::new(()) }
    }

    /// Ajoute une ligne `<millisecondes depuis 1970> <NIVEAU> <CODE> <détail>`.
    pub fn append(&self, level: LogLevel, code: &str, detail: &str) -> Result<()> {
        self.append_at(now_millis(), level, code, detail)
    }

    fn append_at(&self, millis: i64, level: LogLevel, code: &str, detail: &str) -> Result<()> {
        if !valid_event(level, code, detail) {
            return Err(FsError::invalid_argument("invalid log event"));
        }
        let line = if detail.is_empty() { format!("{millis} {} {code}\n", level.label()) } else { format!("{millis} {} {code} {detail}\n", level.label()) };
        let _write_guard = self.write_lock.lock().map_err(|_| FsError::Io { message: "log lock unavailable".into() })?;
        fs::create_dir_all(&self.directory)?;
        let path = self.directory.join(LOG_NAME);
        let current = fs::metadata(&path).map(|metadata| metadata.len()).unwrap_or(0);
        if current > 0 && current + line.len() as u64 > self.limit {
            // `fs::rename` remplace la generation precedente (y compris sous Windows : `MOVEFILE_REPLACE_EXISTING`).
            fs::rename(&path, self.directory.join(PREVIOUS_NAME))?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
        file.write_all(line.as_bytes())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn read(directory: &std::path::Path, name: &str) -> String {
        fs::read_to_string(directory.join(name)).unwrap_or_default()
    }

    #[test]
    fn appends_one_line_per_event_in_order() {
        let dir = tempdir().unwrap();
        let log = DiagnosticLog::new(dir.path().join("logs"));
        log.append_at(1000, LogLevel::Info, "LOG_ENABLED", "").unwrap();
        log.append_at(1001, LogLevel::Info, "INDEX_DONE", "files=12 functions=3 npcs=0 ms=40").unwrap();
        log.append_at(1002, LogLevel::Error, "UI_ERROR", "name=TypeError").unwrap();
        log.append_at(1003, LogLevel::Warn, "SAVE_CONFLICT", "deleted=true").unwrap();
        assert_eq!(
            read(&dir.path().join("logs"), LOG_NAME),
            "1000 INFO LOG_ENABLED\n1001 INFO INDEX_DONE files=12 functions=3 npcs=0 ms=40\n1002 ERROR UI_ERROR name=TypeError\n1003 WARN SAVE_CONFLICT deleted=true\n"
        );
    }

    #[test]
    fn parses_levels_and_rejects_others() {
        assert_eq!(LogLevel::parse("info").unwrap(), LogLevel::Info);
        assert_eq!(LogLevel::parse("warn").unwrap(), LogLevel::Warn);
        assert_eq!(LogLevel::parse("error").unwrap(), LogLevel::Error);
        for bad in ["", "INFO", "debug", "info ", "warning"] {
            assert!(LogLevel::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rejects_free_form_data_without_creating_a_log() {
        let dir = tempdir().unwrap();
        let logs = dir.path().join("logs");
        let log = DiagnosticLog::new(&logs);
        for (level, code, detail) in [
            (LogLevel::Info, "PRIVATE_TOKEN", ""),
            (LogLevel::Info, "LOG_ENABLED", "F_SecretNpc"),
            (LogLevel::Error, "UI_ERROR", "name=F_SecretNpc"),
            (LogLevel::Error, "UI_ERROR", "name=TypeError filename=private.txt"),
            (LogLevel::Error, "SAVE_FAILED", "code=PRIVATE_TOKEN"),
            (LogLevel::Info, "PROJECT_OPENED", "files=1 truncated=private.txt"),
            (LogLevel::Warn, "RECOVERY_OFFERED", "count=00000000000"),
            (LogLevel::Warn, "RECOVERY_OFFERED", "count=4294967296"),
            (LogLevel::Warn, "RECOVERY_OFFERED", "count=+1"),
            (LogLevel::Warn, "RECOVERY_OFFERED", "count="),
            (LogLevel::Warn, "RECOVERY_OFFERED", "count=1\n"),
            (LogLevel::Info, "INDEX_DONE", "files=1"),
            (LogLevel::Info, "SAVE_CONFLICT", "deleted=false"),
            (LogLevel::Error, "UPDATE_FAILED", "code=ghp_0123456789"),
            (LogLevel::Error, "UPDATE_FAILED", "code=network repository=acme/private"),
            (LogLevel::Warn, "UPDATE_FAILED", "code=network"),
            (LogLevel::Info, "UPDATE_CHECK", "result=acme/private"),
            (LogLevel::Info, "UPDATE_CHECK", "result=available version=9.9.9"),
            (LogLevel::Info, "UPDATE_INSTALL", "version=9.9.9"),
        ] {
            assert!(log.append_at(1, level, code, detail).is_err(), "{level:?} {code} {detail:?}");
        }
        assert!(!logs.exists());
    }

    #[test]
    fn accepts_the_remaining_application_events() {
        let dir = tempdir().unwrap();
        let log = DiagnosticLog::new(dir.path());
        for (level, code, detail) in [
            (LogLevel::Info, "PROJECT_OPENED", "files=2 truncated=false"),
            (LogLevel::Warn, "RECOVERY_OFFERED", "count=1"),
            (LogLevel::Error, "INDEX_ERROR", ""),
            (LogLevel::Error, "SAVE_FAILED", "code=permission_denied"),
            (LogLevel::Error, "UI_REJECTION", "name=unknown"),
            (LogLevel::Info, "DEPLOY_DONE", "created=1 updated=0 overwritten=0 unchanged=0 failed=0 skipped=0"),
            (LogLevel::Warn, "DEPLOY_ROLLBACK", "restored=1 failed=1"),
            (LogLevel::Info, "UPDATE_CHECK", "result=up_to_date"),
            (LogLevel::Info, "UPDATE_CHECK", "result=available"),
            (LogLevel::Info, "UPDATE_INSTALL", ""),
            (LogLevel::Error, "UPDATE_FAILED", "code=bad_signature"),
            (LogLevel::Error, "UPDATE_FAILED", "code=unknown"),
        ] {
            log.append_at(1, level, code, detail).unwrap();
        }
        assert_eq!(read(dir.path(), LOG_NAME).lines().count(), 12);
    }

    #[test]
    fn rotates_to_a_single_previous_generation_and_never_exceeds_the_limit() {
        let dir = tempdir().unwrap();
        let line_size = "1000 WARN RECOVERY_OFFERED count=00\n".len();
        let limit = 10 * line_size;
        let log = DiagnosticLog::with_limit(dir.path(), limit as u64);
        for index in 0..60 {
            log.append_at(1000 + index, LogLevel::Warn, "RECOVERY_OFFERED", &format!("count={index:02}")).unwrap();
        }
        let current = read(dir.path(), LOG_NAME);
        let previous = read(dir.path(), PREVIOUS_NAME);
        assert_eq!(current.len(), limit);
        assert_eq!(previous.len(), limit);
        // Seules deux generations existent, et la plus recente contient le dernier evenement.
        let names: Vec<String> = fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(current.ends_with("count=59\n"));
        // Les lignes ne sont jamais coupees.
        assert!(current.lines().chain(previous.lines()).all(|line| line.starts_with("10") && line.contains(" WARN RECOVERY_OFFERED count=")));
    }

    #[test]
    fn concurrent_appends_keep_both_generations_bounded() {
        let dir = tempdir().unwrap();
        let line = "1 INFO LOG_ENABLED\n";
        let limit = 5 * line.len();
        let log = DiagnosticLog::with_limit(dir.path(), limit as u64);
        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    for _ in 0..10 {
                        log.append_at(1, LogLevel::Info, "LOG_ENABLED", "").unwrap();
                    }
                });
            }
        });
        for name in [LOG_NAME, PREVIOUS_NAME] {
            assert_eq!(read(dir.path(), name), line.repeat(5));
        }
    }

    #[test]
    fn does_not_rotate_an_empty_file_for_one_oversized_line() {
        let dir = tempdir().unwrap();
        let log = DiagnosticLog::with_limit(dir.path(), 10);
        log.append_at(1, LogLevel::Info, "LOG_ENABLED", "").unwrap();
        assert!(!dir.path().join(PREVIOUS_NAME).exists());
        assert_eq!(read(dir.path(), LOG_NAME), "1 INFO LOG_ENABLED\n");
    }
}
