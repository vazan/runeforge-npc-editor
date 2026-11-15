//! Services de fichiers surs de RuneForge Studio (CLAUDE.md 9.2 et 14.1).
//!
//! Principes :
//! - le frontend ne manipule jamais de chemin absolu : il designe un fichier par (racine approuvee, chemin relatif) ;
//! - tout chemin est valide (pas de `..`, pas de noms reserves Windows) puis canonicalise ; un lien symbolique qui
//!   sort de la racine est refuse ;
//! - le contenu est lu et ecrit en octets, sans conversion ;
//! - un fichier n'est remplace que de facon atomique et jamais s'il a ete modifie ailleurs depuis sa lecture.

pub mod config;
pub mod dirs;
pub mod error;
pub mod history;
pub mod log;
pub mod path_guard;
pub mod read;
pub mod recovery;
pub mod roots;
pub mod scan;
pub mod stat;
pub mod util;
pub mod write;

pub use config::ConfigStore;
pub use dirs::create_directory;
pub use error::{FsError, Result};
pub use history::{HistoryEntry, HistoryStore};
pub use log::{DiagnosticLog, LogLevel};
pub use read::{read_file, FileRead, DEFAULT_MAX_FILE_BYTES};
pub use recovery::{RecoveryEntry, RecoveryMeta, RecoveryStore};
pub use roots::{ApprovedRoot, RootRegistry};
pub use scan::{scan, EntryKind, ScanEntry, ScanOptions, ScanResult, SkipReason, SkippedEntry};
pub use stat::{sha256_hex, FileStat};
pub use write::{write_file, Precondition, WriteOutcome};
