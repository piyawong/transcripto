/**
 * Word-by-word "follow along" for a transcript line.
 *
 * Gemini gives a start/end time per line (a few seconds to ~20 s), not per word, so the spoken word is
 * estimated by spreading the line's duration over its words by length. It tracks the voice well for an
 * even speaking pace and drifts by a word or two when someone pauses mid-line.
 */

export interface Word {
  t: string;
  /** Cumulative length up to and including this word, used to map time to position. */
  end: number;
}

// Thai vowel and tone marks sit above/below a consonant and take no time of their own.
const COMBINING = /[ัิ-ฺ็-๎]/g;

// Thai has no spaces between words; Intl.Segmenter uses the platform's dictionary to find them.
const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("th", { granularity: "word" }) : null;

export function splitWords(text: string): Word[] {
  const parts = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : text.split(/(\s+)/).filter(Boolean);
  let acc = 0;
  return parts.map((t) => {
    acc += /^\s+$/.test(t) ? 0.6 : Math.max(1, t.replace(COMBINING, "").length);
    return { t, end: acc };
  });
}

/** Index of the word being spoken at `frac` (0..1) of the line's duration. */
export function wordAt(words: Word[], frac: number) {
  if (!words.length) return -1;
  const target = Math.min(Math.max(frac, 0), 0.9999) * words[words.length - 1].end;
  let lo = 0, hi = words.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}
