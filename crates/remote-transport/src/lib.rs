//! Read-only SFTP deployment previews. A caller must obtain consent for the exact target before calling `preview`.

mod openssh;
mod protocol;

use std::collections::HashSet;
use std::net::IpAddr;

use base64::{engine::general_purpose, Engine};
use runeforge_filesystem::{path_guard::normalize_key, read_file, RootRegistry};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_FILES: usize = 100;
const MAX_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum Error {
    InvalidTarget,
    InvalidPaths,
    LocalRead,
    TooLarge,
    Unavailable,
    ConnectionFailed,
    TimedOut,
    UnsupportedProtocol,
    RemoteRead,
    UnsafeRemotePath,
    Busy,
    Cancelled,
}

type Result<T> = std::result::Result<T, Error>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetInput {
    host: String,
    port: u16,
    username: String,
    host_key: String,
    directory: String,
}

/// An exact host, directory and pinned public key. A config file cannot grant consent.
pub struct Target {
    host: String,
    port: u16,
    username: String,
    key: String,
    fingerprint: String,
    directory: String,
}

impl Target {
    pub fn parse(input: TargetInput) -> Result<Self> {
        if !valid_host(&input.host)
            || input.port == 0
            || input.username.len() > 64
            || !input
                .username
                .as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            || !input
                .username
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(Error::InvalidTarget);
        }
        let Some(directory) = input.directory.strip_prefix('/') else {
            return Err(Error::InvalidTarget);
        };
        if !directory.is_ascii() || directory.contains('\\') || normalize_key(directory).is_err() {
            return Err(Error::InvalidTarget);
        }
        let Some(key) = input.host_key.strip_prefix("ssh-ed25519 ") else {
            return Err(Error::InvalidTarget);
        };
        if key.len() != 68 {
            return Err(Error::InvalidTarget);
        }
        let decoded = general_purpose::STANDARD
            .decode(key)
            .map_err(|_| Error::InvalidTarget)?;
        if decoded.len() != 51
            || !decoded.starts_with(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20")
        {
            return Err(Error::InvalidTarget);
        }
        Ok(Self {
            host: input.host.to_ascii_lowercase(),
            port: input.port,
            username: input.username,
            fingerprint: general_purpose::STANDARD_NO_PAD.encode(Sha256::digest(decoded)),
            key: key.to_owned(),
            directory: input.directory,
        })
    }

    pub fn confirmation(&self) -> String {
        format!(
            "{}@{} (port {})\n{}\nSHA256:{}",
            self.username, self.host, self.port, self.directory, self.fingerprint
        )
    }
}

fn valid_host(host: &str) -> bool {
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    host.len() <= 253
        && host.split('.').all(|label| {
            label.len() <= 63
                && label
                    .as_bytes()
                    .first()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .as_bytes()
                    .last()
                    .is_some_and(u8::is_ascii_alphanumeric)
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDigest {
    size: u64,
    sha256: String,
}

#[derive(Serialize)]
pub struct Comparison {
    path: String,
    local: FileDigest,
    remote: Option<FileDigest>,
}

#[derive(Serialize)]
pub struct Preview {
    files: Vec<Comparison>,
}

/// Reads and hashes local inputs before network access. A missing or oversized input aborts the preview.
pub fn preview(
    target: Target,
    roots: &RootRegistry,
    root_id: &str,
    paths: Vec<String>,
) -> Result<Preview> {
    let local = read_local(roots, root_id, paths)?;
    openssh::compare(target, local)
}

fn read_local(
    roots: &RootRegistry,
    root_id: &str,
    paths: Vec<String>,
) -> Result<Vec<(String, FileDigest)>> {
    let paths = validate_paths(paths)?;
    let mut remaining = MAX_BYTES;
    paths
        .into_iter()
        .map(|path| {
            let limit = remaining.min(MAX_FILE_BYTES);
            let file = read_file(roots, root_id, &path, limit).map_err(|error| match error {
                runeforge_filesystem::FsError::TooLarge { .. } => Error::TooLarge,
                _ => Error::LocalRead,
            })?;
            remaining -= file.stat.size;
            Ok((
                path,
                FileDigest {
                    size: file.stat.size,
                    sha256: file.stat.sha256,
                },
            ))
        })
        .collect()
}

fn validate_paths(paths: Vec<String>) -> Result<Vec<String>> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(Error::InvalidPaths);
    }
    let mut seen = HashSet::new();
    paths
        .into_iter()
        .map(|path| {
            let canonical = normalize_key(&path).map_err(|_| Error::InvalidPaths)?;
            let is_script = canonical
                .rsplit_once('.')
                .is_some_and(|(_, suffix)| suffix.eq_ignore_ascii_case("txt"));
            let app_directory = canonical
                .split('/')
                .next()
                .is_some_and(|part| part.eq_ignore_ascii_case(".runeforge"));
            if path != canonical || app_directory || !is_script || !seen.insert(path.clone()) {
                return Err(Error::InvalidPaths);
            }
            Ok(path)
        })
        .collect()
}

#[cfg(test)]
mod tests;
