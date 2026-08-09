import type { ArticleSegmentPayload } from "@/client/interact/articles";
import { SEGMENT_SIZE } from "@/shared/types/api/article";

/** Upper bound when scanning for a `\n` split point. */
export const TARGET_CHUNK_CHARS = SEGMENT_SIZE;
/** Hard cap for a single client chunk when no `\n` is found in range. */
export const MAX_CHUNK_CHARS = 100_000;

export interface ClientTextChunk {
  offset: number;
  content: string;
}

export type FetchApiSegment = (
  offset: number,
) => Promise<ArticleSegmentPayload | null>;

export interface ChunkStore {
  reset(): void;
  bootstrap(
    target: number,
    unreadCount: number,
    readCount: number,
    contentLength: number,
  ): Promise<ClientTextChunk[]>;
  takeBefore(
    beforeOffset: number,
    count: number,
    contentLength: number,
  ): Promise<{ chunks: ClientTextChunk[]; exhausted: boolean }>;
  takeAfter(
    afterOffset: number,
    count: number,
    contentLength: number,
  ): Promise<{ chunks: ClientTextChunk[]; exhausted: boolean }>;
  demoteBefore(chunks: ClientTextChunk[]): void;
  demoteAfter(chunks: ClientTextChunk[]): void;
  evictBefore(budgetChars: number): void;
  evictAfter(budgetChars: number): void;
}

const SENTENCE_ENDS = ["。", ".", "！", "!", "？", "?"] as const;
const MAX_SEGMENT_PULLS = Math.ceil(MAX_CHUNK_CHARS / SEGMENT_SIZE) + 4;

function isNumberedListPeriod(text: string, index: number): boolean {
  if (index <= 0 || text[index] !== ".") return false;
  let i = index - 1;
  while (i >= 0 && text[i]! >= "0" && text[i]! <= "9") i--;
  if (i === index - 1) return false;
  const before = i >= 0 ? text[i]! : "\n";
  return before === "\n" || before === "\r" || i < 0;
}

function isSentenceEnd(text: string, index: number): boolean {
  const ch = text[index]!;
  if (!SENTENCE_ENDS.includes(ch as (typeof SENTENCE_ENDS)[number]))
    return false;
  if (ch === "." && isNumberedListPeriod(text, index)) return false;
  const next = text[index + 1];
  return next == null || next === "\n" || next === "\r" || next === " ";
}

/** Split length within accumulated text, or 0 if more segment data is needed. */
export function computeSplitLength(text: string, isEof: boolean): number {
  if (!text) return 0;

  const limit = Math.min(text.length, TARGET_CHUNK_CHARS);

  for (let i = limit; i > 0; i--) {
    if (text[i - 1] === "\n") {
      // 跳过纯空白前缀的切分点，避免产生纯空白 chunk
      if (text.slice(0, i).trim().length === 0) continue;
      return i;
    }
  }

  for (let i = limit; i > 0; i--) {
    if (isSentenceEnd(text, i - 1)) return i;
  }

  // 纯空白文本不产出 chunk
  if (text.trim().length === 0) return 0;

  if (text.length >= MAX_CHUNK_CHARS) return MAX_CHUNK_CHARS;
  if (isEof) return text.length;
  if (text.length >= TARGET_CHUNK_CHARS) return TARGET_CHUNK_CHARS;
  return 0;
}

/**
 * Split at the first paragraph boundary. Unlike computeSplitLength(), this
 * must not consume several short paragraphs into one display chunk.
 */
function computeParagraphSplitLength(text: string, isEof: boolean): number {
  if (!text) return 0;

  let paragraphStart = 0;
  while (paragraphStart < text.length) {
    const newline = text.indexOf("\n", paragraphStart);
    if (newline < 0) break;

    const paragraphEnd = newline + 1;
    if (text.slice(paragraphStart, newline).trim().length === 0) {
      paragraphStart = paragraphEnd;
      continue;
    }

    if (paragraphEnd <= TARGET_CHUNK_CHARS) return paragraphEnd;

    // A single paragraph is too large; retain the existing long-paragraph
    // fallback, but only within this paragraph.
    return computeSplitLength(text.slice(0, paragraphEnd), false);
  }

  if (paragraphStart > 0 && paragraphStart < text.length) {
    const remainder = computeParagraphSplitLength(
      text.slice(paragraphStart),
      isEof,
    );
    return remainder > 0 ? paragraphStart + remainder : 0;
  }

  return computeSplitLength(text, isEof);
}

