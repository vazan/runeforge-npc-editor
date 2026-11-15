//! Chercher et telecharger une mise a jour de bout en bout, sur un GitHub simule et des manifestes reellement signes.

mod common;

use common::*;
use runeforge_updater::{check, download, CheckOutcome, Channel, UpdateError, VerifiedUpdate};

const EXE_NAME_0_2_0: &str = "runeforge-studio-0.2.0-windows-x86_64.exe";

fn exe() -> Vec<u8> {
    fixture("artifact.exe")
}

/// Un depot dont la liste de releases est composee par `releases`.
fn world_with(releases: impl FnOnce(World) -> (World, Vec<ReleaseSpec>)) -> World {
    let (world, specs) = releases(World::new());
    world.body(&releases_url(), &releases_json(&specs))
}

fn ok_release(world: World) -> (World, ReleaseSpec) {
    published(world, 100, "v0.2.0", false, "ok", EXE_NAME_0_2_0, &exe())
}

fn repo_with_ok_release() -> runeforge_updater::Client<World> {
    client(world_with(|world| {
        let (world, spec) = ok_release(world);
        (world, vec![spec])
    }))
}

fn available(outcome: Result<CheckOutcome, UpdateError>) -> VerifiedUpdate {
    match outcome {
        Ok(CheckOutcome::Available(update)) => update,
        other => panic!("une mise a jour etait attendue : {other:?}"),
    }
}

fn version_of(client: &runeforge_updater::Client<World>, current: &str, channel: Channel) -> String {
    available(check(client, &config(current, channel), None)).version.to_string()
}

#[test]
fn finds_the_update_described_by_the_signed_manifest() {
    let client = repo_with_ok_release();
    let update = available(check(&client, &config("0.0.0", Channel::Stable), Some(TOKEN)));
    assert_eq!(update.version.to_string(), "0.2.0");
    assert_eq!(update.release_tag, "v0.2.0");
    assert_eq!(update.file, EXE_NAME_0_2_0);
    assert_eq!(update.size, exe().len() as u64);
    assert_eq!(update.channel, Channel::Stable);
    assert!(update.notes.starts_with("Notes de la 0.2.0."));
    assert_eq!(update.published_at, "2026-11-15T10:00:00Z");
}

#[test]
fn nothing_is_downloaded_when_the_application_is_up_to_date() {
    let client = repo_with_ok_release();
    assert_eq!(check(&client, &config("0.2.0", Channel::Stable), Some(TOKEN)), Ok(CheckOutcome::UpToDate));
    assert_eq!(client.transport().seen_urls(), [releases_url()], "only the release list was requested");
    assert_eq!(check(&client, &config("0.9.0", Channel::Stable), None), Ok(CheckOutcome::UpToDate));
}

#[test]
fn the_token_is_sent_to_the_api_only_never_to_the_file_storage() {
    let client = repo_with_ok_release();
    let config = config("0.0.0", Channel::Stable);
    let update = available(check(&client, &config, Some(TOKEN)));
    let mut file = tempfile::tempfile().unwrap();
    download(&client, &config, &update, Some(TOKEN), &mut file, &mut |_, _| {}).unwrap();

    let world = client.transport();
    let to_api = world.tokens_received_by(API);
    assert_eq!(to_api.len(), 4, "list, manifest, signature, then the executable");
    assert!(to_api.iter().all(|token| token.as_deref() == Some(TOKEN)));
    assert_eq!(world.tokens_received_by(CDN), [None], "the storage is reached once, without any credential");
}

#[test]
fn the_stable_channel_ignores_a_beta_release_and_the_beta_channel_takes_the_newest() {
    let build = || {
        client(world_with(|world| {
            let (world, stable) = ok_release(world);
            let (world, beta) = published(world, 200, "v0.3.0-beta.1", true, "beta", "runeforge-studio-0.3.0-beta.1-windows-x86_64.exe", &exe());
            (world, vec![stable, beta])
        }))
    };
    assert_eq!(version_of(&build(), "0.0.0", Channel::Stable), "0.2.0");
    let beta = available(check(&build(), &config("0.0.0", Channel::Beta), None));
    assert_eq!((beta.version.to_string(), beta.channel), ("0.3.0-beta.1".to_string(), Channel::Beta));
}

