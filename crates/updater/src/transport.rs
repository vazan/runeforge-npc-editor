//! Un echange HTTP, sans politique : tout ce qui decide (hotes permis, redirections, jeton) est dans `client`.

use std::io::Write;

use crate::error::UpdateError;

pub struct Request<'a> {
    pub url: &'a str,
    /// Jeton d'acces : n'est joint qu'a la premiere requete, adressee a l'API (voir `client`).
    pub bearer: Option<&'a str>,
    pub accept: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RawResponse {
    pub status: u16,
    pub location: Option<String>,
    pub content_length: Option<u64>,
    /// En-tete `x-ratelimit-remaining`, quand le serveur le donne.
    pub rate_limit_remaining: Option<u64>,
}

/// Un echange, **sans suivre les redirections**. Le corps n'est ecrit dans `sink` que pour un statut 2xx, au plus `limit` octets
/// (`TooLarge` au-dela) ; `progress(recus, total)` est appele au fil de la lecture.
pub trait Transport: Send + Sync {
    fn execute(
        &self,
        request: &Request<'_>,
        sink: &mut dyn Write,
        limit: u64,
        progress: &mut dyn FnMut(u64, Option<u64>),
    ) -> Result<RawResponse, UpdateError>;
}
