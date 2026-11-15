//! Verification de la signature du manifeste (minisign, le format de `tauri signer`).
//!
//! La cle publique est **celle de l'application** (embarquee a la construction) : un depot compromis, un compte vole ou un
//! serveur malveillant ne peuvent pas fabriquer une mise a jour acceptee, faute de la cle privee, que seul l'editeur detient.

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};

use crate::error::UpdateError;
use crate::manifest::{self, Manifest, MAX_MANIFEST_BYTES};

/// Taille maximale d'un fichier de signature (en pratique : environ 400 octets).
pub const MAX_SIGNATURE_BYTES: usize = 4 * 1024;

/// Texte minisign d'un fichier `.pub` ou `.sig` : soit tel quel (`untrusted comment: ...`), soit encode en base64 comme
/// `tauri signer` l'ecrit.
fn minisign_text(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.starts_with("untrusted comment:") {
        return Some(trimmed.to_string());
    }
    String::from_utf8(STANDARD.decode(trimmed).ok()?).ok()
}

/// Cle publique de mise a jour. Un texte absent, vide ou en attente de configuration (`NotConfigured`) interdit toute mise a jour :
/// sans cle, rien ne peut etre verifie.
pub fn load_public_key(text: &str) -> Result<PublicKey, UpdateError> {
    if let Some(key) = minisign_text(text).and_then(|decoded| PublicKey::decode(&decoded).ok()) {
        return Ok(key);
    }
    PublicKey::from_base64(text.trim()).map_err(|_| UpdateError::NotConfigured)
}

/// Verifie la signature du manifeste puis le lit : les octets ne sont interpretes qu'apres une signature valide.
pub fn verify_manifest(key: &PublicKey, manifest_bytes: &[u8], signature: &str) -> Result<Manifest, UpdateError> {
    if manifest_bytes.len() > MAX_MANIFEST_BYTES || signature.len() > MAX_SIGNATURE_BYTES {
        return Err(UpdateError::bad_manifest("size"));
    }
    let signature = minisign_text(signature).and_then(|text| Signature::decode(&text).ok()).ok_or(UpdateError::BadSignature)?;
    // Les signatures de l'ancien mode minisign (non prehache) ne sont pas acceptees : `tauri signer` n'en produit plus.
    key.verify(manifest_bytes, &signature, false).map_err(|_| UpdateError::BadSignature)?;
    manifest::parse(manifest_bytes)
}