#[test]
fn a_manifest_altered_after_signing_is_refused() {
    let (world, spec) = ok_release(World::new());
    let mut manifest = fixture("ok.manifest.json");
    let position = manifest.windows(8).position(|window| window == b"Deuxieme").unwrap();
    manifest[position] = b'd';
    let world = world.asset(100, &manifest).body(&releases_url(), &releases_json(&[spec]));
    assert_eq!(check(&client(world), &config("0.0.0", Channel::Stable), None), Err(UpdateError::BadSignature));
}

#[test]
fn a_manifest_signed_by_another_key_is_refused_and_an_older_release_is_not_offered_instead() {
    let client = client(world_with(|world| {
        let (world, good) = ok_release(world);
        let (world, forged) = published(world, 300, "v0.2.6", false, "other-key", "runeforge-studio-0.2.6-windows-x86_64.exe", &exe());
        (world, vec![good, forged])
    }));
    // La release la plus recente est falsifiee : l'erreur est signalee, la 0.2.0 n'est pas proposee « a la place ».
    assert_eq!(check(&client, &config("0.0.0", Channel::Stable), None), Err(UpdateError::BadSignature));
}

#[test]
fn a_garbled_signature_file_is_refused() {
    let (world, spec) = ok_release(World::new());
    let world = world.asset(101, b"not a signature").body(&releases_url(), &releases_json(&[spec]));
    assert_eq!(check(&client(world), &config("0.0.0", Channel::Stable), None), Err(UpdateError::BadSignature));
}

#[test]
fn the_release_tag_and_flags_must_agree_with_the_signed_manifest() {
    // Etiquette v0.2.4 mais manifeste signe 0.2.5.
    let tag = client(world_with(|world| {
        let (world, spec) = published(world, 100, "v0.2.4", false, "other-version", "runeforge-studio-0.2.5-windows-x86_64.exe", &exe());
        (world, vec![spec])
    }));
    assert_eq!(check(&tag, &config("0.0.0", Channel::Stable), None), Err(UpdateError::bad_manifest("tag")));
    // Manifeste beta publie comme une release ordinaire.
    let flag = client(world_with(|world| {
        let (world, spec) = published(world, 100, "v0.3.0-beta.1", false, "beta", "runeforge-studio-0.3.0-beta.1-windows-x86_64.exe", &exe());
        (world, vec![spec])
    }));
    assert_eq!(check(&flag, &config("0.0.0", Channel::Beta), None), Err(UpdateError::bad_manifest("channel")));
}

#[test]
fn a_release_that_needs_a_newer_base_is_skipped_for_an_older_one() {
    let only_minimum = client(world_with(|world| {
        let (world, spec) = published(world, 100, "v0.4.0", false, "minimum", "runeforge-studio-0.4.0-windows-x86_64.exe", &exe());
        (world, vec![spec])
    }));
    assert_eq!(check(&only_minimum, &config("0.0.0", Channel::Stable), None), Err(UpdateError::ManualUpdateRequired { minimum: "0.3.0".into() }));
    let with_fallback = client(world_with(|world| {
        let (world, old) = ok_release(world);
        let (world, new) = published(world, 400, "v0.4.0", false, "minimum", "runeforge-studio-0.4.0-windows-x86_64.exe", &exe());
        (world, vec![old, new])
    }));
    assert_eq!(version_of(&with_fallback, "0.0.0", Channel::Stable), "0.2.0");
    // Une application assez recente installe directement la release a base minimale.
    assert_eq!(version_of(&with_fallback, "0.3.0", Channel::Stable), "0.4.0");
}

#[test]
fn a_release_without_a_file_for_this_platform_is_reported() {
    let client = client(world_with(|world| {
        let (world, spec) = published(world, 100, "v0.2.1", false, "linux-only", "runeforge-studio-0.2.1-linux-x86_64", &exe());
        (world, vec![spec])
    }));
    assert_eq!(check(&client, &config("0.0.0", Channel::Stable), None), Err(UpdateError::NoPlatformAsset));
}

