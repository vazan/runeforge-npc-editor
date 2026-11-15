//! The read-only subset of SFTP v3 used for deployment previews.

use std::io::{Read, Write};

use sha2::{Digest, Sha256};

use crate::{Error, FileDigest, Result, MAX_FILE_BYTES};

const MAX_PACKET: usize = 256 * 1024;
const READ_CHUNK: u32 = 32 * 1024;
const SSH_FXP_STATUS: u8 = 101;
const SSH_FXP_HANDLE: u8 = 102;
const SSH_FXP_DATA: u8 = 103;
const SSH_FXP_NAME: u8 = 104;
const SSH_FXP_ATTRS: u8 = 105;
const SSH_FX_OK: u32 = 0;
const SSH_FX_EOF: u32 = 1;
const SSH_FX_NO_SUCH_FILE: u32 = 2;
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;

pub(crate) struct Client<R, W> {
    input: R,
    output: W,
    id: u32,
}

impl<R: Read, W: Write> Client<R, W> {
    pub(crate) fn start(input: R, output: W) -> Result<Self> {
        let mut client = Self {
            input,
            output,
            id: 0,
        };
        client
            .send(&[1, 0, 0, 0, 3])
            .map_err(|_| Error::ConnectionFailed)?;
        let packet = client.receive().map_err(|_| Error::ConnectionFailed)?;
        if !packet.starts_with(&[2, 0, 0, 0, 3]) {
            return Err(Error::UnsupportedProtocol);
        }
        Ok(client)
    }

    pub(crate) fn check_root(&mut self, directory: &str) -> Result<()> {
        if !self.check_directories(directory)? {
            return Err(Error::UnsafeRemotePath);
        }
        self.check_realpath(directory)
    }

    pub(crate) fn file(
        &mut self,
        directory: &str,
        path: &str,
        remaining: u64,
    ) -> Result<Option<FileDigest>> {
        let full_path = format!("{directory}/{path}");
        let (parent, _) = full_path.rsplit_once('/').ok_or(Error::UnsafeRemotePath)?;
        if !self.check_directories(parent)? {
            return Ok(None);
        }
        let Some(attrs) = self.lstat(&full_path)? else {
            return Ok(None);
        };
        let size = attrs.file_size()?;
        if size > remaining.min(MAX_FILE_BYTES) {
            return Err(Error::TooLarge);
        }
        self.check_realpath(&full_path)?;
        let mut args = string(full_path.as_bytes());
        args.extend_from_slice(&1u32.to_be_bytes()); // SSH_FXF_READ
        args.extend_from_slice(&0u32.to_be_bytes()); // no create attributes
        let opened = self.request(3, &args)?;
        let handle = opened.expect(SSH_FXP_HANDLE)?.string()?.to_vec();
        if handle.is_empty() || handle.len() > 256 {
            return Err(Error::RemoteRead);
        }
        let result = self.digest(&handle, attrs);
        let close = self
            .request(4, &string(&handle))
            .and_then(|reply| reply.require_status(SSH_FX_OK));
        result.and_then(|digest| close.map(|()| Some(digest)))
    }

    fn digest(&mut self, handle: &[u8], attrs: Attributes) -> Result<FileDigest> {
        let size = attrs.file_size()?;
        if self.fstat(handle)? != attrs {
            return Err(Error::RemoteRead);
        }
        let mut hash = Sha256::new();
        let mut offset = 0;
        loop {
            let want = (size - offset).clamp(1, u64::from(READ_CHUNK)) as u32;
            let mut args = string(handle);
            args.extend_from_slice(&offset.to_be_bytes());
            args.extend_from_slice(&want.to_be_bytes());
            let reply = self.request(5, &args)?;
            if offset == size {
                reply.require_status(SSH_FX_EOF)?;
                break;
            }
            let data = reply.expect(SSH_FXP_DATA)?.string()?;
            if data.is_empty() || data.len() > want as usize {
                return Err(Error::RemoteRead);
            }
            hash.update(data);
            offset += data.len() as u64;
        }
        if self.fstat(handle)? != attrs {
            return Err(Error::RemoteRead);
        }
        Ok(FileDigest {
            size,
            sha256: runeforge_filesystem::stat::to_hex(&hash.finalize()),
        })
    }

    fn lstat(&mut self, path: &str) -> Result<Option<Attributes>> {
        let reply = self.request(7, &string(path.as_bytes()))?;
        if reply.kind == SSH_FXP_STATUS && reply.status()? == SSH_FX_NO_SUCH_FILE {
            return Ok(None);
        }
        Attributes::parse(reply.expect(SSH_FXP_ATTRS)?).map(Some)
    }

    fn fstat(&mut self, handle: &[u8]) -> Result<Attributes> {
        let reply = self.request(8, &string(handle))?;
        Attributes::parse(reply.expect(SSH_FXP_ATTRS)?)
    }

