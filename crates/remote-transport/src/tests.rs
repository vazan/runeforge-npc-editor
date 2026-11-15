use std::{io::Cursor, path::Path};

use super::*;

fn target() -> TargetInput {
    let mut public_key = b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20".to_vec();
    public_key.extend([42; 32]);
    TargetInput {
        host: "Server.example".into(),
        port: 2222,
        username: "preview-user".into(),
        host_key: format!(
            "ssh-ed25519 {}",
            general_purpose::STANDARD.encode(public_key)
        ),
        directory: "/server/target".into(),
    }
}

#[test]
fn target_is_literal_and_key_is_pinned() {
    let parsed = Target::parse(target()).unwrap();
    assert!(parsed
        .confirmation()
        .starts_with("preview-user@server.example (port 2222)\n/server/target\nSHA256:"));
    for host in [
        "",
        "-oProxyCommand",
        "host\nsecond",
        "host other",
        "a..example",
        "user@host",
        "*.example",
        "[::1]",
    ] {
        assert!(matches!(
            Target::parse(TargetInput {
                host: host.into(),
                ..target()
            }),
            Err(Error::InvalidTarget)
        ));
    }
    for username in ["", "-f", "user@other", "user with space", "u\nser"] {
        assert!(matches!(
            Target::parse(TargetInput {
                username: username.into(),
                ..target()
            }),
            Err(Error::InvalidTarget)
        ));
    }
    for directory in [
        "/",
        "relative",
        "/a/../b",
        "/a//b",
        "/a\\b",
        "/a\u{202e}txt",
    ] {
        assert!(matches!(
            Target::parse(TargetInput {
                directory: directory.into(),
                ..target()
            }),
            Err(Error::InvalidTarget)
        ));
    }
    for host_key in [
        "",
        "ssh-ed25519 invalid",
        "ssh-rsa AAAA",
        "ssh-ed25519 AAAA\nanything",
    ] {
        assert!(matches!(
            Target::parse(TargetInput {
                host_key: host_key.into(),
                ..target()
            }),
            Err(Error::InvalidTarget)
        ));
    }
}

#[test]
fn command_uses_fixed_read_only_subsystem_and_pinned_host_file() {
    let parsed = Target::parse(target()).unwrap();
    let command = openssh::command(
        Path::new("ssh"),
        &parsed,
        Path::new("/path with spaces/pin"),
    )
    .unwrap();
    let args: Vec<_> = command
        .get_args()
        .map(|arg| arg.to_string_lossy())
        .collect();
    assert_eq!(args[..6], ["-F", "none", "-s", "-T", "-x", "-a"]);
    for expected in [
        "UserKnownHostsFile=\"/path with spaces/pin\"",
        "StrictHostKeyChecking=yes",
        "GlobalKnownHostsFile=none",
        "UpdateHostKeys=no",
        "HostKeyAlgorithms=ssh-ed25519",
        "ProxyCommand=none",
        "IdentityFile=none",
        "PasswordAuthentication=no",
    ] {
        assert!(args.iter().any(|arg| arg == expected));
    }
    assert_eq!(
        args[args.len() - 7..],
        [
            "-p",
            "2222",
            "-l",
            "preview-user",
            "--",
            "server.example",
            "sftp"
        ]
    );
    assert!(openssh::command(Path::new("ssh"), &parsed, Path::new("/unsafe/%h")).is_err());
    assert!(openssh::command(Path::new("ssh"), &parsed, Path::new("/unsafe/${HOME}")).is_err());
}

#[test]
fn script_paths_are_bounded_canonical_and_unique() {
    let paths = |paths: &[&str]| validate_paths(paths.iter().map(|path| (*path).into()).collect());
    assert!(paths(&["npc/cities/é.TXT", "npc/two words.txt"]).is_ok());
    for invalid in [
        "../a.txt",
        "npc\\a.txt",
        "npc/a.yml",
        "/npc/a.txt",
        ".RuneForge/a.txt",
        "npc/a.txt:secret",
    ] {
        assert_eq!(paths(&[invalid]), Err(Error::InvalidPaths));
    }
    assert_eq!(paths(&["npc/a.txt", "npc/a.txt"]), Err(Error::InvalidPaths));
    assert_eq!(paths(&[]), Err(Error::InvalidPaths));
}