#[test]
fn a_release_still_being_published_is_skipped() {
    let client = client(world_with(|world| {
        let (world, good) = ok_release(world);
        let unfinished = ReleaseSpec { tag: "v0.2.9", prerelease: false, assets: vec![] };
        (world, vec![good, unfinished])
    }));
    assert_eq!(version_of(&client, "0.0.0", Channel::Stable), "0.2.0");
}

#[test]
fn a_manifest_the_application_cannot_read_is_refused_even_when_validly_signed() {
    let future = client(world_with(|world| {
        let (world, spec) = published(world, 100, "v0.2.7", false, "future-schema", "runeforge-studio-0.2.7-windows-x86_64.exe", &exe());
        (world, vec![spec])
    }));
    assert_eq!(check(&future, &config("0.0.0", Channel::Stable), None), Err(UpdateError::UnsupportedSchema));
    let foreign = client(world_with(|world| {
        let (world, spec) = published(world, 100, "v0.2.8", false, "wrong-product", "runeforge-studio-0.2.8-windows-x86_64.exe", &exe());
        (world, vec![spec])
    }));
    assert_eq!(check(&foreign, &config("0.0.0", Channel::Stable), None), Err(UpdateError::bad_manifest("product")));
}

#[test]
fn the_size_announced_by_the_list_must_match_the_signed_manifest() {
    let (world, mut spec) = ok_release(World::new());
    spec.assets[2].2 += 1;
    let world = world.body(&releases_url(), &releases_json(&[spec]));
    assert_eq!(check(&client(world), &config("0.0.0", Channel::Stable), None), Err(UpdateError::bad_manifest("size")));
}

#[test]
fn a_manifest_or_signature_announced_as_far_too_large_is_refused_without_downloading_it() {
    for index in [0, 1] {
        let (world, mut spec) = ok_release(World::new());
        spec.assets[index].2 = 1024 * 1024;
        let client = client(world.body(&releases_url(), &releases_json(&[spec])));
        assert_eq!(check(&client, &config("0.0.0", Channel::Stable), None), Err(UpdateError::bad_manifest("size")), "asset {index}");
        assert_eq!(client.transport().seen_urls().len(), 1, "only the list is requested, asset {index} is never downloaded");
    }
}

#[test]
fn without_a_public_key_nothing_is_checked() {
    let client = repo_with_ok_release();
    for text in ["", "UNCONFIGURED", "not base64 !!", "dGVzdA=="] {
        let mut config = config("0.0.0", Channel::Stable);
        config.public_key = text.to_string();
        assert_eq!(check(&client, &config, None), Err(UpdateError::NotConfigured), "{text}");
    }
    assert!(client.transport().seen_urls().is_empty(), "no request is made without a key to verify with");
}

#[test]
fn server_errors_become_stable_codes() {
    let status = |code: u16| {
        let world = World::new().route(&releases_url(), Route::Status(code));
        check(&client(world), &config("0.0.0", Channel::Stable), Some(TOKEN))
    };
    assert_eq!(status(404), Err(UpdateError::RepositoryNotFound));
    assert_eq!(status(401), Err(UpdateError::Unauthorized));
    assert_eq!(status(500), Err(UpdateError::Network { kind: "status:500".into() }));
    let not_a_list = World::new().body(&releases_url(), b"{\"message\":\"Not Found\"}");
    assert_eq!(check(&client(not_a_list), &config("0.0.0", Channel::Stable), None), Err(UpdateError::BadResponse));
}

/// Telecharge la release `tag` d'une fixture ; le depot annonce l'artefact `listed` et le stockage sert `served`.
fn downloaded(fixture_name: &str, tag: &'static str, artifact_name: &str, listed: &[u8], served: &[u8]) -> Result<Vec<u8>, UpdateError> {
    let (world, spec) = published_with(World::new(), 100, tag, false, fixture_name, artifact_name, listed, served);
    let client = client(world.body(&releases_url(), &releases_json(&[spec])));
    let config = config("0.0.0", Channel::Stable);
    let update = available(check(&client, &config, Some(TOKEN)));
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("download.bin");
    let mut file = std::fs::File::create(&path).unwrap();
    let mut progress = Vec::new();
    download(&client, &config, &update, Some(TOKEN), &mut file, &mut |done, total| progress.push((done, total)))?;
    assert_eq!(progress.last().copied(), Some((update.size, update.size)), "progress ends at the announced size");
    Ok(std::fs::read(&path).unwrap())
}

