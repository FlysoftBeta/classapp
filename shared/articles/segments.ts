export const TEXT_ARTICLE_SEGMENT_SIZE = 10_000;

export interface TextArticleSegment {
  index: number;
  startOffset: number;
  content: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Reader offsets are JavaScript UTF-16 offsets. Segments contain at most 10k
 * code units, but a boundary moves back one unit when the hard cut would split
 * a surrogate pair.
 */
export function splitTextArticle(
  text: string,
  maxLength = TEXT_ARTICLE_SEGMENT_SIZE,
): TextArticleSegment[] {
  if (!Number.isInteger(maxLength) || maxLength < 2) {
    throw new Error(
      "Text article segment size must be an integer of at least 2",
    );
  }
  const segments: TextArticleSegment[] = [];
  let startOffset = 0;
  while (startOffset < text.length) {
    let endOffset = Math.min(text.length, startOffset + maxLength);
    if (
      endOffset < text.length &&
      isHighSurrogate(text.charCodeAt(endOffset - 1)) &&
      isLowSurrogate(text.charCodeAt(endOffset))
    ) {
      endOffset -= 1;
    }
    segments.push({
      index: segments.length,
      startOffset,
      content: text.slice(startOffset, endOffset),
    });
    startOffset = endOffset;
  }
  return segments;
}
