//! Politique reseau : quels hotes, quelles redirections, a qui le jeton est envoye.
//!
//! Regles (DEC-046) :
//! - la premiere requete va a l'API de GitHub (`https://api.github.com`), en HTTPS, et **elle seule** porte le jeton ;
//! - une redirection (le telechargement d'un fichier de release repond 302 vers un stockage signe) n'est suivie que vers HTTPS et
//!   `github.com`, `api.github.com` ou `*.githubusercontent.com`, au plus `MAX_REDIRECTS` fois, **sans jamais renvoyer le jeton** ;
//! - une adresse avec identifiants (`user:pass@hote`) ou relative est refusee.
//!
//! Seule exception, pour les tests et la construction E2E : une API locale `http://127.0.0.1:<port>` (`allow_loopback`).

use std::io::Write;

use ureq::http::Uri;

use crate::error::UpdateError;
use crate::transport::{Request, Transport};

pub const GITHUB_API: &str = "https://api.github.com";
const MAX_REDIRECTS: usize = 5;

/// Ou le client a le droit d'aller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostPolicy {
    Github,
    /// Tests et construction E2E seulement : `http://127.0.0.1:<port>`, pour la requete et ses redirections.
    Loopback { port: u16 },
}

struct Target {
    https: bool,
    host: String,
    port: Option<u16>,
}

fn parse_target(url: &str) -> Result<Target, UpdateError> {
    let uri: Uri = url.parse().map_err(|_| UpdateError::UnsafeRedirect)?;
    let authority = uri.authority().ok_or(UpdateError::UnsafeRedirect)?;
    if authority.as_str().contains('@') {
        return Err(UpdateError::UnsafeRedirect);
    }
    let https = match uri.scheme_str() {
        Some("https") => true,
        Some("http") => false,
        _ => return Err(UpdateError::UnsafeRedirect),
    };
    Ok(Target { https, host: authority.host().to_ascii_lowercase(), port: authority.port_u16() })
}

impl HostPolicy {
    /// Politique d'une adresse de base d'API : GitHub, ou (si `allow_loopback`) une API locale de test.
    pub fn for_api_base(api_base: &str, allow_loopback: bool) -> Result<Self, UpdateError> {
        if api_base == GITHUB_API {
            return Ok(HostPolicy::Github);
        }
        if allow_loopback {
            if let Some(port) = api_base.strip_prefix("http://127.0.0.1:").and_then(|rest| rest.parse::<u16>().ok()) {
                return Ok(HostPolicy::Loopback { port });
            }
        }
        Err(UpdateError::InsecureUrl)
    }

    /// La premiere requete : l'API, et seulement elle.
    fn allows_origin(&self, target: &Target) -> bool {
        match self {
            HostPolicy::Github => target.https && target.host == "api.github.com" && matches!(target.port, None | Some(443)),
            HostPolicy::Loopback { port } => !target.https && target.host == "127.0.0.1" && target.port == Some(*port),
        }
    }

    /// Une redirection : le stockage des fichiers de release de GitHub, jamais un autre hote.
    fn allows_redirect(&self, target: &Target) -> bool {
        match self {
            HostPolicy::Github => {
                target.https
                    && matches!(target.port, None | Some(443))
                    && (target.host == "api.github.com" || target.host == "github.com" || target.host.ends_with(".githubusercontent.com"))
            }
            HostPolicy::Loopback { .. } => self.allows_origin(target),
        }
    }
}

fn map_status(status: u16, rate_limit_remaining: Option<u64>) -> UpdateError {
    match status {
        401 => UpdateError::Unauthorized,
        403 if rate_limit_remaining == Some(0) => UpdateError::RateLimited,
        403 => UpdateError::Unauthorized,
        404 => UpdateError::RepositoryNotFound,
        429 => UpdateError::RateLimited,
        other => UpdateError::Network { kind: format!("status:{other}") },
    }
}

pub struct Client<T: Transport> {
    transport: T,
    policy: HostPolicy,
}

impl<T: Transport> Client<T> {
    pub fn new(transport: T, policy: HostPolicy) -> Self {
        Self { transport, policy }
    }

    /// Le transport sous-jacent (les tests y relisent ce qui a ete envoye).
    pub fn transport(&self) -> &T {
        &self.transport
    }

    /// Lit une reponse courte en memoire (au plus `limit` octets).
    pub fn get_bytes(&self, url: &str, token: Option<&str>, accept: &str, limit: u64) -> Result<Vec<u8>, UpdateError> {
        let mut body = Vec::new();
        self.get_to(url, token, accept, &mut body, limit, &mut |_, _| {})?;
        Ok(body)
    }