/**
 * 按段落（\n）切分文本为 chunks。
 * 普通段落一个 chunk；超长段落（>TARGET_CHUNK_CHARS）再用 computeSplitLength
 * 降级为标点/强截断。
 */
export function splitTextIntoParagraphChunks(
  text: string,
  startOffset: number,
): ClientTextChunk[] {
  const chunks: ClientTextChunk[] = [];
  let pos = 0;

  while (pos < text.length) {
    const nlIdx = text.indexOf("\n", pos);
    if (nlIdx < 0) {
      const para = text.slice(pos);
      if (para.trim().length > 0) {
        splitLongParagraph(chunks, para, startOffset + pos);
      }
      break;
    }

    const para = text.slice(pos, nlIdx);
    if (para.trim().length > 0) {
      splitLongParagraph(chunks, para, startOffset + pos);
    }
    pos = nlIdx + 1;
  }

  return chunks;
}

/** 如果段落过长，用 computeSplitLength 降级切分 */
function splitLongParagraph(
  chunks: ClientTextChunk[],
  text: string,
  offset: number,
) {
  let pos = 0;
  while (pos < text.length) {
    const remaining = text.slice(pos);
    const isTail = pos + remaining.length === text.length;
    const splitLen = computeSplitLength(remaining, isTail);
    if (splitLen <= 0) {
      if (remaining.trim().length > 0) {
        chunks.push({ offset: offset + pos, content: remaining });
      }
      break;
    }
    const content = remaining.slice(0, splitLen);
    if (content.trim().length > 0) {
      chunks.push({ offset: offset + pos, content });
    }
    pos += splitLen;
  }
}

/**
 * Emit only complete split chunks. Incomplete tail bytes are returned separately
 * and must NOT become a display chunk on their own.
 */
function splitSpanIntoCompleteChunks(
  span: string,
  spanStart: number,
  flushIncompleteTail: boolean,
): { chunks: ClientTextChunk[]; trailingText: string } {
  const chunks: ClientTextChunk[] = [];
  let cursor = 0;

  while (cursor < span.length) {
    const remaining = span.slice(cursor);
    const isTail = cursor + remaining.length === span.length;
    const splitLen = computeParagraphSplitLength(
      remaining,
      flushIncompleteTail && isTail,
    );
    if (splitLen <= 0) break;

    chunks.push({
      offset: spanStart + cursor,
      content: remaining.slice(0, splitLen),
    });
    cursor += splitLen;
  }

  return {
    chunks,
    trailingText: span.slice(cursor),
  };
}

/** Fold non-chunk tail bytes into the last complete read chunk (abuts unread at anchor). */
function absorbTrailingIntoLastChunk(
  chunks: ClientTextChunk[],
  trailingText: string,
  spanStart: number,
  cursor: number,
): ClientTextChunk[] {
  if (trailingText.length === 0) return chunks;
  if (chunks.length === 0) return chunks;

  const last = chunks[chunks.length - 1]!;
  const expectedStart = spanStart + cursor;
  if (last.offset + last.content.length !== expectedStart) return chunks;

  return [
    ...chunks.slice(0, -1),
    {
      offset: last.offset,
      content: last.content + trailingText,
    },
  ];
}

function mergeChunkLists(
  left: ClientTextChunk[],
  right: ClientTextChunk[],
): ClientTextChunk[] {
  if (left.length === 0) return [...right];
  if (right.length === 0) return [...left];
  const byOffset = new Map<number, ClientTextChunk>();
  for (const chunk of left) byOffset.set(chunk.offset, chunk);
  for (const chunk of right) byOffset.set(chunk.offset, chunk);
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset);
}

function trimChunksFromStart(
  chunks: ClientTextChunk[],
  budgetChars: number,
): ClientTextChunk[] {
  let total = 0;
  for (const chunk of chunks) total += chunk.content.length;
  let start = 0;
  while (total > budgetChars && start < chunks.length) {
    total -= chunks[start]!.content.length;
    start += 1;
  }
  return chunks.slice(start);
}

