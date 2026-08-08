use ruzstd::decoding::StreamingDecoder;
use ruzstd::io::Read;
use wasm_bindgen::prelude::*;

/// Decompress one Zstandard frame into a newly allocated Uint8Array.
///
/// This intentionally exposes a one-shot API: ruzstd's StreamingDecoder reads
/// one frame, and wasm-bindgen owns the copies across the JS/Wasm boundary.
#[wasm_bindgen]
pub fn decompress(input: &[u8]) -> Result<Vec<u8>, JsError> {
    decompress_bytes(input).map_err(|error| JsError::new(&error))
}

fn decompress_bytes(input: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = StreamingDecoder::new(input)
        .map_err(|error| format!("invalid Zstandard frame: {error:?}"))?;
    let mut output = Vec::new();
    decoder
        .read_to_end(&mut output)
        .map_err(|error| format!("could not decompress Zstandard frame: {error}"))?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::decompress_bytes;
    use ruzstd::encoding::{compress_to_vec, CompressionLevel};

    #[test]
    fn decompresses_a_zstandard_frame() {
        let expected = b"ClassApp zstd wasm wrapper".repeat(32);
        let compressed = compress_to_vec(expected.as_slice(), CompressionLevel::Fastest);

        assert_eq!(decompress_bytes(&compressed).unwrap(), expected);
    }

    #[test]
    fn rejects_non_zstandard_input() {
        assert!(decompress_bytes(b"not a zstd frame").is_err());
    }
}
