//! Le client HTTP reel (`ureq`) contre un serveur local en clair : en-tetes envoyes, corps lus avec une borne, redirections non suivies
//! par le transport (c'est `Client` qui decide), statuts et un flux complet. Le TLS n'est pas exerce hors ligne : voir DEC-046.

mod common;

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use common::{fixture, test_public_key};
use runeforge_updater::release::RepoRef;
use runeforge_updater::transport::{RawResponse, Request, Transport};
use runeforge_updater::{check, download, Channel, CheckOutcome, Client, HostPolicy, UpdateConfig, UpdateError, UreqTransport};
use semver::Version;

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    /// Sans `Content-Length` : le corps se termine a la fermeture de la connexion (la taille n'est pas annoncee).
    announce_length: bool,
}

impl Reply {
    fn ok(body: &[u8]) -> Self {
        Reply { status: 200, headers: Vec::new(), body: body.to_vec(), announce_length: true }
    }

    fn status(status: u16) -> Self {
        Reply { status, headers: Vec::new(), body: Vec::new(), announce_length: true }
    }

    /// `to` commencant par `/` designe ce serveur-ci (le port n'est connu qu'une fois le serveur lie).
    fn redirect(to: &str) -> Self {
        Reply { status: 302, headers: vec![("Location".to_string(), to.to_string())], body: Vec::new(), announce_length: true }
    }
}

type Log = Arc<Mutex<Vec<(String, HashMap<String, String>)>>>;

struct Server {
    port: u16,
    stop: Arc<AtomicBool>,
    /// Chaque requete recue : ligne de requete et en-tetes (noms en minuscules).
    requests: Log,
    handle: Option<JoinHandle<()>>,
}

impl Server {
    fn start(routes: Vec<(String, Reply)>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let stop = Arc::new(AtomicBool::new(false));
        let requests: Log = Arc::new(Mutex::new(Vec::new()));
        let routes: HashMap<String, Reply> = routes.into_iter().collect();
        let (stop_flag, log) = (stop.clone(), requests.clone());
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop_flag.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut stream) = stream else { continue };
                let mut raw = Vec::new();
                let mut buffer = [0u8; 1024];
                while !raw.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => raw.extend_from_slice(&buffer[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&raw).into_owned();
                let mut lines = text.split("\r\n");
                let request_line = lines.next().unwrap_or_default().to_string();
                let headers: HashMap<String, String> =
                    lines.filter_map(|line| line.split_once(": ")).map(|(name, value)| (name.to_ascii_lowercase(), value.to_string())).collect();
                let path = request_line.split(' ').nth(1).unwrap_or("/").to_string();
                log.lock().unwrap().push((request_line, headers));
                let not_found = Reply::status(404);
                let reply = routes.get(&path).unwrap_or(&not_found);
                let mut head = format!("HTTP/1.1 {} X\r\nConnection: close\r\n", reply.status);
                for (name, value) in &reply.headers {
                    let value = if name == "Location" && value.starts_with('/') { format!("http://127.0.0.1:{port}{value}") } else { value.clone() };
                    head.push_str(&format!("{name}: {value}\r\n"));
                }
                if reply.announce_length {
                    head.push_str(&format!("Content-Length: {}\r\n", reply.body.len()));
                }
                head.push_str("\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&reply.body);
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Both);
            }
        });
        Server { port, stop, requests, handle: Some(handle) }
    }

    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    fn headers_of(&self, index: usize) -> HashMap<String, String> {
        self.requests.lock().unwrap()[index].1.clone()
    }

    fn count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn transport() -> UreqTransport {
    UreqTransport::new("RuneForgeStudio-test/0.0", false)
}

fn fetch(transport: &UreqTransport, url: &str, token: Option<&str>, limit: u64) -> (Result<RawResponse, UpdateError>, Vec<u8>) {
    let mut body = Vec::new();
    let result = transport.execute(&Request { url, bearer: token, accept: "application/vnd.github+json" }, &mut body, limit, &mut |_, _| {});
    (result, body)
}

#[test]
fn sends_the_expected_headers_and_the_token_only_when_given() {
    let server = Server::start(vec![("/api".into(), Reply::ok(b"{}"))]);
    let (result, body) = fetch(&transport(), &server.url("/api"), Some("secret-token"), 1000);
    assert_eq!(result.unwrap().status, 200);
    assert_eq!(body, b"{}");
    let headers = server.headers_of(0);
    assert_eq!(headers["authorization"], "Bearer secret-token");
    assert_eq!(headers["accept"], "application/vnd.github+json");
    assert_eq!(headers["x-github-api-version"], "2022-11-28");
    assert_eq!(headers["user-agent"], "RuneForgeStudio-test/0.0");
    let _ = fetch(&transport(), &server.url("/api"), None, 1000);
    assert!(!server.headers_of(1).contains_key("authorization"), "no token, no Authorization header");
}

#[test]
fn does_not_follow_a_redirect_by_itself_it_reports_where_it_points() {
    let server = Server::start(vec![("/start".into(), Reply::redirect("http://127.0.0.1:1/elsewhere"))]);
    let (result, body) = fetch(&transport(), &server.url("/start"), Some("t"), 1000);
    let response = result.unwrap();
    assert_eq!((response.status, response.location.as_deref()), (302, Some("http://127.0.0.1:1/elsewhere")));
    assert!(body.is_empty(), "the body of a redirect is never written");
    assert_eq!(server.count(), 1);
}

