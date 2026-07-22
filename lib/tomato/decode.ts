import {
  READER_CHARSET,
  READER_PUA_START,
  SEARCH_CHARSET,
  SEARCH_PUA_START,
} from "./charset";

function decodeWith(value: string, charset: string, start: number): string {
  let decoded = "";
  for (const character of value) {
    const offset = character.codePointAt(0)! - start;
    const mapped = charset[offset];
    decoded +=
      offset >= 0 && offset < charset.length && mapped !== "?"
        ? mapped
        : character;
  }
  return decoded;
}

export function decodeReaderText(value: string): string {
  return decodeWith(value, READER_CHARSET, READER_PUA_START);
}

export function decodeSearchText(value: string): string {
  return decodeWith(value, SEARCH_CHARSET, SEARCH_PUA_START);
}
