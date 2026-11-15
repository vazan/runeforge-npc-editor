use runeforge_filesystem::{FsError, Result};
use serde::de::DeserializeOwned;
use tauri::http::HeaderMap;

/// Decode un texte encode comme `encodeURIComponent` (les valeurs d'en-tete HTTP ne peuvent pas contenir de JSON brut).
pub fn percent_decode(input: &str) -> Result<String> {
    let bytes = input.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes.get(index + 1).and_then(|b| hex_value(*b));
            let low = bytes.get(index + 2).and_then(|b| hex_value(*b));
            match (high, low) {
                (Some(high), Some(low)) => {
                    output.push(high * 16 + low);
                    index += 3;
                }
                _ => return Err(FsError::invalid_argument("malformed percent-encoding")),
            }
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| FsError::invalid_argument("header is not valid UTF-8"))
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Lit un en-tete contenant du JSON encode (voir `percent_decode`).
pub fn header_json<T: DeserializeOwned>(headers: &HeaderMap, name: &str) -> Result<T> {
    let value = headers
        .get(name)
        .ok_or_else(|| FsError::invalid_argument(format!("missing header {name}")))?;
    let text = value.to_str().map_err(|_| FsError::invalid_argument("header is not ASCII"))?;
    let decoded = percent_decode(text)?;
    serde_json::from_str(&decoded).map_err(|_| FsError::invalid_argument(format!("header {name} is not valid JSON")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_uri_component_output() {
        assert_eq!(percent_decode("%7B%22a%22%3A%22caf%C3%A9%20x%22%7D").unwrap(), "{\"a\":\"café x\"}");
        assert_eq!(percent_decode("plain-text_1.2~").unwrap(), "plain-text_1.2~");
    }

    #[test]
    fn rejects_malformed_or_non_utf8_input() {
        assert!(percent_decode("%zz").is_err());
        assert!(percent_decode("%4").is_err());
        assert!(percent_decode("%FF%FE").is_err());
    }

    #[test]
    fn reads_json_headers_and_reports_missing_ones() {
        let mut headers = HeaderMap::new();
        headers.insert("x-rf-meta", "%7B%22n%22%3A5%7D".parse().unwrap());
        #[derive(serde::Deserialize)]
        struct Meta {
            n: u32,
        }
        let meta: Meta = header_json(&headers, "x-rf-meta").unwrap();
        assert_eq!(meta.n, 5);
        assert!(header_json::<Meta>(&headers, "x-absent").is_err());
        headers.insert("x-bad", "not-json".parse().unwrap());
        assert!(header_json::<Meta>(&headers, "x-bad").is_err());
    }
}
