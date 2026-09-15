# /// script
# requires-python = ">=3.11"
# dependencies = ["google-genai>=2.23"]
# ///
"""Fix context errors and spoken numbers in an ElevenLabs transcript with Gemini, as an audited change list.

The model never rewrites the transcript. It returns edits {timestamp, original, replacement, kind, reason};
the script applies an edit only if `original` appears verbatim in the line with that timestamp (or a unique
match within 30 seconds), and rejects edits that are too long or would change a polite particle (ครับ/ค่ะ/คะ).
Name changes are never applied automatically: they are listed for a person to confirm, because a wrong glossary
entry otherwise turns correct names into wrong ones. Number words that are still left after the edits are listed too.
Speaker labels and timestamps are never touched.

Usage:
    uv run bench/correct.py gemini-3.8-flash
    uv run bench/correct.py gemini-3.1-pro --transcript bench/results/scribe-v2-keyterms.txt
    uv run bench/correct.py gemini-3.1-pro --transcript bench/results/scribe-v2-keyterms.txt --reapply   # no API call

Output in bench/results/, named after the transcript:
    <name>.corrected-<model>.txt   corrected transcript + "## ผู้พูด" section (input for summarize.py)
    <name>.changes-<model>.txt     every proposed edit, applied or rejected with the reason (plain text)
    <name>.corrected-<model>.json  run metadata: tokens, cost, counts
"""
import argparse
import json
import re
import time
from enum import Enum
from pathlib import Path

from pydantic import BaseModel, Field

from summarize import MODELS, normalize_stamp, seconds
from transcribe import RESULTS_DIR, ROOT, load_env

BENCH_DIR = Path(__file__).resolve().parent
DEFAULT_TRANSCRIPT = RESULTS_DIR / "scribe-v2-keyterms.txt"
DEFAULT_GLOSSARY = BENCH_DIR / "keyterms.txt"
MAX_ORIGINAL_CHARS = 40
PARTICLES = ("ครับ", "ค่ะ", "คะ", "ฮะ")
LINE_RE = re.compile(r"^(\[(\d{1,3}:\d{2})\]\s*(?:ผู้พูด\s*\d+\s*[:：]\s*)?)(.*)$")
# A Thai number word directly followed by a unit is almost always a quantity; used only to report leftovers.
LEFTOVER_NUMBER_RE = re.compile(
    r"(?:หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ยี่สิบ|ร้อย|พัน|หมื่น|แสน|ล้าน)+\s?"
    r"(?:เปอร์เซ็นต์|ตารางเมตร|ชั่วโมง|สัปดาห์|อาทิตย์|เดือน|นาที|สาขา|เมือง|ครั้ง|แห่ง|บาท|วิธี|ราย|ปี|วัน|คน|เขต)"
)
THAI_LETTER_RE = re.compile(r"[ก-๏]")
DIGIT_RE = re.compile(r"[0-9]")

