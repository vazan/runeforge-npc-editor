use serde::Serialize;
use thiserror::Error;

use crate::stat::FileStat;

pub type Result<T> = std::result::Result<T, FsError>;

/// Erreur structuree renvoyee a l'interface (`{ "code": "...", ... }`).
///
/// Les messages ne contiennent ni chemin absolu ni contenu de fichier (CLAUDE.md 4 : journaux sans secret).
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum FsError {
    #[error("invalid path: {reason}")]
    InvalidPath { reason: String },
    #[error("path is outside the approved project root")]
    OutsideRoot,
    #[error("unknown or unapproved project root")]
    UnknownRoot,
    #[error("not found")]
    NotFound,
    #[error("already exists")]
    AlreadyExists,
    #[error("permission denied")]
    PermissionDenied,
    #[error("file is too large ({size} bytes, limit {limit})")]
    TooLarge { size: u64, limit: u64 },
    /// Le fichier a change sur le disque depuis sa lecture : l'ecrasement est refuse.
    #[error("the file changed on disk since it was read")]
    ExternalModification { current: FileStat },
    #[error("not a regular file")]
    NotAFile,
    #[error("not a directory")]
    NotADirectory,
    #[error("invalid argument: {message}")]
    InvalidArgument { message: String },
    #[error("corrupt data: {message}")]
    Corrupt { message: String },
    #[error("i/o error: {message}")]
    Io { message: String },
}

impl FsError {
    pub fn invalid_path(reason: impl Into<String>) -> Self {
        FsError::InvalidPath { reason: reason.into() }
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        FsError::InvalidArgument { message: message.into() }
    }

    /// Code stable utilisable par l'interface et les tests.
    pub fn code(&self) -> &'static str {
        match self {
            FsError::InvalidPath { .. } => "invalid_path",
            FsError::OutsideRoot => "outside_root",
            FsError::UnknownRoot => "unknown_root",
            FsError::NotFound => "not_found",
            FsError::AlreadyExists => "already_exists",
            FsError::PermissionDenied => "permission_denied",
            FsError::TooLarge { .. } => "too_large",
            FsError::ExternalModification { .. } => "external_modification",
            FsError::NotAFile => "not_a_file",
            FsError::NotADirectory => "not_a_directory",
            FsError::InvalidArgument { .. } => "invalid_argument",
            FsError::Corrupt { .. } => "corrupt",
            FsError::Io { .. } => "io",
        }
    }
}

impl From<std::io::Error> for FsError {
    fn from(error: std::io::Error) -> Self {
        use std::io::ErrorKind;
        match error.kind() {
            ErrorKind::NotFound => FsError::NotFound,
            ErrorKind::AlreadyExists => FsError::AlreadyExists,
            ErrorKind::PermissionDenied => FsError::PermissionDenied,
            kind => FsError::Io {
                message: match error.raw_os_error() {
                    Some(code) => format!("{kind} (os error {code})"),
                    None => kind.to_string(),
                },
            },
        }
    }
}