#[test]
fn reports_statuses_without_writing_their_body() {
    let mut forbidden = Reply::status(403);
    forbidden.headers.push(("X-RateLimit-Remaining".to_string(), "0".to_string()));
    forbidden.body = b"{\"message\":\"rate limited\"}".to_vec();
    let server = Server::start(vec![("/limited".into(), forbidden), ("/missing".into(), Reply::status(404))]);
    let (limited, body) = fetch(&transport(), &server.url("/limited"), None, 1000);
    let limited = limited.unwrap();
    assert_eq!((limited.status, limited.rate_limit_remaining), (403, Some(0)));
    assert!(body.is_empty());
    assert_eq!(fetch(&transport(), &server.url("/missing"), None, 1000).0.unwrap().status, 404);
}

#[test]
fn refuses_a_body_larger_than_the_limit_announced_or_not() {
    let big = vec![7u8; 5000];
    let mut unannounced = Reply::ok(&big);
    unannounced.announce_length = false;
    let server = Server::start(vec![("/announced".into(), Reply::ok(&big)), ("/unannounced".into(), unannounced)]);
    let (announced, written) = fetch(&transport(), &server.url("/announced"), None, 1000);
    assert_eq!(announced.unwrap_err(), UpdateError::TooLarge);
    assert!(written.is_empty(), "an announced size over the limit is refused before any byte is written");
    let (unannounced, written) = fetch(&transport(), &server.url("/unannounced"), None, 1000);
    assert_eq!(unannounced.unwrap_err(), UpdateError::TooLarge);
    assert!(written.len() <= 1000, "at most the limit is ever written, here {}", written.len());
    let (within, body) = fetch(&transport(), &server.url("/announced"), None, 5000);
    assert_eq!((within.unwrap().status, body.len()), (200, 5000));
}

#[test]
fn production_mode_refuses_plain_http_before_connecting() {
    let server = Server::start(vec![("/api".into(), Reply::ok(b"{}"))]);
    let strict = UreqTransport::new("RuneForgeStudio-test/0.0", true);
    let (result, _) = fetch(&strict, &server.url("/api"), Some("t"), 1000);
    assert!(matches!(result, Err(UpdateError::Network { .. })));
    assert_eq!(server.count(), 0, "nothing reached the server, the token included");
}

#[test]
fn an_unreachable_server_is_a_network_error_without_details() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let (result, _) = fetch(&transport(), &format!("http://127.0.0.1:{port}/api"), Some("secret"), 1000);
    match result {
        Err(UpdateError::Network { kind }) => assert!(!kind.contains("secret") && !kind.contains("127.0.0.1"), "{kind}"),
        other => panic!("{other:?}"),
    }
}

/// Le flux entier avec le vrai client HTTP : liste, manifeste signe, signature, puis executable par une redirection (meme origine).
#[test]
fn checks_and_downloads_an_update_over_real_http() {
    let exe = fixture("artifact.exe");
    let manifest = fixture("ok.manifest.json");
    let signature = fixture("ok.manifest.json.sig");
    let release_list = serde_json::json!([{
        "tag_name": "v0.2.0", "draft": false, "prerelease": false,
        "assets": [
            { "id": 1, "name": "update-manifest.json", "size": manifest.len() },
            { "id": 2, "name": "update-manifest.json.sig", "size": signature.len() },
            { "id": 3, "name": "runeforge-studio-0.2.0-windows-x86_64.exe", "size": exe.len() },
        ],
    }]);
    let server = Server::start(vec![
        ("/repos/o/r/releases?per_page=30".to_string(), Reply::ok(release_list.to_string().as_bytes())),
        ("/repos/o/r/releases/assets/1".to_string(), Reply::ok(&manifest)),
        ("/repos/o/r/releases/assets/2".to_string(), Reply::ok(&signature)),
        ("/repos/o/r/releases/assets/3".to_string(), Reply::redirect("/storage/exe")),
        ("/storage/exe".to_string(), Reply::ok(&exe)),
    ]);
    let client = Client::new(transport(), HostPolicy::Loopback { port: server.port });
    let config = UpdateConfig {
        api_base: format!("http://127.0.0.1:{}", server.port),
        repository: RepoRef::parse("o/r").unwrap(),
        channel: Channel::Stable,
        current_version: Version::new(0, 0, 0),
        platform: "windows-x86_64".to_string(),
        public_key: test_public_key(),
    };
    let update = match check(&client, &config, Some("token-for-the-api")).unwrap() {
        CheckOutcome::Available(update) => update,
        CheckOutcome::UpToDate => panic!("an update was expected"),
    };
    assert_eq!(update.version.to_string(), "0.2.0");
    let mut file = tempfile::tempfile().unwrap();
    download(&client, &config, &update, Some("token-for-the-api"), &mut file, &mut |_, _| {}).unwrap();
    assert_eq!(file.metadata().unwrap().len(), exe.len() as u64);

    // Le jeton accompagne les requetes de l'API (liste, premier saut du fichier), pas celle du stockage.
    let log = server.requests.lock().unwrap();
    let carried = |path: &str| log.iter().find(|(line, _)| line.contains(path)).map(|(_, headers)| headers.contains_key("authorization"));
    assert_eq!(carried("/repos/o/r/releases?per_page=30"), Some(true));
    assert_eq!(carried("/repos/o/r/releases/assets/3"), Some(true));
    assert_eq!(carried("/storage/exe"), Some(false));
}
