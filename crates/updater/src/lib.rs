//! Mises a jour signees de RuneForge Studio (DEC-046).
//!
//! Le principe : l'editeur signe, avec une cle privee qu'il garde, un **manifeste** de release (version, empreinte SHA-256 et taille
//! de l'executable). L'application embarque la **cle publique** ; elle ne telecharge et n'installe que ce que ce manifeste, verifie,
//! decrit. Le depot Git (prive ou non), son hebergeur et le reseau sont donc des transports non fiables : au pire, ils peuvent
//! empecher une mise a jour, jamais en imposer une.
//!
//! Modules : `error`, `version` (semver, canaux), `manifest` (format et validation), `verify` (signature minisign), `release` (releases
//! GitHub), `transport` et `client` (politique reseau), `ureq_transport` (HTTP reel), `update` (verification et telechargement),
//! `platform` (Windows et Linux : format d'executable attendu), `install` (remplacement de l'executable, retour arriere).

pub mod client;
pub mod error;
pub mod install;
pub mod manifest;
pub mod platform;
pub mod release;
pub mod transport;
pub mod update;
pub mod ureq_transport;
pub mod verify;
pub mod version;

pub use client::{Client, HostPolicy, GITHUB_API};
pub use error::UpdateError;
pub use platform::{supports_install, ExecutableKind};
pub use semver::Version;
pub use update::{check, download, CheckOutcome, UpdateConfig, VerifiedUpdate};
pub use ureq_transport::UreqTransport;
pub use version::Channel;