    /// Ecrit la reponse dans `sink` (au plus `limit` octets), en suivant les redirections permises.
    pub fn get_to(
        &self,
        url: &str,
        token: Option<&str>,
        accept: &str,
        sink: &mut dyn Write,
        limit: u64,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<(), UpdateError> {
        let mut current = url.to_string();
        let mut first = true;
        for _ in 0..=MAX_REDIRECTS {
            let target = parse_target(&current)?;
            let allowed = if first { self.policy.allows_origin(&target) } else { self.policy.allows_redirect(&target) };
            if !allowed {
                return Err(if first { UpdateError::InsecureUrl } else { UpdateError::UnsafeRedirect });
            }
            let request = Request { url: &current, bearer: if first { token } else { None }, accept };
            let response = self.transport.execute(&request, sink, limit, progress)?;
            match response.status {
                200..=299 => return Ok(()),
                301 | 302 | 303 | 307 | 308 => {
                    current = response.location.ok_or(UpdateError::BadResponse)?;
                    first = false;
                }
                status => return Err(map_status(status, response.rate_limit_remaining)),
            }
        }
        Err(UpdateError::UnsafeRedirect)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::transport::RawResponse;

    #[derive(Default)]
    struct Recorded {
        url: String,
        bearer: Option<String>,
    }

    /// Transport simule : repond selon une table d'adresses et note ce qu'on lui envoie.
    struct Fake {
        routes: Vec<(String, RawResponse, Vec<u8>)>,
        seen: Mutex<Vec<Recorded>>,
    }

    impl Fake {
        fn new(routes: Vec<(&str, RawResponse, &[u8])>) -> Self {
            Self { routes: routes.into_iter().map(|(url, response, body)| (url.to_string(), response, body.to_vec())).collect(), seen: Mutex::new(Vec::new()) }
        }
    }

    impl Transport for Fake {
        fn execute(&self, request: &Request<'_>, sink: &mut dyn Write, limit: u64, progress: &mut dyn FnMut(u64, Option<u64>)) -> Result<RawResponse, UpdateError> {
            self.seen.lock().unwrap().push(Recorded { url: request.url.to_string(), bearer: request.bearer.map(str::to_string) });
            let (_, response, body) = self.routes.iter().find(|(url, _, _)| url == request.url).ok_or(UpdateError::Network { kind: "connection".into() })?;
            if (200..300).contains(&response.status) {
                if body.len() as u64 > limit {
                    return Err(UpdateError::TooLarge);
                }
                sink.write_all(body)?;
                progress(body.len() as u64, Some(body.len() as u64));
            }
            Ok(response.clone())
        }
    }

    fn ok() -> RawResponse {
        RawResponse { status: 200, ..RawResponse::default() }
    }

    fn redirect(to: &str) -> RawResponse {
        RawResponse { status: 302, location: Some(to.to_string()), ..RawResponse::default() }
    }

    fn github(fake: Fake) -> Client<Fake> {
        Client::new(fake, HostPolicy::Github)
    }

    const API: &str = "https://api.github.com/repos/o/r/releases/assets/7";
    const CDN: &str = "https://release-assets.githubusercontent.com/signed/abc";

    #[test]
    fn the_token_goes_to_the_api_only_never_to_the_redirected_storage() {
        let client = github(Fake::new(vec![(API, redirect(CDN), b""), (CDN, ok(), b"payload")]));
        let bytes = client.get_bytes(API, Some("secret"), "application/octet-stream", 100).unwrap();
        assert_eq!(bytes, b"payload");
        let seen = client.transport.seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!((seen[0].url.as_str(), seen[0].bearer.as_deref()), (API, Some("secret")));
        assert_eq!((seen[1].url.as_str(), seen[1].bearer.as_deref()), (CDN, None));
    }

    #[test]
    fn refuses_a_first_request_that_is_not_the_https_api() {
        for url in [
            "http://api.github.com/repos/o/r/releases",
            "https://evil.example/repos/o/r/releases",
            "https://api.github.com.evil.example/repos",
            "https://user:pw@api.github.com/repos",
            "https://api.github.com:8443/repos",
            "/relative/path",
            "ftp://api.github.com/x",
        ] {
            let client = github(Fake::new(vec![]));
            let result = client.get_bytes(url, Some("t"), "x", 10);
            assert!(matches!(result, Err(UpdateError::InsecureUrl) | Err(UpdateError::UnsafeRedirect)), "{url}: {result:?}");
            assert!(client.transport.seen.lock().unwrap().is_empty(), "nothing is sent to {url}");
        }
    }

    #[test]
    fn refuses_a_redirect_to_another_host_a_plain_http_address_or_a_lookalike() {
        for target in [
            "https://evil.example/file",
            "http://release-assets.githubusercontent.com/file",
            "https://githubusercontent.com.evil.example/file",
            "https://evilgithubusercontent.com/file",
            "https://user:pw@objects.githubusercontent.com/file",
            "https://objects.githubusercontent.com:444/file",
            "file.exe",
        ] {
            let client = github(Fake::new(vec![(API, redirect(target), b"")]));
            assert_eq!(client.get_bytes(API, Some("t"), "x", 10), Err(UpdateError::UnsafeRedirect), "{target}");
            assert_eq!(client.transport.seen.lock().unwrap().len(), 1, "the redirected address is never requested: {target}");
        }
    }

    #[test]
    fn follows_a_few_redirects_but_not_a_loop() {
        let looping = github(Fake::new(vec![(API, redirect(CDN), b""), (CDN, redirect(API), b"")]));
        assert_eq!(looping.get_bytes(API, None, "x", 10), Err(UpdateError::UnsafeRedirect));
        // Cinq redirections suivies (donc six requetes), puis le refus : le budget est celui que la documentation annonce, pas la constante.
        assert_eq!(MAX_REDIRECTS, 5);
        assert_eq!(looping.transport.seen.lock().unwrap().len(), 6);
        let missing_location = github(Fake::new(vec![(API, RawResponse { status: 302, ..RawResponse::default() }, b"")]));
        assert_eq!(missing_location.get_bytes(API, None, "x", 10), Err(UpdateError::BadResponse));
    }

    #[test]
    fn maps_http_statuses_to_stable_errors() {
        let status = |code: u16, remaining: Option<u64>| {
            let client = github(Fake::new(vec![(API, RawResponse { status: code, rate_limit_remaining: remaining, ..RawResponse::default() }, b"")]));
            client.get_bytes(API, Some("t"), "x", 10)
        };
        assert_eq!(status(401, None), Err(UpdateError::Unauthorized));
        assert_eq!(status(403, None), Err(UpdateError::Unauthorized));
        assert_eq!(status(403, Some(0)), Err(UpdateError::RateLimited));
        assert_eq!(status(404, None), Err(UpdateError::RepositoryNotFound));
        assert_eq!(status(429, None), Err(UpdateError::RateLimited));
        assert_eq!(status(500, None), Err(UpdateError::Network { kind: "status:500".into() }));
    }

    #[test]
    fn enforces_the_size_limit_and_reports_progress() {
        let client = github(Fake::new(vec![(API, ok(), b"0123456789")]));
        assert_eq!(client.get_bytes(API, None, "x", 5), Err(UpdateError::TooLarge));
        let mut sink = Vec::new();
        let mut last = (0, None);
        client.get_to(API, None, "x", &mut sink, 10, &mut |done, total| last = (done, total)).unwrap();
        assert_eq!((sink.len(), last), (10, (10, Some(10))));
    }

    #[test]
    fn only_the_github_api_or_a_local_test_api_is_a_valid_base() {
        assert_eq!(HostPolicy::for_api_base("https://api.github.com", false), Ok(HostPolicy::Github));
        assert_eq!(HostPolicy::for_api_base("https://api.github.com/", false), Err(UpdateError::InsecureUrl));
        assert_eq!(HostPolicy::for_api_base("https://github.example.com/api/v3", false), Err(UpdateError::InsecureUrl));
        assert_eq!(HostPolicy::for_api_base("http://127.0.0.1:8080", false), Err(UpdateError::InsecureUrl));
        assert_eq!(HostPolicy::for_api_base("http://127.0.0.1:8080", true), Ok(HostPolicy::Loopback { port: 8080 }));
        assert_eq!(HostPolicy::for_api_base("http://localhost:8080", true), Err(UpdateError::InsecureUrl));
        assert_eq!(HostPolicy::for_api_base("http://127.0.0.1:x", true), Err(UpdateError::InsecureUrl));
    }

    #[test]
    fn a_local_test_api_accepts_only_its_own_origin() {
        let base = "http://127.0.0.1:9000";
        let client = Client::new(Fake::new(vec![("http://127.0.0.1:9000/a", redirect("http://127.0.0.1:9001/b"), b"")]), HostPolicy::Loopback { port: 9000 });
        assert_eq!(client.get_bytes(&format!("{base}/a"), None, "x", 10), Err(UpdateError::UnsafeRedirect));
        assert_eq!(client.get_bytes("http://127.0.0.1:9001/a", None, "x", 10), Err(UpdateError::InsecureUrl));
        assert_eq!(client.get_bytes("https://api.github.com/a", None, "x", 10), Err(UpdateError::InsecureUrl));
    }
}
