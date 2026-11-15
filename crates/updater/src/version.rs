use semver::Version;
use serde::{Deserialize, Serialize};

use crate::error::UpdateError;

/// Canal de mises a jour : `stable` ne propose que les versions finales, `beta` propose aussi les pre-versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

impl Channel {
    pub fn parse(text: &str) -> Result<Self, UpdateError> {
        match text {
            "stable" => Ok(Channel::Stable),
            "beta" => Ok(Channel::Beta),
            _ => Err(UpdateError::InvalidChannel),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }
}

/// Version `x.y.z[-pre]` d'un manifeste ou de l'application : semver strict, sans prefixe `v` ni metadonnees de construction
/// (leur ordre n'est pas celui de la specification dans la bibliotheque, donc on les refuse).
pub fn parse_version(text: &str) -> Result<Version, UpdateError> {
    let version = Version::parse(text).map_err(|_| UpdateError::bad_manifest("version"))?;
    if !version.build.is_empty() {
        return Err(UpdateError::bad_manifest("version"));
    }
    Ok(version)
}

/// Version portee par l'etiquette d'une release (`v1.2.3` ou `1.2.3`) ; `None` si l'etiquette n'en est pas une.
pub fn parse_tag(tag: &str) -> Option<Version> {
    parse_version(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_follow_semver_precedence() {
        let v = |text: &str| parse_version(text).unwrap();
        assert!(v("0.2.0") > v("0.1.9"));
        assert!(v("1.0.0") > v("1.0.0-beta.2"));
        assert!(v("1.0.0-beta.10") > v("1.0.0-beta.2"));
        assert!(v("1.0.0-rc.1") > v("1.0.0-beta.9"));
        assert_eq!(v("1.2.3"), v("1.2.3"));
    }

    #[test]
    fn refuses_what_is_not_a_plain_semver() {
        for bad in ["", "1", "1.2", "v1.2.3", "1.2.3+build5", "1.2.3.4", "01.2.3", "latest"] {
            assert!(parse_version(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_release_tag_may_carry_a_leading_v() {
        assert_eq!(parse_tag("v0.3.0"), Some(Version::new(0, 3, 0)));
        assert_eq!(parse_tag("0.3.0"), Some(Version::new(0, 3, 0)));
        assert_eq!(parse_tag("nightly"), None);
        assert_eq!(parse_tag("vv1.0.0"), None);
        assert_eq!(parse_tag("v1.0.0+meta"), None);
    }

    #[test]
    fn channels_are_parsed_by_exact_name() {
        assert_eq!(Channel::parse("stable"), Ok(Channel::Stable));
        assert_eq!(Channel::parse("beta"), Ok(Channel::Beta));
        assert_eq!(Channel::parse("Stable"), Err(UpdateError::InvalidChannel));
        assert_eq!(Channel::parse("nightly"), Err(UpdateError::InvalidChannel));
    }
}