fn frame(payload: &[u8]) -> Vec<u8> {
    let mut frame = (payload.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(payload);
    frame
}

fn string(data: &[u8]) -> Vec<u8> {
    frame(data)
}

fn packet(kind: u8, id: u32, data: &[u8]) -> Vec<u8> {
    let mut payload = vec![kind];
    payload.extend_from_slice(&id.to_be_bytes());
    payload.extend_from_slice(data);
    frame(&payload)
}

fn attrs(id: u32, mode: u32, size: u64) -> Vec<u8> {
    let mut value = 5u32.to_be_bytes().to_vec(); // size and permissions
    value.extend_from_slice(&size.to_be_bytes());
    value.extend_from_slice(&mode.to_be_bytes());
    packet(105, id, &value)
}

fn realpath(id: u32, path: &str) -> Vec<u8> {
    let mut names = 1u32.to_be_bytes().to_vec();
    names.extend(string(path.as_bytes()));
    names.extend(string(b""));
    names.extend(0u32.to_be_bytes()); // no name attributes
    packet(104, id, &names)
}

fn status(id: u32, code: u32) -> Vec<u8> {
    let mut data = code.to_be_bytes().to_vec();
    data.extend([0; 8]); // empty description and language
    packet(101, id, &data)
}

#[test]
fn preview_reads_and_hashes_only_a_regular_file() {
    let mut input = frame(&[2, 0, 0, 0, 3]);
    input.extend(attrs(1, 0o040755, 0));
    input.extend(realpath(2, "/root"));
    input.extend(attrs(3, 0o040755, 0));
    input.extend(attrs(4, 0o100644, 3));
    input.extend(realpath(5, "/root/a.txt"));
    input.extend(packet(102, 6, &string(b"handle")));
    input.extend(attrs(7, 0o100644, 3));
    input.extend(packet(103, 8, &string(b"abc")));
    input.extend(status(9, 1));
    input.extend(attrs(10, 0o100644, 3));
    input.extend(status(11, 0));
    let mut sent = Vec::new();
    let mut client = protocol::Client::start(Cursor::new(input), &mut sent).unwrap();
    client.check_root("/root").unwrap();
    let digest = client.file("/root", "a.txt", MAX_BYTES).unwrap().unwrap();
    assert_eq!(digest.size, 3);
    assert_eq!(digest.sha256, runeforge_filesystem::sha256_hex(b"abc"));
    let mut request = sent.as_slice();
    let mut kinds = Vec::new();
    while !request.is_empty() {
        let size = u32::from_be_bytes(request[..4].try_into().unwrap()) as usize;
        kinds.push(request[4]);
        if request[4] == 3 {
            assert_eq!(&request[size - 4..size], &1u32.to_be_bytes()); // SSH_FXF_READ, no write flags
        }
        request = &request[4 + size..];
    }
    assert_eq!(kinds, [1, 7, 16, 7, 7, 16, 3, 8, 5, 5, 8, 4]);
}

#[test]
fn absence_is_distinct_from_denied_symlink_changed_path_and_size_limit() {
    let read = |replies: Vec<u8>| {
        let mut input = frame(&[2, 0, 0, 0, 3]);
        input.extend(attrs(1, 0o040755, 0));
        input.extend(replies);
        protocol::Client::start(Cursor::new(input), Vec::new())
            .unwrap()
            .file("/root", "a.txt", MAX_BYTES)
    };
    assert!(matches!(read(status(2, 2)), Ok(None)));
    assert!(matches!(read(status(2, 3)), Err(Error::RemoteRead)));
    assert!(matches!(
        read(attrs(2, 0o120777, 0)),
        Err(Error::UnsafeRemotePath)
    ));
    assert!(matches!(
        read(attrs(2, 0o100644, MAX_FILE_BYTES + 1)),
        Err(Error::TooLarge)
    ));
    let mut changed_path = attrs(2, 0o100644, 3);
    changed_path.extend(realpath(3, "/outside/a.txt"));
    assert!(matches!(read(changed_path), Err(Error::UnsafeRemotePath)));
}

#[test]
fn rejects_malformed_oversized_and_mismatched_packets() {
    let unsupported = protocol::Client::start(Cursor::new(frame(&[2, 0, 0, 0, 4])), Vec::new());
    assert!(matches!(unsupported, Err(Error::UnsupportedProtocol)));
    let mut input = frame(&[2, 0, 0, 0, 3]);
    input.extend(u32::MAX.to_be_bytes());
    let mut client = protocol::Client::start(Cursor::new(input), Vec::new()).unwrap();
    assert_eq!(client.check_root("/root"), Err(Error::RemoteRead));
    let mut input = frame(&[2, 0, 0, 0, 3]);
    input.extend(attrs(2, 0o040755, 0)); // expected request ID 1
    let mut client = protocol::Client::start(Cursor::new(input), Vec::new()).unwrap();
    assert_eq!(client.check_root("/root"), Err(Error::RemoteRead));
}
