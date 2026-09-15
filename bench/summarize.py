# /// script
# requires-python = ">=3.11"
# dependencies = ["google-genai>=2.23"]
# ///
"""Turn a Thai meeting transcript into detailed chronological minutes with Gemini.

The minutes follow the meeting in order: who reported on what (in detail), and each stretch where
an executive such as ประธานอาวุโส gave advice, with verbatim key quotes.

Usage:
    uv run bench/summarize.py gemini-3.8-flash
    uv run bench/summarize.py gemini-3.1-pro --transcript bench/results/gemini-3.1-pro-diarize.txt
    uv run bench/summarize.py gemini-3.8-flash --rerender    # rebuild the .txt from the saved .json, no API call

Output: bench/results/summary-<model>.json (structured data + run metadata) and .txt (plain-text minutes).
Citations and quotes are checked against the transcript; anything that doesn't line up is reported.
"""
import argparse
import json
import re
import sys
import time
from enum import Enum
from pathlib import Path

from pydantic import BaseModel, Field

from transcribe import RESULTS_DIR, ROOT, load_env

DEFAULT_TRANSCRIPT = RESULTS_DIR / "scribe-v2-keyterms.corrected-gemini-3.1-pro.txt"

# id, USD per 1M input tokens, USD per 1M output tokens (thinking billed as output).
# From ai.google.dev/gemini-api/docs/pricing, checked 2026-09-15. Flash prices double on 2027-01-01.
MODELS = {
    "gemini-3.1-pro": ("gemini-3.1-pro-preview", 2.00, 12.00),
    "gemini-3.8-flash": ("gemini-3.8-flash", 0.75, 3.75),
}

PROMPT = """You are writing detailed meeting minutes in Thai for executives who did not attend, based on an automatically generated transcript.

Transcript lines look like "[MM:SS] ผู้พูด N: text" (a line may end with its end time in parentheses). The transcript may end with a "## ผู้พูด" section mapping speaker labels to roles.
It came from speech recognition, so some words, names, and numbers may be wrong.

Split the meeting into segments in chronological order:
- report: someone presents or reports on a subject.
- advice: an executive, especially ประธานอาวุโส, gives advice, comments, or directives.
- discussion: a back-and-forth of questions and answers.
Start a new segment when the speaker or their purpose or subject changes. Very short interjections belong to the surrounding segment or to a discussion segment. Do not create segments for greetings or for chairing (inviting the next speaker) unless they contain substance.

For every segment:
- details: be thorough. Cover everything of substance in the order it was said: context, facts, numbers, names, problems, causes, plans, examples, and reasons. Write one complete, specific Thai sentence per point. Do not merge distinct points or reduce them to generic statements.
- For advice segments, write each piece of advice or directive as its own point, including the reasoning or examples given and what the speaker wants done. Set responds_to to the subject of the report it responds to, if any.
- quotes: for advice segments, 1-3 short key phrases copied verbatim from the transcript that capture the main advice or directive, each with the start time of its line. Other segments may have none.

Rules:
- Use only information in the transcript. Do not add outside knowledge or assumptions.
- Attribute segments to the role or name when known (e.g. ประธานอาวุโส, คุณเบน), otherwise to the speaker label.
- Keep numbers exactly as stated. Keep English terms and proper names as written.
- Copy MM:SS times exactly from the transcript.
- Plain text only inside every field: no Markdown, asterisks, or bullet symbols.
- action_items: directives and follow-ups that were requested. Fill owner and due only when explicitly stated.
- If a name, number, or statement looks mis-transcribed or ambiguous, keep it as written and list it in needs_confirmation."""


class SegmentKind(str, Enum):
    report = "report"
    advice = "advice"
    discussion = "discussion"


class Quote(BaseModel):
    text: str = Field(description="Short phrase copied verbatim from the transcript")
    timestamp: str = Field(description="MM:SS start time of the transcript line containing the phrase")


class Segment(BaseModel):
    kind: SegmentKind
    speaker: str = Field(description="Who reports or advises, by role or name; for discussion, the participants, e.g. ประธานอาวุโส / คุณเบน")
    subject: str = Field(description="Short Thai noun phrase for what it is about, without a leading 'เรื่อง'")
    responds_to: str | None = Field(description="For advice or discussion: subject of the report it responds to, if any")
    start: str = Field(description="MM:SS")
    end: str = Field(description="MM:SS")
    details: list[str]
    quotes: list[Quote]