PROMPT = """You are proofreading a Thai meeting transcript produced by speech recognition (ElevenLabs Scribe).
The recognizer writes what it hears literally, so unclear speech sometimes comes out as similar-sounding but wrong words
(e.g. "พลังเม็ด" where the context clearly means "ตารางเมตร"). It also writes numbers as Thai words.

Transcript lines look like "[MM:SS] ผู้พูด N: text". A glossary of names and terms used in this meeting is provided.

Return a list of edits. Never rewrite whole lines.

Edit kinds:
1. correction: a word or short phrase that is clearly a mis-hearing. The surrounding context makes the intended words obvious
   AND the replacement sounds similar to what was written. Use the glossary for names and terms.
2. number: a Thai number word that denotes a quantity, percentage, amount, duration, date, ordinal, or grade level. Convert it to digits:
   ร้อยเปอร์เซ็นต์ → 100%, สองปีสิบเดือน → 2 ปี 10 เดือน, เจ็ดพันหรือแปดพัน → 7,000 หรือ 8,000, ป.หนึ่ง → ป.1, ยี่สิบสามสิบแห่ง → 20-30 แห่ง.
   Convert every occurrence, one edit each. Keep repeated words: สองสองคน → 2 2 คน.
   Do not convert words that are not quantities: สามารถ, อันหนึ่ง or คนหนึ่ง meaning "a / one of", สองจิตสองใจ and other idioms.
3. name: the replacement changes a person's name or nickname (e.g. คุณแคลร์ → คุณแพร). These are shown to a person to confirm,
   so propose them only when the sound is close and the context shows it is the same person.

Rules:
- original must be copied exactly from the line with that timestamp, and be as short as possible (a few words).
- Do not change filler words, repetitions, grammar, word order, or polite particles (ครับ, ค่ะ, คะ, นะคะ).
- Do not change names that are used consistently or match the glossary. Do not "improve" wording that is already plausible.
- Do not convert English words or Thai transliterations of English words either way (e.g. เอเย่นต์, ออนไลน์, San Yuan Li).
- If a span is garbled and the intended words cannot be recovered with confidence, do not guess: list it in unclear.
- speakers: for each speaker label, give the role or name only if it is stated or clearly implied in the transcript
  (e.g. someone is invited to speak by title, or addressed by name right before speaking); otherwise ไม่ทราบ."""


class EditKind(str, Enum):
    correction = "correction"
    number = "number"
    name = "name"


NEEDS_CONFIRMATION = "ชื่อคน รอคนยืนยันก่อนแก้"


class Edit(BaseModel):
    timestamp: str = Field(description="MM:SS of the transcript line")
    original: str = Field(description="Exact text copied from that line, as short as possible")
    replacement: str
    kind: EditKind
    reason: str = Field(description="Short reason in Thai")


class Unclear(BaseModel):
    timestamp: str
    text: str = Field(description="The garbled span, copied from the line")
    reason: str = Field(description="Short reason in Thai")


class Speaker(BaseModel):
    label: str = Field(description="Speaker label as in the transcript, e.g. ผู้พูด 3")
    role: str = Field(description="Role or name if stated or clearly implied, otherwise ไม่ทราบ")


class Corrections(BaseModel):
    edits: list[Edit]
    unclear: list[Unclear]
    speakers: list[Speaker]


def rejection(edit: Edit) -> str | None:
    if edit.kind is EditKind.name:
        return NEEDS_CONFIRMATION
    if not edit.original or edit.original == edit.replacement:
        return "ไม่มีการเปลี่ยนแปลง"
    if len(edit.original) > MAX_ORIGINAL_CHARS:
        return f"ข้อความเดิมยาวเกิน {MAX_ORIGINAL_CHARS} ตัวอักษร (ป้องกันการเขียนใหม่ทั้งประโยค)"
    if any(edit.original.count(p) != edit.replacement.count(p) for p in PARTICLES):
        return "เปลี่ยนคำลงท้าย ครับ/ค่ะ"
    if edit.kind is EditKind.number and not re.search(r"\d", edit.replacement):
        return "แก้ตัวเลขแต่ผลลัพธ์ไม่มีตัวเลข"
    return None


def pad_digits(before: str, replacement: str, after: str) -> str:
    """Put a space between digits and Thai letters at the edges of a replacement ("ตั้ง5 50%" -> "ตั้ง 5 50%").

    The model often returns just the number, so it would otherwise be glued to the surrounding Thai words.
    """
    if not replacement:
        return replacement
    first, last = replacement[0], replacement[-1]
    if before and ((THAI_LETTER_RE.match(before) and DIGIT_RE.match(first)) or ((DIGIT_RE.match(before) or before == "%") and THAI_LETTER_RE.match(first))):
        replacement = " " + replacement
    if after and (((DIGIT_RE.match(last) or last == "%") and THAI_LETTER_RE.match(after)) or (THAI_LETTER_RE.match(last) and DIGIT_RE.match(after))):
        replacement += " "
    return replacement


