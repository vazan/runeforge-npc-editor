use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use tempfile::NamedTempFile;

use crate::{protocol::Client, Comparison, Error, FileDigest, Preview, Result, Target, MAX_BYTES};

const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn compare(target: Target, files: Vec<(String, FileDigest)>) -> Result<Preview> {
    let executable = executable()?;
    let mut known_hosts = NamedTempFile::new().map_err(|_| Error::Unavailable)?;
    let host_pattern = if target.port == 22 {
        target.host.clone()
    } else {
        format!("[{}]:{}", target.host, target.port)
    };
    writeln!(known_hosts, "{host_pattern} ssh-ed25519 {}", target.key)
        .map_err(|_| Error::Unavailable)?;
    let mut command = command(&executable, &target, known_hosts.path())?;
    let mut child = command.spawn().map_err(|_| Error::Unavailable)?;
    let result = compare_child(&mut child, target, files);
    // Close the OpenSSH process before removing the pinned host key file.
    let _ = child.kill();
    let _ = child.wait();
    result
}

fn compare_child(
    child: &mut Child,
    target: Target,
    files: Vec<(String, FileDigest)>,
) -> Result<Preview> {
    let input = child.stdout.take().ok_or(Error::ConnectionFailed)?;
    let output = child.stdin.take().ok_or(Error::ConnectionFailed)?;
    let (send, receive) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("runeforge-sftp".into())
        .spawn(move || {
            let result = compare_streams(input, output, target, files);
            let _ = send.send(result);
        })
        .map_err(|_| Error::Unavailable)?;
    match receive.recv_timeout(TIMEOUT) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err(Error::TimedOut),
        Err(RecvTimeoutError::Disconnected) => Err(Error::ConnectionFailed),
    }
}

fn compare_streams(
    input: impl std::io::Read,
    output: impl Write,
    target: Target,
    files: Vec<(String, FileDigest)>,
) -> Result<Preview> {
    let mut client = Client::start(input, output)?;
    client.check_root(&target.directory)?;
    let mut remaining = MAX_BYTES;
    let mut comparisons = Vec::with_capacity(files.len());
    for (path, local) in files {
        let remote = client.file(&target.directory, &path, remaining)?;
        if let Some(file) = &remote {
            remaining -= file.size;
        }
        comparisons.push(Comparison {
            path,
            local,
            remote,
        });
    }
    Ok(Preview { files: comparisons })
}

#[cfg(windows)]
fn executable() -> Result<PathBuf> {
    let system_root = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or(Error::Unavailable)?;
    let path = system_root.join("System32").join("OpenSSH").join("ssh.exe");
    (path.is_absolute() && path.is_file())
        .then_some(path)
        .ok_or(Error::Unavailable)
}

#[cfg(not(windows))]
fn executable() -> Result<PathBuf> {
    ["/usr/bin/ssh", "/bin/ssh"]
        .into_iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .ok_or(Error::Unavailable)
}

fn quote_path(path: &Path) -> Result<String> {
    let path = path.to_str().ok_or(Error::Unavailable)?;
    #[cfg(windows)]
    let path = path.replace('\\', "/");
    if path
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '%' | '$' | '"' | '\\'))
    {
        return Err(Error::Unavailable);
    }
    Ok(format!("\"{path}\""))
}

pub(crate) fn command(executable: &Path, target: &Target, known_hosts: &Path) -> Result<Command> {
    let key_file = format!("UserKnownHostsFile={}", quote_path(known_hosts)?);
    let mut command = Command::new(executable);
    command
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .args(["-F", "none", "-s", "-T", "-x", "-a"]);
    for key in [
        "SystemRoot",
        "WINDIR",
        "HOME",
        "USERPROFILE",
        "SSH_AUTH_SOCK",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    for option in [
        "BatchMode=yes",
        "ConnectionAttempts=1",
        "ConnectTimeout=8",
        "StrictHostKeyChecking=yes",
        "GlobalKnownHostsFile=none",
        "HostKeyAlgorithms=ssh-ed25519",
        "UpdateHostKeys=no",
        "VerifyHostKeyDNS=no",
        "CheckHostIP=no",
        "ClearAllForwardings=yes",
        "PermitLocalCommand=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "IdentityFile=none",
        "PreferredAuthentications=publickey",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "GSSAPIAuthentication=no",
        "NumberOfPasswordPrompts=0",
        &key_file,
    ] {
        command.args(["-o", option]);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command.args([
        "-p",
        &target.port.to_string(),
        "-l",
        &target.username,
        "--",
        &target.host,
        "sftp",
    ]);
    Ok(command)
}
