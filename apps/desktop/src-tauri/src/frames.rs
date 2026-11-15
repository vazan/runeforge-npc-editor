use serde_json::Value;

/// Un enregistrement binaire renvoye au frontend : metadonnees JSON + octets bruts.
pub struct Frame {
    pub meta: Value,
    pub data: Vec<u8>,
}

/// Encode une suite d'enregistrements dans un seul tampon (contrat decode par `apps/desktop/src/services/frames.ts`) :
///
/// ```text
/// u32 LE nombre d'enregistrements
/// pour chaque enregistrement : u32 LE longueur_meta | meta (JSON UTF-8) | u32 LE longueur_donnees | donnees
/// ```
pub fn encode(frames: &[Frame]) -> Vec<u8> {
    let mut output = Vec::new();
    output.extend_from_slice(&(frames.len() as u32).to_le_bytes());
    for frame in frames {
        let meta = serde_json::to_vec(&frame.meta).unwrap_or_else(|_| b"{}".to_vec());
        output.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        output.extend_from_slice(&meta);
        output.extend_from_slice(&(frame.data.len() as u32).to_le_bytes());
        output.extend_from_slice(&frame.data);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn golden_layout_matches_the_typescript_decoder_contract() {
        let bytes = encode(&[Frame { meta: json!({"p": "a"}), data: vec![1, 2, 3] }]);
        let expected: Vec<u8> = [
            &[1u8, 0, 0, 0][..], // 1 enregistrement
            &[9, 0, 0, 0],       // longueur de la meta
            br#"{"p":"a"}"#,     // meta
            &[3, 0, 0, 0],       // longueur des donnees
            &[1, 2, 3],          // donnees
        ]
        .concat();
        assert_eq!(bytes, expected);
    }

    #[test]
    fn empty_and_binary_payloads_roundtrip() {
        let all: Vec<u8> = (0..=255u8).collect();
        let bytes = encode(&[
            Frame { meta: json!({"ok": true}), data: Vec::new() },
            Frame { meta: json!({"ok": true}), data: all.clone() },
        ]);
        assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 2);
        assert!(bytes.ends_with(&all));
    }
}