def apply_edits(lines: list[str], edits: list[Edit]) -> list[tuple[Edit, str | None]]:
    """Apply edits in place. Returns (edit, None) when applied or (edit, reason) when rejected."""
    parsed = [LINE_RE.match(line) for line in lines]
    results = []
    for edit in edits:
        reason = rejection(edit)
        if reason is None:
            stamp = normalize_stamp(edit.timestamp)
            same = [i for i, m in enumerate(parsed) if m and normalize_stamp(m.group(2)) == stamp and edit.original in lines[i][len(m.group(1)):]]
            near = [
                i
                for i, m in enumerate(parsed)
                if m and stamp and abs(seconds(m.group(2)) - seconds(stamp)) <= 30 and edit.original in lines[i][len(m.group(1)):]
            ]
            targets = same or (near if len(near) == 1 else [])
            if not targets:
                reason = "ไม่พบข้อความเดิมในบรรทัดนั้น (หรือพบหลายที่)"
            else:
                i = targets[0]
                prefix = parsed[i].group(1)
                body = lines[i][len(prefix):]
                start = body.index(edit.original)
                end = start + len(edit.original)
                replacement = pad_digits(body[start - 1 : start], edit.replacement, body[end : end + 1])
                lines[i] = prefix + body[:start] + replacement + body[end:]
        results.append((edit, reason))
    return results


def leftover_numbers(lines: list[str]) -> list[str]:
    found = []
    for line in lines:
        m = LINE_RE.match(line)
        if m:
            found += [f"[{m.group(2)}] {hit.group()}" for hit in LEFTOVER_NUMBER_RE.finditer(m.group(3))]
    return found