function trimChunksFromEnd(
  chunks: ClientTextChunk[],
  budgetChars: number,
): ClientTextChunk[] {
  let total = 0;
  for (const chunk of chunks) total += chunk.content.length;
  let end = chunks.length;
  while (total > budgetChars && end > 0) {
    end -= 1;
    total -= chunks[end]!.content.length;
  }
  return chunks.slice(0, end);
}

function coversRange(
  chunks: ClientTextChunk[],
  rangeStart: number,
  rangeEnd: number,
): boolean {
  if (rangeEnd <= rangeStart) return true;
  const inRange = chunks.filter(
    (chunk) => chunk.offset >= rangeStart && chunkEnd(chunk) <= rangeEnd,
  );
  if (inRange.length === 0) return false;

  let cursor = rangeStart;
  for (const chunk of inRange) {
    if (chunk.offset > cursor) return false;
    cursor = chunkEnd(chunk);
  }
  return cursor >= rangeEnd;
}

/** Take complete read chunks with chunkEnd === beforeOffset (start of unread). */
function takeContiguousBefore(
  cache: ClientTextChunk[],
  beforeOffset: number,
  count: number,
): { taken: ClientTextChunk[]; remaining: ClientTextChunk[] } {
  if (count <= 0 || cache.length === 0 || beforeOffset <= 0) {
    return { taken: [], remaining: cache };
  }

  let endIdx = -1;
  for (let i = cache.length - 1; i >= 0; i--) {
    if (chunkEnd(cache[i]!) === beforeOffset) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) return { taken: [], remaining: cache };

  const takenRev: ClientTextChunk[] = [];
  let cursor = beforeOffset;
  let idx = endIdx;

  while (takenRev.length < count && idx >= 0) {
    const chunk = cache[idx]!;
    if (chunkEnd(chunk) !== cursor) break;
    takenRev.push(chunk);
    cursor = chunk.offset;
    idx -= 1;
  }

  if (takenRev.length === 0) return { taken: [], remaining: cache };

  const firstTaken = takenRev[takenRev.length - 1]!;
  const firstIdx = cache.indexOf(firstTaken);
  if (firstIdx < 0) return { taken: [], remaining: cache };

  return {
    taken: takenRev.reverse(),
    remaining: [
      ...cache.slice(0, firstIdx),
      ...cache.slice(firstIdx + takenRev.length),
    ],
  };
}