#[test]
fn downloads_and_verifies_the_executable_through_the_storage_redirect() {
    assert_eq!(downloaded("ok", "v0.2.0", EXE_NAME_0_2_0, &exe(), &exe()).unwrap(), exe());
}

#[test]
fn refuses_a_file_that_does_not_match_the_signed_digest_size_or_type() {
    // Le manifeste (signe) annonce une autre empreinte.
    assert_eq!(downloaded("bad-hash", "v0.2.2", "runeforge-studio-0.2.2-windows-x86_64.exe", &exe(), &exe()), Err(UpdateError::HashMismatch));
    // Le stockage sert un autre contenu de la meme taille.
    let mut swapped = exe();
    let last = swapped.len() - 1;
    swapped[last] ^= 0xff;
    assert_eq!(downloaded("ok", "v0.2.0", EXE_NAME_0_2_0, &exe(), &swapped), Err(UpdateError::HashMismatch));
    // Un fichier `.exe` qui n'en est pas un (empreinte pourtant exacte).
    let fake = fixture("not-an-exe.exe");
    assert_eq!(downloaded("not-exe", "v0.2.3", "runeforge-studio-0.2.3-windows-x86_64.exe", &fake, &fake), Err(UpdateError::NotExecutable));
}

#[test]
fn a_download_longer_or_shorter_than_the_signed_size_is_refused() {
    let mut longer = exe();
    longer.extend_from_slice(b"surplus");
    assert_eq!(downloaded("ok", "v0.2.0", EXE_NAME_0_2_0, &exe(), &longer), Err(UpdateError::TooLarge));
    assert_eq!(downloaded("ok", "v0.2.0", EXE_NAME_0_2_0, &exe(), &exe()[..100]), Err(UpdateError::HashMismatch));
}

// ---- Linux : une seule release signee porte l'executable de chaque systeme ----

const WINDOWS: &str = "windows-x86_64";
const LINUX: &str = "linux-x86_64";
const WINDOWS_0_5_0: &str = "runeforge-studio-0.5.0-windows-x86_64.exe";
const LINUX_0_5_0: &str = "runeforge-studio-0.5.0-linux-x86_64";

fn elf() -> Vec<u8> {
    fixture("artifact-linux")
}

/// Une release 0.5.0 signee une seule fois, qui porte l'executable de Windows (identifiant 202) et celui de Linux (identifiant 203).
fn both_platforms() -> runeforge_updater::Client<World> {
    let (windows_bytes, linux_bytes) = (exe(), elf());
    let (world, spec) = published_multi(World::new(), 200, "v0.5.0", "both", &[(WINDOWS_0_5_0, &windows_bytes), (LINUX_0_5_0, &linux_bytes)]);
    client(world.body(&releases_url(), &releases_json(&[spec])))
}

/// Telecharge la release d'une fixture pour un ordinateur de `platform` ; le depot et le stockage servent les memes `bytes`.
fn downloaded_for(platform: &str, fixture_name: &str, tag: &'static str, artifact_name: &str, bytes: &[u8]) -> Result<Vec<u8>, UpdateError> {
    let (world, spec) = published(World::new(), 100, tag, false, fixture_name, artifact_name, bytes);
    let client = client(world.body(&releases_url(), &releases_json(&[spec])));
    let config = config_for(platform, "0.0.0", Channel::Stable);
    let update = available(check(&client, &config, Some(TOKEN)));
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("download.bin");
    let mut file = std::fs::File::create(&path).unwrap();
    download(&client, &config, &update, Some(TOKEN), &mut file, &mut |_, _| {})?;
    Ok(std::fs::read(&path).unwrap())
}

