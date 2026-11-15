//! Transport reel : `ureq` avec la pile TLS de Windows (schannel via `native-tls`) et le magasin de certificats du systeme.

use std::io::{Read, Write};
use std::time::Duration;

use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

use crate::error::UpdateError;
use crate::transport::{RawResponse, Request, Transport};

/// Reponses courtes (API, manifeste, signature) : delai global de l'echange.
const SHORT_TIMEOUT: Duration = Duration::from_secs(30);
/// Fichiers de release (une vingtaine de Mio) : delai global d'un telechargement.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Au-dela de cette taille attendue, on applique `DOWNLOAD_TIMEOUT`.
const SHORT_LIMIT: u64 = 4 * 1024 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Delai sans recevoir un octet : un serveur qui se tait ne fige pas l'application.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
const CHUNK: usize = 64 * 1024;

pub struct UreqTransport {
    agent: ureq::Agent,
}

impl UreqTransport {
    /// `https_only` : refuse tout `http://` (la production ; faux seulement pour l'API locale des tests).
    pub fn new(user_agent: &str, https_only: bool) -> Self {
        // TLS du systeme, explicitement : le fournisseur par defaut de `ureq` n'est pas celui-la et n'est jamais choisi seul.
        let tls = TlsConfig::builder().provider(TlsProvider::NativeTls).root_certs(RootCerts::PlatformVerifier).build();
        let config = ureq::Agent::config_builder()
            .tls_config(tls)
            .https_only(https_only)
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent(user_agent)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(STALL_TIMEOUT))
            .timeout_per_read(Some(STALL_TIMEOUT))
            .build();
        Self { agent: ureq::Agent::new_with_config(config) }
    }
}

/// Raison grossiere d'un echec reseau : aucun detail (adresse, message du systeme) ne remonte.
fn network_kind(error: &ureq::Error) -> &'static str {
    match error {
        ureq::Error::Timeout(_) => "timeout",
        ureq::Error::HostNotFound => "dns",
        ureq::Error::Tls(_) | ureq::Error::NativeTls(_) => "tls",
        ureq::Error::Io(_) | ureq::Error::ConnectionFailed => "connection",
        _ => "network",
    }
}

impl Transport for UreqTransport {
    fn execute(
        &self,
        request: &Request<'_>,
        sink: &mut dyn Write,
        limit: u64,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<RawResponse, UpdateError> {
        let timeout = if limit > SHORT_LIMIT { DOWNLOAD_TIMEOUT } else { SHORT_TIMEOUT };
        let mut builder = self.agent.get(request.url).header("Accept", request.accept).header("X-GitHub-Api-Version", "2022-11-28");
        if let Some(token) = request.bearer {
            builder = builder.header("Authorization", format!("Bearer {token}"));
        }
        let response = builder.config().timeout_global(Some(timeout)).build().call().map_err(|error| UpdateError::Network { kind: network_kind(&error).to_string() })?;

        let status = response.status().as_u16();
        let header = |name: &str| response.headers().get(name).and_then(|value| value.to_str().ok()).map(str::to_string);
        let raw = RawResponse {
            status,
            location: header("location"),
            content_length: header("content-length").and_then(|text| text.parse().ok()),
            rate_limit_remaining: header("x-ratelimit-remaining").and_then(|text| text.parse().ok()),
        };
        if !(200..300).contains(&status) {
            return Ok(raw);
        }
        if raw.content_length.is_some_and(|length| length > limit) {
            return Err(UpdateError::TooLarge);
        }
        let mut reader = response.into_body().into_reader();
        let mut buffer = vec![0u8; CHUNK];
        let mut received: u64 = 0;
        loop {
            let read = reader.read(&mut buffer).map_err(|error| match error.kind() {
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => UpdateError::Network { kind: "timeout".to_string() },
                _ => UpdateError::Network { kind: "connection".to_string() },
            })?;
            if read == 0 {
                return Ok(raw);
            }
            received += read as u64;
            if received > limit {
                return Err(UpdateError::TooLarge);
            }
            sink.write_all(&buffer[..read])?;
            progress(received, raw.content_length);
        }
    }
}
