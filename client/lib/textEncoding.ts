export type SupportedTextEncoding = "utf-8" | "gbk";

export interface DecodedText {
  text: string;
  encoding: SupportedTextEncoding;
}

/**
 * Decode an uploaded text file as UTF-8 when it is valid UTF-8, falling back
 * to GBK otherwise. Strict UTF-8 decoding is important here because the
 * default decoder silently replaces invalid bytes and would make GBK text
 * look successfully decoded while producing mojibake.
 */
export function decodeUploadedText(bytes: Uint8Array): DecodedText {
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      encoding: "utf-8",
    };
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }

  return {
    text: new TextDecoder("gbk").decode(bytes),
    encoding: "gbk",
  };
}
