use serde::Serialize;
use thiserror::Error;

/// Erreur structuree renvoyee a l'interface (`{ "code": "...", ... }`).
///
/// Aucun message ne contient le jeton d'acces, une adresse complete, un chemin absolu ni le contenu d'un fichier : un message
/// d'erreur ne doit rien reveler de plus que son code (CLAUDE.md 16.2).
#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum UpdateError {
    /// Cette version ne contient pas de cle publique de mise a jour : rien ne peut etre verifie, donc rien n'est installe.
    #[error("updates are not configured in this build")]
    NotConfigured,
    #[error("invalid repository name")]
    InvalidRepository,
    #[error("invalid update channel")]
    InvalidChannel,
    /// Un jeton ne contient que des lettres, des chiffres, `_` et `-` (jamais un saut de ligne : il part dans un en-tete HTTP).
    #[error("the access token has an invalid format")]
    InvalidToken,
    /// Le serveur refuse le jeton, ou ne montre pas le depot sans lui (un depot prive repond 404 sans acces).
    #[error("the repository was not found, or it is not visible with these credentials")]
    RepositoryNotFound,
    #[error("the update server refused the credentials")]
    Unauthorized,
    #[error("the update server rate limit is reached")]
    RateLimited,
    /// `kind` : `timeout`, `dns`, `tls`, `connection`, `status:<code>`, `network`.
    #[error("network error: {kind}")]
    Network { kind: String },
    #[error("the update server answered with an unexpected response")]
    BadResponse,
    #[error("the release manifest is invalid: {reason}")]
    BadManifest { reason: String },
    #[error("the release signature is not valid")]
    BadSignature,
    #[error("this release needs a newer version of the application to be read")]
    UnsupportedSchema,
    #[error("the release has no file for this platform")]
    NoPlatformAsset,
    #[error("this update must be installed manually (minimum version {minimum})")]
    ManualUpdateRequired { minimum: String },
    #[error("the download is larger than announced")]
    TooLarge,
    #[error("the downloaded file does not match the signed manifest")]
    HashMismatch,
    #[error("the downloaded file is not an executable")]
    NotExecutable,
    #[error("refused to follow a redirect to an unexpected address")]
    UnsafeRedirect,
    #[error("only https addresses are allowed")]
    InsecureUrl,
    #[error("no update is waiting to be installed")]
    NoPendingUpdate,
    #[error("there are unsaved changes")]
    UnsavedChanges,
    #[error("automatic installation is not available on this platform")]
    UnsupportedPlatform,
    #[error("the folder of the application is not writable")]
    NotWritable,
    #[error("the update could not be installed: {reason}")]
    InstallFailed { reason: String },
    #[error("i/o error: {message}")]
    Io { message: String },
}

impl UpdateError {
    /// Code stable utilisable par l'interface et les tests.
    pub fn code(&self) -> &'static str {
        match self {
            UpdateError::NotConfigured => "not_configured",
            UpdateError::InvalidRepository => "invalid_repository",
            UpdateError::InvalidChannel => "invalid_channel",
            UpdateError::InvalidToken => "invalid_token",
            UpdateError::RepositoryNotFound => "repository_not_found",
            UpdateError::Unauthorized => "unauthorized",
            UpdateError::RateLimited => "rate_limited",
            UpdateError::Network { .. } => "network",
            UpdateError::BadResponse => "bad_response",
            UpdateError::BadManifest { .. } => "bad_manifest",
            UpdateError::BadSignature => "bad_signature",
            UpdateError::UnsupportedSchema => "unsupported_schema",
            UpdateError::NoPlatformAsset => "no_platform_asset",
            UpdateError::ManualUpdateRequired { .. } => "manual_update_required",
            UpdateError::TooLarge => "too_large",
            UpdateError::HashMismatch => "hash_mismatch",
            UpdateError::NotExecutable => "not_executable",
            UpdateError::UnsafeRedirect => "unsafe_redirect",
            UpdateError::InsecureUrl => "insecure_url",
            UpdateError::NoPendingUpdate => "no_pending_update",
            UpdateError::UnsavedChanges => "unsaved_changes",
            UpdateError::UnsupportedPlatform => "unsupported_platform",
            UpdateError::NotWritable => "not_writable",
            UpdateError::InstallFailed { .. } => "install_failed",
            UpdateError::Io { .. } => "io",
        }
    }

    pub fn bad_manifest(reason: &str) -> Self {
        UpdateError::BadManifest { reason: reason.to_string() }
    }
}

impl From<std::io::Error> for UpdateError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            // Un dossier protege (Windows, ou `/usr/bin` d'un paquet sous Linux) ou un systeme de fichiers en lecture seule (distribution
            // immuable, squashfs) : l'utilisateur ne peut pas y remplacer l'application.
            std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::ReadOnlyFilesystem => UpdateError::NotWritable,
            _ => UpdateError::Io { message: error.kind().to_string() },
        }
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Error, ErrorKind};

    use super::*;

    #[test]
    fn a_folder_the_user_cannot_write_is_reported_as_such_and_other_failures_keep_a_coarse_kind() {
        for kind in [ErrorKind::PermissionDenied, ErrorKind::ReadOnlyFilesystem] {
            assert_eq!(UpdateError::from(Error::from(kind)), UpdateError::NotWritable, "{kind:?}");
        }
        assert_eq!(UpdateError::from(Error::from(ErrorKind::NotFound)), UpdateError::Io { message: "entity not found".to_string() });
    }
}