def render_changes(name: str, model_id: str, results: list[tuple[Edit, str | None]], c: Corrections, leftovers: list[str]) -> str:
    applied = [e for e, r in results if r is None]
    to_confirm = [e for e, r in results if r == NEEDS_CONFIRMATION]
    rejected = [(e, r) for e, r in results if r is not None and r != NEEDS_CONFIRMATION]
    out = [
        f"ผลตรวจแก้ข้อความ {name} ด้วย {model_id}",
        f"แก้แล้ว {len(applied)} จุด (แก้จากบริบท {sum(e.kind is EditKind.correction for e in applied)} · "
        f"ตัวเลข {sum(e.kind is EditKind.number for e in applied)}) · ชื่อคนรอยืนยัน {len(to_confirm)} · ไม่ได้แก้ {len(rejected)} · "
        f"ถอดเพี้ยนจนแก้ไม่ได้ {len(c.unclear)} · ตัวเลขที่ยังไม่แปลง {len(leftovers)}",
    ]
    for kind, title in ((EditKind.correction, "แก้จากบริบท"), (EditKind.number, "แปลงเป็นตัวเลข")):
        items = [e for e in applied if e.kind is kind]
        if items:
            out += ["", title] + [f"[{e.timestamp}] {e.original} -> {e.replacement} ({e.reason})" for e in items]
    if to_confirm:
        out += ["", "ชื่อคนที่เสนอให้แก้ (ยังไม่ได้แก้ รอคนยืนยัน)"] + [f"[{e.timestamp}] {e.original} -> {e.replacement} ({e.reason})" for e in to_confirm]
    if rejected:
        out += ["", "ไม่ได้แก้ (สคริปต์ปฏิเสธ)"] + [f"[{e.timestamp}] {e.original} -> {e.replacement} เหตุผล: {r}" for e, r in rejected]
    if c.unclear:
        out += ["", "ช่วงที่ถอดเพี้ยนจนแก้ไม่ได้ ควรฟังเสียง"] + [f"[{u.timestamp}] {u.text} ({u.reason})" for u in c.unclear]
    if leftovers:
        out += ["", "คำบอกจำนวนที่ยังไม่ได้แปลงเป็นตัวเลข"] + leftovers
    out += ["", "ผู้พูด"] + [f"{s.label}: {s.role}" for s in c.speakers]
    return "\n".join(out) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", choices=sorted(MODELS))
    parser.add_argument("--transcript", type=Path, default=DEFAULT_TRANSCRIPT)
    parser.add_argument("--glossary", type=Path, default=DEFAULT_GLOSSARY)
    parser.add_argument("--reapply", action="store_true", help="re-apply the edits saved in the .json without calling the API")
    args = parser.parse_args()

    model_id, price_in, price_out = MODELS[args.model]
    lines = args.transcript.read_text().splitlines()
    name = args.transcript.stem
    base = RESULTS_DIR / f"{name}.corrected-{args.model}"

    if args.reapply:
        saved = json.loads(Path(f"{base}.json").read_text())
        corrections = Corrections.model_validate(saved["corrections"])
        meta = saved["meta"]
    else:
        load_env(ROOT / ".env.test")
        from google import genai
        from google.genai import types

        glossary = [t.strip() for t in args.glossary.read_text().splitlines() if t.strip() and not t.startswith("#")]
        content = "ชื่อและคำศัพท์ในการประชุมนี้:\n" + "\n".join(f"- {t}" for t in glossary) + "\n\nTRANSCRIPT:\n" + "\n".join(lines)

        print(f"correcting {args.transcript.name} ({len(lines)} lines) with {model_id} ...", flush=True)
        # Keep a reference: a temporary Client is garbage-collected and closes its HTTP connection mid-call.
        client = genai.Client()
        started = time.monotonic()
        response = client.models.generate_content(
            model=model_id,
            contents=content,
            config=types.GenerateContentConfig(
                system_instruction=PROMPT,
                response_mime_type="application/json",
                response_schema=Corrections,
                max_output_tokens=65536,
                automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            ),
        )
        elapsed = time.monotonic() - started
        corrections = response.parsed if isinstance(response.parsed, Corrections) else Corrections.model_validate_json(response.text)
        usage = response.usage_metadata
        tokens_in, tokens_out, tokens_thinking = usage.prompt_token_count or 0, usage.candidates_token_count or 0, usage.thoughts_token_count or 0
        meta = {
            "model_id": model_id,
            "transcript": str(args.transcript),
            "finish_reason": response.candidates[0].finish_reason.name if response.candidates else None,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "tokens_thinking": tokens_thinking,
            "cost_usd": round((tokens_in * price_in + (tokens_out + tokens_thinking) * price_out) / 1e6, 4),
            "elapsed_seconds": round(elapsed, 1),
        }

    results = apply_edits(lines, corrections.edits)
    leftovers = leftover_numbers(lines)
    speaker_section = ["", "## ผู้พูด"] + [f"{s.label}: {s.role}" for s in corrections.speakers]

    Path(f"{base}.txt").write_text("\n".join(lines + speaker_section) + "\n")
    (RESULTS_DIR / f"{name}.changes-{args.model}.txt").write_text(
        render_changes(args.transcript.name, model_id, results, corrections, leftovers)
    )

    meta |= {
        "edits_proposed": len(results),
        "applied_correction": sum(r is None and e.kind is EditKind.correction for e, r in results),
        "applied_number": sum(r is None and e.kind is EditKind.number for e, r in results),
        "names_to_confirm": sum(r == NEEDS_CONFIRMATION for _, r in results),
        "rejected": sum(r is not None and r != NEEDS_CONFIRMATION for _, r in results),
        "unclear": len(corrections.unclear),
        "leftover_numbers": len(leftovers),
    }
    Path(f"{base}.json").write_text(json.dumps({"meta": meta, "corrections": corrections.model_dump(mode="json")}, ensure_ascii=False, indent=2))
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
