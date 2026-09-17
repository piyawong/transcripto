/** Word-by-word follow-along for a transcript line. */

export interface TimedToken {
  text: string;
  /** Absolute media time in seconds. */
  start: number;
  end: number;
}

export interface Word {
  t: string;
  /** Cumulative visual weight, used only when an older job has no source timestamps. */
  end: number;
  /** Absolute media time from the speech-to-text response. */
  start?: number;
}

interface Piece {
  text: string;
  /** Bounds of the spoken part, excluding attached spaces and punctuation. */
  from: number;
  to: number;
}

// Thai vowel and tone marks sit above/below a consonant and take no time of their own.
const COMBINING = /[ัิ-ฺ็-๎]/g;
const SPACE = /^\s+$/;

// Thai has no spaces between words; Intl.Segmenter uses the platform's dictionary to find them.
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("th", { granularity: "word" }) : null;

/**
 * Split text into visible words. Separators stay attached to a neighbouring word so the current highlight can never
 * land on an invisible whitespace-only span.
 */
function pieces(text: string): Piece[] {
  const segmented = segmenter
    ? Array.from(segmenter.segment(text), (s) => ({ text: s.segment, from: s.index, word: s.isWordLike }))
    : text.split(/(\s+)/).filter(Boolean).map((part, i, all) => ({ text: part, from: all.slice(0, i).join("").length, word: !SPACE.test(part) }));
  const out: Piece[] = [];
  let prefix = "";

  for (const part of segmented) {
    if (part.word) {
      out.push({ text: prefix + part.text, from: part.from, to: part.from + part.text.length });
      prefix = "";
    } else if (out.length) {
      out[out.length - 1].text += part.text;
    } else {
      prefix += part.text;
    }
  }

  if (!out.length && prefix) return [{ text: prefix, from: 0, to: text.length }];
  if (prefix && out.length) out[0].text = prefix + out[0].text;
  return out;
}

/** Map readable browser-segmented words back to the original timestamped STT character pieces. */
function sourceStarts(text: string, words: Piece[], tokens: TimedToken[]): number[] | null {
  if (!tokens.length || tokens.some((token) => !Number.isFinite(token.start) || !Number.isFinite(token.end))) return null;
  const raw = tokens.map((token) => token.text).join("");
  const leading = raw.length - raw.trimStart().length;
  if (raw.trim() !== text) return null;

  const ranges: { from: number; to: number; start: number }[] = [];
  let cursor = -leading;
  for (const token of tokens) {
    const from = cursor;
    cursor += token.text.length;
    ranges.push({ from, to: cursor, start: token.start });
  }

  const starts = words.map((word) => ranges.find((token) => token.to > word.from && token.from < word.to)?.start ?? Number.NaN);
  return starts.every(Number.isFinite) ? starts : null;
}

export function splitWords(text: string, tokens: TimedToken[] = []): Word[] {
  const parts = pieces(text);
  const starts = sourceStarts(text, parts, tokens);
  let acc = 0;
  return parts.map((part, i) => {
    const spoken = text.slice(part.from, part.to);
    acc += Math.max(1, spoken.replace(COMBINING, "").length);
    return { t: part.text, end: acc, start: starts?.[i] };
  });
}

/** Index of the word being spoken at absolute media time `time`. */
export function wordAt(words: Word[], time: number, segmentStart: number, segmentEnd: number) {
  if (!words.length) return -1;

  // Exact source timestamps are preferred. Keep the last word selected through a short pause until the next starts.
  if (words.every((word) => word.start !== undefined)) {
    let lo = 0, hi = words.length - 1, answer = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start! <= time) {
        answer = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return answer;
  }

  // Jobs made before word timestamps were stored, and edited lines whose source no longer matches, use an estimate.
  const frac = (time - segmentStart) / Math.max(0.1, segmentEnd - segmentStart);
  const target = Math.min(Math.max(frac, 0), 0.9999) * words[words.length - 1].end;
  let lo = 0, hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
