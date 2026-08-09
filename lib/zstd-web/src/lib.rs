use ruzstd::decoding::{Dictionary, FrameDecoder, StreamingDecoder};
use ruzstd::io::Read;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn decompress(input: &[u8], expected_size: u32) -> Result<Vec<u8>, JsError> {
    decompress_bytes(input, None, expected_size as usize).map_err(|error| JsError::new(&error))
}

#[wasm_bindgen]
pub fn decompress_with_dictionary(
    input: &[u8],
    dictionary: &[u8],
    expected_size: u32,
) -> Result<Vec<u8>, JsError> {
    decompress_bytes(input, Some(dictionary), expected_size as usize)
        .map_err(|error| JsError::new(&error))
}

fn decompress_bytes(
    input: &[u8],
    dictionary: Option<&[u8]>,
    expected_size: usize,
) -> Result<Vec<u8>, String> {
    let frame = if let Some(raw_dictionary) = dictionary {
        let dictionary = Dictionary::decode_dict(raw_dictionary)
            .map_err(|error| format!("invalid Zstandard dictionary: {error}"))?;
        let mut frame = FrameDecoder::new();
        frame
            .add_dict(dictionary)
            .map_err(|error| format!("could not install Zstandard dictionary: {error}"))?;
        frame
    } else {
        FrameDecoder::new()
    };
    let mut decoder = StreamingDecoder::new_with_decoder(input, frame)
        .map_err(|error| format!("invalid Zstandard frame: {error:?}"))?;
    let mut output = Vec::with_capacity(expected_size);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = decoder
            .read(&mut buffer)
            .map_err(|error| format!("could not decompress Zstandard frame: {error}"))?;
        if count == 0 {
            break;
        }
        if output.len() + count > expected_size {
            return Err("Zstandard output exceeds its declared size".to_string());
        }
        output.extend_from_slice(&buffer[..count]);
    }
    if output.len() != expected_size {
        return Err(format!(
            "Zstandard output size mismatch: expected {expected_size}, got {}",
            output.len()
        ));
    }
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

        assert_eq!(
            decompress_bytes(&compressed, None, expected.len()).unwrap(),
            expected
        );
    }

    #[test]
    fn rejects_non_zstandard_input() {
        assert!(decompress_bytes(b"not a zstd frame", None, 1).is_err());
    }
}