    fn check_directories(&mut self, directory: &str) -> Result<bool> {
        for end in directory
            .match_indices('/')
            .map(|(index, _)| index)
            .skip(1)
            .chain(std::iter::once(directory.len()))
        {
            let Some(attrs) = self.lstat(&directory[..end])? else {
                return Ok(false);
            };
            if attrs.mode & S_IFMT != S_IFDIR {
                return Err(Error::UnsafeRemotePath);
            }
        }
        Ok(true)
    }

    fn check_realpath(&mut self, path: &str) -> Result<()> {
        let reply = self.request(16, &string(path.as_bytes()))?;
        let mut name = reply.expect(SSH_FXP_NAME)?;
        if name.u32()? != 1 || name.string()? != path.as_bytes() {
            return Err(Error::UnsafeRemotePath);
        }
        Ok(())
    }

    fn request(&mut self, kind: u8, args: &[u8]) -> Result<Reply> {
        self.id = self.id.checked_add(1).ok_or(Error::RemoteRead)?;
        let mut request = vec![kind];
        request.extend_from_slice(&self.id.to_be_bytes());
        request.extend_from_slice(args);
        self.send(&request)?;
        let packet = self.receive()?;
        let mut header = Bytes(&packet);
        let kind = header.take(1)?[0];
        if header.u32()? != self.id {
            return Err(Error::RemoteRead);
        }
        Ok(Reply {
            kind,
            payload: packet,
        })
    }

    fn send(&mut self, bytes: &[u8]) -> Result<()> {
        self.output
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .map_err(|_| Error::RemoteRead)?;
        self.output
            .write_all(bytes)
            .map_err(|_| Error::RemoteRead)?;
        self.output.flush().map_err(|_| Error::RemoteRead)
    }

    fn receive(&mut self) -> Result<Vec<u8>> {
        let mut size = [0; 4];
        self.input
            .read_exact(&mut size)
            .map_err(|_| Error::RemoteRead)?;
        let size = u32::from_be_bytes(size) as usize;
        if !(1..=MAX_PACKET).contains(&size) {
            return Err(Error::RemoteRead);
        }
        let mut packet = vec![0; size];
        self.input
            .read_exact(&mut packet)
            .map_err(|_| Error::RemoteRead)?;
        Ok(packet)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Attributes {
    mode: u32,
    size: Option<u64>,
    modified: Option<u32>,
}

impl Attributes {
    fn parse(mut bytes: Bytes<'_>) -> Result<Self> {
        let flags = bytes.u32()?;
        if flags & !0x8000_000f != 0 {
            return Err(Error::RemoteRead);
        }
        let size = if flags & 1 == 0 {
            None
        } else {
            Some(u64::from_be_bytes(
                bytes.take(8)?.try_into().map_err(|_| Error::RemoteRead)?,
            ))
        };
        if flags & 2 != 0 {
            bytes.take(8)?; // uid, gid
        }
        if flags & 4 == 0 {
            return Err(Error::UnsafeRemotePath);
        }
        let mode = bytes.u32()?;
        let modified = if flags & 8 == 0 {
            None
        } else {
            bytes.u32()?; // access time can change during this read
            Some(bytes.u32()?)
        };
        Ok(Self {
            mode,
            size,
            modified,
        })
    }

    fn file_size(self) -> Result<u64> {
        if self.mode & S_IFMT != S_IFREG {
            return Err(Error::UnsafeRemotePath);
        }
        self.size.ok_or(Error::RemoteRead)
    }
}

struct Reply {
    kind: u8,
    payload: Vec<u8>,
}

impl Reply {
    fn expect(&self, kind: u8) -> Result<Bytes<'_>> {
        if self.kind != kind {
            return Err(Error::RemoteRead);
        }
        Ok(Bytes(&self.payload[5..]))
    }

    fn status(&self) -> Result<u32> {
        let mut status = self.expect(SSH_FXP_STATUS)?;
        let code = status.u32()?;
        status.string()?;
        status.string()?;
        Ok(code)
    }

    fn require_status(&self, code: u32) -> Result<()> {
        if self.status()? != code {
            return Err(Error::RemoteRead);
        }
        Ok(())
    }
}

fn string(bytes: &[u8]) -> Vec<u8> {
    let mut result = (bytes.len() as u32).to_be_bytes().to_vec();
    result.extend_from_slice(bytes);
    result
}

struct Bytes<'a>(&'a [u8]);

impl<'a> Bytes<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let (head, tail) = self.0.split_at_checked(count).ok_or(Error::RemoteRead)?;
        self.0 = tail;
        Ok(head)
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(
            self.take(4)?.try_into().map_err(|_| Error::RemoteRead)?,
        ))
    }

    fn string(&mut self) -> Result<&'a [u8]> {
        let count = self.u32()? as usize;
        self.take(count)
    }
}
