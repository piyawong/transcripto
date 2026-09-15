# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Compare two or more transcripts of the same audio side by side, in fixed time windows.

Usage:
    uv run bench/compare.py gemini-3.1-pro scribe-v2
    uv run bench/compare.py gemini-3.1-pro scribe-v2 paxa-stt-lite
    uv run bench/compare.py gemini-3.1-pro paxa-stt-lite --until 660

Reads bench/results/<name>.txt (lines starting with [MM:SS], optional "ผู้พูด N:" label) and writes
bench/results/compare-<a>-vs-<b>[-vs-<c>...].txt (plain text). Agreement is character similarity after removing
spaces and punctuation, computed for every pair, so windows where models disagree most are the ones to check
by ear first. A transcript that stops early (e.g. a shorter cut) is left out of the windows it doesn't cover.
Each line's text is spread over the time until the next line, so window edges are estimates; Gemini's
own timestamps are also approximate, so a few words near an edge can land in the neighbouring window.
"""
import argparse
import re
import unicodedata
from difflib import SequenceMatcher
from itertools import combinations
from pathlib import Path

RESULTS_DIR = Path(__file__).resolve().parent / "results"
LINE_RE = re.compile(r"^\[(\d{1,3}):(\d{2})\]\s*(?:ผู้พูด\s*\d+\s*[:：])?\s*(.*)$")
END_MARK_RE = re.compile(r"\(\d{1,3}:\d{2}\)")

# Display names with the company, so model names are not confused with vendors.
LABELS = {
    "gemini-3.1-pro": "Gemini 3.1 Pro (Google)",
    "gemini-3.1-pro-diarize": "Gemini 3.1 Pro แยกผู้พูด (Google)",
    "scribe-v2": "Scribe v2 (ElevenLabs)",
    "scribe-v2-keyterms": "Scribe v2 + keyterms (ElevenLabs)",
    "scribe-v2.corrected-gemini-3.8-flash": "ElevenLabs + ตรวจแก้ Gemini 3.8 Flash",
    "scribe-v2.corrected-gemini-3.1-pro": "ElevenLabs + ตรวจแก้ Gemini 3.1 Pro",
    "paxa-stt-lite": "Paxa STT Lite (Paxa Labs)",
}
SHORT = {
    "gemini-3.1-pro": "Gemini",
    "gemini-3.1-pro-diarize": "Gemini แยกผู้พูด",
    "scribe-v2": "ElevenLabs",
    "scribe-v2-keyterms": "ElevenLabs+keyterms",
    "scribe-v2.corrected-gemini-3.8-flash": "ElevenLabs+Flash",
    "scribe-v2.corrected-gemini-3.1-pro": "ElevenLabs+Pro",
    "paxa-stt-lite": "Paxa",
}


def read_lines(path: Path) -> list[tuple[int, str]]:
    lines = []
    for raw in path.read_text().splitlines():
        m = LINE_RE.match(raw.strip())
        if m:
            lines.append((int(m.group(1)) * 60 + int(m.group(2)), END_MARK_RE.sub("", m.group(3)).strip()))
    return lines


def normalize(text: str) -> str:
    # \W would also strip Thai vowel and tone marks, so remove only spaces and punctuation.
    return re.sub(r"[\s.,!?;:\"'“”‘’()\[\]{}\-–—…/]+", "", text)


def similarity(a: str, b: str) -> float:
    a, b = normalize(a), normalize(b)
    if not a and not b:
        return 1.0
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def cut_point(text: str, i: int) -> int:
    """Nearest space within 10 chars of i, else i moved past any Thai combining marks."""
    i = max(0, min(len(text), i))
    spaces = [j for j in range(max(0, i - 10), min(len(text), i + 10)) if text[j] == " "]
    if spaces:
        return min(spaces, key=lambda j: abs(j - i))
    while i < len(text) and unicodedata.category(text[i]) == "Mn":
        i += 1
    return i


def windows(lines: list[tuple[int, str]], size: int, tail_seconds: int = 5) -> dict[int, str]:
    """Spread each line's text over the windows between its start and the next line's start.

    Lines can run 20-30s, so putting a whole line in its start window would misalign the transcripts.
    """
    out: dict[int, list[str]] = {}
    for i, (start, text) in enumerate(lines):
        end = max(lines[i + 1][0] if i + 1 < len(lines) else start + tail_seconds, start + 1)
        pos, t = 0, start
        while t < end:
            k = t // size
            piece_end = min(end, (k + 1) * size)
            cut = len(text) if piece_end >= end else cut_point(text, pos + round(len(text) * (piece_end - t) / (end - start)))
            out.setdefault(k, []).append(text[pos:cut].strip())
            pos, t = cut, piece_end
    return {k: " ".join(p for p in v if p) for k, v in out.items()}


def mmss(seconds: int) -> str:
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("names", nargs="+", help="result names in bench/results, at least two")
    parser.add_argument("--window", type=int, default=30, help="window size in seconds (default 30)")
    parser.add_argument("--worst", type=int, default=10, help="how many low-agreement windows to list first")
    parser.add_argument("--until", type=int, help="only compare the first N seconds")
    args = parser.parse_args()
    if len(args.names) < 2:
        parser.error("give at least two transcripts")

    size = args.window
    label = {n: LABELS.get(n, n) for n in args.names}
    short = {n: SHORT.get(n, n) for n in args.names}
    win: dict[str, dict[int, str]] = {}
    covered: dict[str, int] = {}  # number of windows each transcript covers, from its last line
    for n in args.names:
        lines = read_lines(RESULTS_DIR / f"{n}.txt")
        win[n] = windows(lines, size)
        covered[n] = max(s for s, _ in lines) // size + 1 if lines else 0

    keys = sorted(set().union(*(w.keys() for w in win.values())))
    if args.until:
        keys = [k for k in keys if (k + 1) * size <= args.until]
    pairs = list(combinations(args.names, 2))
    scores = {
        (k, pair): similarity(win[pair[0]].get(k, ""), win[pair[1]].get(k, ""))
        for k in keys
        for pair in pairs
        if k < covered[pair[0]] and k < covered[pair[1]]
    }

    out = [f"เทียบข้อความถอดเสียง {len(args.names)} ตัว", ""]
    for n in args.names:
        mine = [k for k in keys if k < covered[n]]
        chars = sum(len(normalize(win[n].get(k, ""))) for k in mine)
        span = f"00:00-{mmss((mine[-1] + 1) * size)}" if mine else "ไม่มีข้อความ"
        out.append(f"- {label[n]}: {chars:,} ตัวอักษร (ไม่นับช่องว่างและเครื่องหมาย) ช่วง {span}")

    out += ["", "ความตรงกันแต่ละคู่ (เฉลี่ยถ่วงน้ำหนักตามความยาว เฉพาะช่วงที่ทั้งคู่ถอดไว้)"]
    for a, b in pairs:
        ks = [k for k in keys if (k, (a, b)) in scores]
        weights = {k: len(normalize(win[a].get(k, ""))) + len(normalize(win[b].get(k, ""))) for k in ks}
        overall = sum(scores[k, (a, b)] * weights[k] for k in ks) / (sum(weights.values()) or 1)
        out.append(f"- {short[a]} กับ {short[b]}: {overall:.0%} ({len(ks)} ช่วง)")
    out += [
        f"แบ่งช่วงละ {size} วินาที · ความต่างของรูปแบบการเขียน (ตัวเลขเป็นคำหรือเป็นตัวเลข, คำอังกฤษหรือคำทับศัพท์) ก็นับเป็นความต่างด้วย",
        "",
        f"ช่วงที่ต่างกันมากที่สุด {args.worst} อันดับ (ดูจากคู่ที่ตรงกันน้อยที่สุดในช่วงนั้น ควรฟังเช็คก่อน)",
    ]
    lowest = {k: min(((s, p) for (kk, p), s in scores.items() if kk == k), default=None) for k in keys}
    ranked = sorted((k for k in keys if lowest[k]), key=lambda k: lowest[k][0])
    for k in ranked[: args.worst]:
        s, (a, b) = lowest[k]
        out.append(f"- {mmss(k * size)}-{mmss((k + 1) * size)} ต่ำสุด {s:.0%} ({short[a]} กับ {short[b]})")
    summary_end = len(out)

    width = max(len(v) for v in label.values())
    for k in keys:
        pair_text = " · ".join(f"{short[a]}/{short[b]} {scores[k, (a, b)]:.0%}" for a, b in pairs if (k, (a, b)) in scores)
        out += ["", f"[{mmss(k * size)}-{mmss((k + 1) * size)}] {pair_text}"]
        for n in args.names:
            text = win[n].get(k, "(ไม่มีข้อความ)") if k < covered[n] else "(ไม่ได้ถอดช่วงนี้)"
            out.append(f"{label[n].ljust(width)} : {text}")

    suffix = f"-first{args.until}s" if args.until else ""
    path = RESULTS_DIR / f"compare-{'-vs-'.join(args.names)}{suffix}.txt"
    path.write_text("\n".join(out) + "\n")
    print("\n".join(out[:summary_end]))
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