#[test]
fn one_signed_release_gives_each_system_its_own_executable() {
    let client = both_platforms();
    let windows = available(check(&client, &config_for(WINDOWS, "0.0.0", Channel::Stable), Some(TOKEN)));
    let linux = available(check(&client, &config_for(LINUX, "0.0.0", Channel::Stable), Some(TOKEN)));
    assert_eq!((windows.file.as_str(), linux.file.as_str()), (WINDOWS_0_5_0, LINUX_0_5_0));
    assert_eq!((windows.size, linux.size), (exe().len() as u64, elf().len() as u64));
    assert_ne!(windows.sha256, linux.sha256);
    assert_eq!((windows.version.to_string(), linux.version.to_string()), ("0.5.0".to_string(), "0.5.0".to_string()));
}

#[test]
fn an_architecture_the_release_does_not_carry_is_reported_and_so_is_a_windows_only_release_on_linux() {
    let client = both_platforms();
    assert_eq!(check(&client, &config_for("linux-aarch64", "0.0.0", Channel::Stable), None), Err(UpdateError::NoPlatformAsset));
    assert_eq!(check(&repo_with_ok_release(), &config_for(LINUX, "0.0.0", Channel::Stable), None), Err(UpdateError::NoPlatformAsset));
}

#[test]
fn linux_downloads_and_verifies_an_elf_executable_and_never_touches_the_windows_file() {
    let client = both_platforms();
    let config = config_for(LINUX, "0.0.0", Channel::Stable);
    let update = available(check(&client, &config, Some(TOKEN)));
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("download.bin");
    let mut file = std::fs::File::create(&path).unwrap();
    let mut progress = Vec::new();
    download(&client, &config, &update, Some(TOKEN), &mut file, &mut |done, total| progress.push((done, total))).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), elf());
    assert_eq!(progress.last().copied(), Some((update.size, update.size)));

    let seen = client.transport().seen_urls();
    assert!(seen.contains(&asset_url(203)), "the Linux file was requested");
    assert!(!seen.contains(&asset_url(202)), "the Windows file was never requested");
    // Le jeton n'est parti qu'a l'API, jamais vers le stockage vers lequel GitHub redirige (Linux comme Windows).
    let storage = client.transport().tokens_received_by(CDN);
    assert!(!storage.is_empty() && storage.iter().all(Option::is_none), "{storage:?}");
}

#[test]
fn a_signed_file_that_is_not_the_executable_of_its_system_is_refused() {
    // Sous Linux : un fichier de texte, et l'executable de Windows (signes, empreintes exactes).
    let text = fixture("not-an-elf");
    assert_eq!(downloaded_for(LINUX, "linux-not-elf", "v0.5.1", "runeforge-studio-0.5.1-linux-x86_64", &text), Err(UpdateError::NotExecutable));
    assert_eq!(downloaded_for(LINUX, "windows-exe-for-linux", "v0.5.2", "runeforge-studio-0.5.2-linux-x86_64", &exe()), Err(UpdateError::NotExecutable));
    // Sous Windows : un executable ELF.
    assert_eq!(downloaded_for(WINDOWS, "elf-for-windows", "v0.5.3", "runeforge-studio-0.5.3-windows-x86_64.exe", &elf()), Err(UpdateError::NotExecutable));
    // Le temoin : le meme chemin avec un vrai executable de leur systeme reussit, donc les refus ci-dessus viennent bien du format.
    assert_eq!(downloaded_for(LINUX, "both", "v0.5.0", LINUX_0_5_0, &elf()), Ok(elf()));
    assert_eq!(downloaded_for(WINDOWS, "both", "v0.5.0", WINDOWS_0_5_0, &exe()), Ok(exe()));
}

#[test]
fn a_system_the_updater_cannot_install_downloads_nothing() {
    let client = both_platforms();
    let update = available(check(&client, &config_for(LINUX, "0.0.0", Channel::Stable), None));
    let requests = client.transport().seen_urls().len();
    let directory = tempfile::tempdir().unwrap();
    let mut file = std::fs::File::create(directory.path().join("download.bin")).unwrap();
    let outcome = download(&client, &config_for("macos-aarch64", "0.0.0", Channel::Stable), &update, None, &mut file, &mut |_, _| {});
    assert_eq!(outcome, Err(UpdateError::UnsupportedPlatform));
    assert_eq!(client.transport().seen_urls().len(), requests, "nothing was requested");
}