function takeContiguousAfter(
  cache: ClientTextChunk[],
  afterOffset: number,
  count: number,
): { taken: ClientTextChunk[]; remaining: ClientTextChunk[] } {
  if (count <= 0 || cache.length === 0) {
    return { taken: [], remaining: cache };
  }

  let startIdx = -1;
  for (let i = 0; i < cache.length; i++) {
    if (cache[i]!.offset >= afterOffset) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return { taken: [], remaining: cache };

  const taken: ClientTextChunk[] = [];
  let cursor = afterOffset;
  let idx = startIdx;

  while (taken.length < count && idx < cache.length) {
    const chunk = cache[idx]!;
    if (chunk.offset !== cursor) break;
    taken.push(chunk);
    cursor = chunkEnd(chunk);
    idx += 1;
  }

  if (taken.length === 0) return { taken: [], remaining: cache };

  return {
    taken,
    remaining: [
      ...cache.slice(0, startIdx),
      ...cache.slice(startIdx + taken.length),
    ],
  };
}

/**
 * Unified chunk cache: fetched spans are split into complete chunks only;
 * incomplete tail bytes stay in spare buffers, never as display chunks.
 */
export function createChunkStore(fetchApi: FetchApiSegment): ChunkStore {
  /** Read cache (above anchor). */
  let before: ClientTextChunk[] = [];
  /** Unread cache (below anchor). */
  let after: ClientTextChunk[] = [];
  let forwardSpare = "";
  let forwardSpareStart = -1;
  let forwardSpareEof = false;

  const resetForwardSpare = () => {
    forwardSpare = "";
    forwardSpareStart = -1;
    forwardSpareEof = false;
  };

  const alignForwardSpareTo = (offset: number) => {
    if (
      forwardSpareStart < 0 ||
      offset < forwardSpareStart ||
      offset > forwardSpareStart + forwardSpare.length
    ) {
      resetForwardSpare();
      forwardSpareStart = offset;
      return;
    }
    if (offset > forwardSpareStart) {
      forwardSpare = forwardSpare.slice(offset - forwardSpareStart);
      forwardSpareStart = offset;
    }
  };

  const pullForwardUntilSplittable = async (
    contentLength: number,
  ): Promise<boolean> => {
    let apiPos = forwardSpareStart + forwardSpare.length;
    let pulls = 0;

    while (apiPos < contentLength) {
      if (computeParagraphSplitLength(forwardSpare, forwardSpareEof) > 0) {
        return forwardSpare.length > 0;
      }

      if (pulls++ >= MAX_SEGMENT_PULLS) {
        return forwardSpare.length > 0;
      }

      const data = await fetchApi(apiPos);
      if (!data?.content) {
        forwardSpareEof = true;
        return forwardSpare.length > 0;
      }

      forwardSpare += data.content;
      apiPos = data.offset + data.content.length;
      forwardSpareEof = !data.has_more || apiPos >= contentLength;

      if (
        computeParagraphSplitLength(forwardSpare, forwardSpareEof) > 0 ||
        forwardSpareEof
      ) {
        return forwardSpare.length > 0;
      }

      if (data.content.length < SEGMENT_SIZE) {
        return forwardSpare.length > 0;
      }
    }

    forwardSpareEof = true;
    return forwardSpare.length > 0;
  };

  const emitForwardChunk = (): ClientTextChunk | null => {
    const splitLen = computeParagraphSplitLength(forwardSpare, forwardSpareEof);
    if (splitLen <= 0) return null;

    const len = Math.min(splitLen, forwardSpare.length);
    if (len <= 0) return null;

    const chunk: ClientTextChunk = {
      offset: forwardSpareStart,
      content: forwardSpare.slice(0, len),
    };
    forwardSpareStart += len;
    forwardSpare = forwardSpare.slice(len);
    if (forwardSpare.length === 0 && forwardSpareEof) {
      resetForwardSpare();
    }
    return chunk;
  };

  const buildForwardChunk = async (
    startOffset: number,
    contentLength: number,
  ): Promise<ClientTextChunk | null> => {
    if (startOffset >= contentLength) return null;

    alignForwardSpareTo(startOffset);
    if (!(await pullForwardUntilSplittable(contentLength))) return null;
    return emitForwardChunk();
  };

  /** Fetch [anchor - 100k, anchor) into read cache; tail folds into last chunk. */
  const ingestBeforeWindow = async (
    anchor: number,
    contentLength: number,
  ): Promise<void> => {
    if (anchor <= 0) return;

    const windowStart = Math.max(0, anchor - MAX_CHUNK_CHARS);
    if (coversRange(before, windowStart, anchor)) return;

    let spare = "";
    const spareStart = windowStart;
    let spareEof = false;

    while (spareStart + spare.length < anchor && !spareEof) {
      const apiPos = spareStart + spare.length;
      if (apiPos >= contentLength) {
        spareEof = true;
        break;
      }

      const data = await fetchApi(apiPos);
      if (!data?.content) {
        spareEof = true;
        break;
      }

      spare += data.content;
      spareEof =
        !data.has_more || data.offset + data.content.length >= contentLength;
    }

    if (spare.length <= 0) return;

    const spanLen = Math.min(spare.length, anchor - spareStart);
    if (spanLen <= 0) return;

    const span = spare.slice(0, spanLen);
    const { chunks, trailingText } = splitSpanIntoCompleteChunks(
      span,
      spareStart,
      false,
    );
    const merged = absorbTrailingIntoLastChunk(
      chunks,
      trailingText,
      spareStart,
      span.length - trailingText.length,
    );
    before = mergeChunkLists(before, merged);
  };

  const reset = () => {
    before = [];
    after = [];
    resetForwardSpare();
  };

  /**
   * Bootstrap around reading anchor:
   * 1. Unread (below): forward from anchor — first chunk contains restore target
   * 2. Read (above): complete chunks only, chunkEnd === anchor
   */
  const bootstrap = async (
    anchor: number,
    unreadCount: number,
    readCount: number,
    contentLength: number,
  ): Promise<ClientTextChunk[]> => {
    const loaded: ClientTextChunk[] = [];

    for (let i = 0; i < unreadCount && loaded.length < unreadCount; i++) {
      const start =
        loaded.length === 0 ? anchor : chunkEnd(loaded[loaded.length - 1]!);
      if (start >= contentLength) break;
      const chunk = await buildForwardChunk(start, contentLength);
      if (!chunk) break;
      loaded.push(chunk);
    }

    if (anchor > 0 && loaded.length > 0 && readCount > 0) {
      const unreadHead = loaded[0]!.offset;
      await ingestBeforeWindow(unreadHead, contentLength);
      const { chunks: readChunks } = await takeBefore(
        unreadHead,
        readCount,
        contentLength,
      );
      if (readChunks.length > 0) {
        loaded.unshift(...readChunks);
      }
    }

    return loaded;
  };

  const takeBefore = async (
    beforeOffset: number,
    count: number,
    contentLength: number,
  ): Promise<{ chunks: ClientTextChunk[]; exhausted: boolean }> => {
    if (count <= 0 || beforeOffset <= 0) {
      return { chunks: [], exhausted: beforeOffset <= 0 };
    }

    let cursor = beforeOffset;
    let taken: ClientTextChunk[] = [];

    while (taken.length < count && cursor > 0) {
      const next = takeContiguousBefore(before, cursor, count - taken.length);
      before = next.remaining;
      if (next.taken.length > 0) {
        taken = [...next.taken, ...taken];
        cursor = taken[0]!.offset;
        continue;
      }

      await ingestBeforeWindow(cursor, contentLength);
      const afterFetch = takeContiguousBefore(
        before,
        cursor,
        count - taken.length,
      );
      before = afterFetch.remaining;
      if (afterFetch.taken.length === 0) break;
      taken = [...afterFetch.taken, ...taken];
      cursor = taken[0]!.offset;
    }

    return {
      chunks: taken,
      exhausted: taken.length === 0 && cursor <= 0,
    };
  };

  const takeAfter = async (
    afterOffset: number,
    count: number,
    contentLength: number,
  ): Promise<{ chunks: ClientTextChunk[]; exhausted: boolean }> => {
    if (count <= 0 || afterOffset >= contentLength) {
      return { chunks: [], exhausted: afterOffset >= contentLength };
    }

    const { taken, remaining } = takeContiguousAfter(after, afterOffset, count);
    after = remaining;
    let cursor =
      taken.length > 0 ? chunkEnd(taken[taken.length - 1]!) : afterOffset;

    while (taken.length < count && cursor < contentLength) {
      const chunk = await buildForwardChunk(cursor, contentLength);
      if (!chunk) break;
      taken.push(chunk);
      cursor = chunkEnd(chunk);
    }

    return {
      chunks: taken,
      exhausted: taken.length === 0 && afterOffset >= contentLength,
    };
  };

  const demoteBefore = (chunks: ClientTextChunk[]) => {
    if (chunks.length === 0) return;
    before = mergeChunkLists(before, chunks);
  };

  const demoteAfter = (chunks: ClientTextChunk[]) => {
    if (chunks.length === 0) return;
    after = mergeChunkLists(after, chunks);
  };

  const evictBefore = (budgetChars: number) => {
    before = trimChunksFromStart(before, budgetChars);
  };

  const evictAfter = (budgetChars: number) => {
    after = trimChunksFromEnd(after, budgetChars);
  };

  return {
    reset,
    bootstrap,
    takeBefore,
    takeAfter,
    demoteBefore,
    demoteAfter,
    evictBefore,
    evictAfter,
  };
}

export function chunkEnd(chunk: ClientTextChunk): number {
  return chunk.offset + chunk.content.length;
}

export function chunkContains(chunk: ClientTextChunk, offset: number): boolean {
  return offset >= chunk.offset && offset < chunkEnd(chunk);
}
