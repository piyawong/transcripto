# /// script
# requires-python = ">=3.11"
# dependencies = ["google-genai>=2.23"]
# ///
"""Export golden-test fixtures for re-implementing the deterministic parts of the pipeline (e.g. in Rust).

Usage:
    uv run bench/export_fixtures.py

Writes docs/rust-implementation/fixtures/. No API calls: every expected output is computed here with the same
functions the bench scripts use, from API responses already saved in bench/results/.
"""
import json
import re
import shutil
from pathlib import Path

from correct import Corrections, apply_edits, leftover_numbers, render_changes
from summarize import MeetingMinutes, cited_stamps, normalize_stamp, quotes_outside_segment, render_text, spoken_text, squash
from transcribe import RESULTS_DIR, ROOT, words_to_lines

OUT = ROOT / "docs/rust-implementation/fixtures"
TRANSCRIPT = "scribe-v2-keyterms"


def write(name: str, text: str) -> None:
    (OUT / name).write_text(text)
    print(f"wrote {name}")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    # ① ElevenLabs response -> lines
    raw = RESULTS_DIR / "scribe_v2_keyterms.raw.json"
    shutil.copyfile(raw, OUT / "elevenlabs-response.json")
    print("wrote elevenlabs-response.json")
    write("lines.expected.txt", "\n".join(words_to_lines(json.loads(raw.read_text())["words"])) + "\n")

    # ② saved corrections -> corrected transcript + change log
    source = RESULTS_DIR / f"{TRANSCRIPT}.txt"
    shutil.copyfile(source, OUT / "correct.input.txt")
    print("wrote correct.input.txt")
    for model, short in (("gemini-3.1-pro", "pro"), ("gemini-3.8-flash", "flash")):
        saved = json.loads((RESULTS_DIR / f"{TRANSCRIPT}.corrected-{model}.json").read_text())
        corrections = Corrections.model_validate(saved["corrections"])
        write(f"correct-{short}.corrections.json", json.dumps(saved["corrections"], ensure_ascii=False, indent=2) + "\n")
        lines = source.read_text().splitlines()
        results = apply_edits(lines, corrections.edits)
        leftovers = leftover_numbers(lines)
        speakers = ["", "## ผู้พูด"] + [f"{s.label}: {s.role}" for s in corrections.speakers]
        write(f"correct-{short}.expected.txt", "\n".join(lines + speakers) + "\n")
        write(f"correct-{short}.expected-changes.txt", render_changes(source.name, saved["meta"]["model_id"], results, corrections, leftovers))

    # ③ saved minutes -> plain-text minutes + citation checks (both were run on the Pro-corrected transcript)
    transcript_path = RESULTS_DIR / f"{TRANSCRIPT}.corrected-gemini-3.1-pro.txt"
    transcript = transcript_path.read_text()
    known = {normalize_stamp(s) for s in re.findall(r"\d{1,3}:\d{2}", transcript)}
    flat = spoken_text(transcript)
    for model, short in (("gemini-3.1-pro", "pro"), ("gemini-3.8-flash", "flash")):
        saved = json.loads((RESULTS_DIR / f"summary-{model}.json").read_text())
        minutes = MeetingMinutes.model_validate(saved["minutes"])
        write(f"summary-{short}.minutes.json", json.dumps(saved["minutes"], ensure_ascii=False, indent=2) + "\n")
        write(f"summary-{short}.expected.txt", render_text(minutes, transcript_path, saved["meta"]["model_id"]))
        checks = {
            "unmatched_citations": sorted({normalize_stamp(s) or s for s in cited_stamps(minutes)} - known),
            "quotes_not_in_transcript": [q.text for s in minutes.segments for q in s.quotes if squash(q.text) not in flat],
            "quotes_outside_segment": quotes_outside_segment(minutes),
        }
        write(f"summary-{short}.expected-checks.json", json.dumps(checks, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