class ActionItem(BaseModel):
    task: str
    requested_by: str | None = Field(description="Who gave the directive or request")
    owner: str | None = Field(description="Responsible person, only if explicitly stated; otherwise null")
    due: str | None = Field(description="Deadline, only if explicitly stated; otherwise null")
    timestamps: list[str]


class Check(BaseModel):
    text: str = Field(description="What looks mis-transcribed or ambiguous, and why")
    timestamps: list[str]


class Participant(BaseModel):
    speaker: str = Field(description="Speaker label as in the transcript, e.g. ผู้พูด 1")
    role: str = Field(description="Role or name if stated in the meeting, otherwise ไม่ทราบ")


class MeetingMinutes(BaseModel):
    title: str
    participants: list[Participant]
    overview: str = Field(description="2-3 sentences: what the meeting covered and the main outcomes")
    segments: list[Segment]
    action_items: list[ActionItem]
    needs_confirmation: list[Check]


KIND_LABEL = {SegmentKind.report: "รายงาน", SegmentKind.advice: "ข้อชี้แนะ", SegmentKind.discussion: "ถาม-ตอบ"}
STAMP_RE = re.compile(r"(\d{1,3}):(\d{2})")


def normalize_stamp(value: str) -> str | None:
    m = STAMP_RE.search(value)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


def seconds(stamp: str) -> int:
    m = STAMP_RE.search(stamp)
    return int(m.group(1)) * 60 + int(m.group(2)) if m else -1


def cited_stamps(m: MeetingMinutes) -> list[str]:
    # Segment end times are left out: models often derive them (next segment start minus 1s).
    stamps = [seg.start for seg in m.segments]
    stamps += [q.timestamp for seg in m.segments for q in seg.quotes]
    stamps += [s for a in m.action_items for s in a.timestamps]
    stamps += [s for c in m.needs_confirmation for s in c.timestamps]
    return stamps


def quotes_outside_segment(m: MeetingMinutes) -> list[str]:
    """Quotes whose time falls outside their segment (up to the next segment's start)."""
    found = []
    for i, seg in enumerate(m.segments):
        limit = seconds(m.segments[i + 1].start) if i + 1 < len(m.segments) else max(seconds(seg.end), seconds(seg.start))
        found += [f"{q.timestamp} {q.text}" for q in seg.quotes if not seconds(seg.start) <= seconds(q.timestamp) <= limit]
    return found


def squash(text: str) -> str:
    return re.sub(r"\s+", "", text)


def spoken_text(transcript: str) -> str:
    """Transcript without line prefixes and end-time markers, so quotes spanning lines still match."""
    text = re.sub(r"^\[\d{1,3}:\d{2}\]\s*(ผู้พูด\s*\d+\s*[:：])?", "", transcript, flags=re.MULTILINE)
    return squash(re.sub(r"\(\d{1,3}:\d{2}\)", "", text))


def heading(seg: Segment) -> str:
    if seg.kind is SegmentKind.report:
        return f"{seg.speaker} รายงานเรื่อง{seg.subject}"
    if seg.kind is SegmentKind.advice:
        return f"{seg.speaker} ให้ข้อชี้แนะเรื่อง{seg.subject}"
    return f"ถาม-ตอบเรื่อง{seg.subject} ({seg.speaker})"


def render_text(m: MeetingMinutes, source: Path, model_id: str) -> str:
    out = [m.title, "", m.overview, "", "ผู้เข้าร่วม"]
    out += [f"- {p.speaker}: {p.role}" for p in m.participants]

    out += ["", "ลำดับการประชุม"]
    out += [f"{i}. {s.start}-{s.end} {KIND_LABEL[s.kind]}: {s.speaker} - {s.subject}" for i, s in enumerate(m.segments, 1)]

    for i, s in enumerate(m.segments, 1):
        when = f"เวลา {s.start}-{s.end}"
        if s.responds_to:
            when += f" (ต่อจากการรายงานเรื่อง{s.responds_to})"
        out += ["", f"{i}. {heading(s)}", when]
        out += [f"- {d}" for d in s.details]
        if s.quotes:
            out += ["คำพูดสำคัญ:"] + [f'"{q.text}" ({q.timestamp})' for q in s.quotes]

    out += ["", "ข้อสั่งการ / สิ่งที่ต้องดำเนินการ"]
    for i, a in enumerate(m.action_items, 1):
        out += [
            f"{i}. {a.task}",
            f"   ผู้สั่งการ: {a.requested_by or '-'} / ผู้รับผิดชอบ: {a.owner or '-'} / กำหนด: {a.due or '-'} / อ้างอิง: {', '.join(a.timestamps)}",
        ]
    if not m.action_items:
        out.append("- ไม่มี")

    if m.needs_confirmation:
        out += ["", "ประเด็นที่ควรตรวจสอบกับเสียงจริง"]
        out += [f"- {c.text} ({', '.join(c.timestamps)})" for c in m.needs_confirmation]

    out += ["", f"สรุปอัตโนมัติด้วย {model_id} จาก {source.name} (เวลาอ้างอิงนับจากต้นไฟล์เสียงที่ถอด)", ""]
    return "\n".join(out)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", choices=sorted(MODELS))
    parser.add_argument("--transcript", type=Path, default=DEFAULT_TRANSCRIPT)
    parser.add_argument("--rerender", action="store_true", help="rebuild the .txt from the saved .json without calling the API")
    args = parser.parse_args()

    # Not Path.with_suffix: model names contain dots ("3.1").
    json_path = RESULTS_DIR / f"summary-{args.model}.json"
    txt_path = RESULTS_DIR / f"summary-{args.model}.txt"

    if args.rerender:
        data = json.loads(json_path.read_text())
        minutes = MeetingMinutes.model_validate(data["minutes"])
        txt_path.write_text(render_text(minutes, Path(data["meta"]["transcript"]), data["meta"]["model_id"]))
        print(f"wrote {txt_path}")
        return

    load_env(ROOT / ".env.test")
    from google import genai
    from google.genai import types

    model_id, price_in, price_out = MODELS[args.model]
    transcript = args.transcript.read_text()
    # Any time present in the transcript counts: diarized lines may also carry an end time like "(00:59)".
    known_stamps = {normalize_stamp(s) for s in re.findall(r"\d{1,3}:\d{2}", transcript)}

    print(f"summarizing {args.transcript.name} ({len(transcript):,} chars) with {model_id} ...", flush=True)
    # Keep a reference: a temporary Client is garbage-collected and closes its HTTP connection mid-call.
    client = genai.Client()
    started = time.monotonic()
    response = client.models.generate_content(
        model=model_id,
        contents=transcript,
        config=types.GenerateContentConfig(
            system_instruction=PROMPT,
            response_mime_type="application/json",
            response_schema=MeetingMinutes,
            max_output_tokens=65536,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        ),
    )
    elapsed = time.monotonic() - started
    minutes = response.parsed if isinstance(response.parsed, MeetingMinutes) else MeetingMinutes.model_validate_json(response.text)

    usage = response.usage_metadata
    tokens_in = usage.prompt_token_count or 0
    tokens_out = usage.candidates_token_count or 0
    tokens_thinking = usage.thoughts_token_count or 0
    flat_transcript = spoken_text(transcript)
    meta = {
        "model_id": model_id,
        "transcript": str(args.transcript),
        "finish_reason": response.candidates[0].finish_reason.name if response.candidates else None,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "tokens_thinking": tokens_thinking,
        "cost_usd": round((tokens_in * price_in + (tokens_out + tokens_thinking) * price_out) / 1e6, 4),
        "elapsed_seconds": round(elapsed, 1),
        "segments": {label: sum(1 for s in minutes.segments if s.kind is kind) for kind, label in KIND_LABEL.items()},
        "detail_points": sum(len(s.details) for s in minutes.segments),
        "action_items": len(minutes.action_items),
        "needs_confirmation": len(minutes.needs_confirmation),
        "unmatched_citations": sorted({normalize_stamp(s) or s for s in cited_stamps(minutes)} - known_stamps),
        "quotes_not_in_transcript": [q.text for s in minutes.segments for q in s.quotes if squash(q.text) not in flat_transcript],
        "quotes_outside_segment": quotes_outside_segment(minutes),
    }

    RESULTS_DIR.mkdir(exist_ok=True)
    json_path.write_text(json.dumps({"meta": meta, "minutes": minutes.model_dump(mode="json")}, ensure_ascii=False, indent=2))
    txt_path.write_text(render_text(minutes, args.transcript, model_id))

    print(json.dumps(meta, ensure_ascii=False, indent=2))
    if meta["unmatched_citations"] or meta["quotes_not_in_transcript"] or meta["quotes_outside_segment"]:
        print("WARNING: some citations or quotes don't line up with the transcript, see the meta above", file=sys.stderr)


if __name__ == "__main__":
    main()
