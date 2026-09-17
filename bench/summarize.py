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
from concurrent.futures import ThreadPoolExecutor
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

PROMPT = (ROOT / "api/src/minutes_prompt.txt").read_text().strip()


class SegmentKind(str, Enum):
    report = "report"
    advice = "advice"
    discussion = "discussion"


class Quote(BaseModel):
    text: str = Field(description="Short phrase copied verbatim from the transcript")
    timestamp: str = Field(description="MM:SS start time of the transcript line containing the phrase")


class ReportSection(BaseModel):
    heading: str
    paragraphs: list[str]
    items: list[str]
    numbered: bool


class Segment(BaseModel):
    kind: SegmentKind
    speaker: str = Field(description="Who reports or advises, by role or name; for discussion, the participants, e.g. ประธานอาวุโส / คุณเบน")
    subject: str = Field(description="Short Thai noun phrase for what it is about, without a leading 'เรื่อง'")
    responds_to: str | None = Field(description="For advice or discussion: subject of the report it responds to, if any")
    start: str = Field(description="MM:SS")
    end: str = Field(description="MM:SS")
    details: list[str]
    report_sections: list[ReportSection] = Field(default_factory=list)
    quotes: list[Quote]


class ActionItem(BaseModel):
    task: str
    requested_by: str | None = Field(description="Who gave the directive or request")
    owner: str | None = Field(description="Responsible person, only if explicitly stated; otherwise null")
    due: str | None = Field(description="Deadline, only if explicitly stated; otherwise null")
    assigned_on: str | None = Field(default=None, description="Explicit assignment date, never the deadline")
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


class ExpandedSection(BaseModel):
    segment: Segment
    needs_confirmation: list[Check]


def expand_minutes(client, model_id, transcript, minutes):
    """Re-read long meeting sections from their source, matching the API pipeline."""
    from google.genai import types
    body, _, speakers = transcript.partition("\n## ผู้พูด")
    lines = body.splitlines()
    times = [seconds(line) for line in lines if line.startswith("[")]
    if not times or times[-1] - times[0] < 2700:
        return []
    prompt = PROMPT + "\n" + (ROOT / "api/src/minutes_expansion_prompt.txt").read_text()

    def expand(index):
        segment = minutes.segments[index]
        start = seconds(segment.start)
        stop = seconds(minutes.segments[index + 1].start) if index + 1 < len(minutes.segments) else None
        if start < 0 or (stop is not None and stop <= start):
            raise ValueError("Summary sections must have increasing timestamps")
        selected, active = [], False
        for line in lines:
            if line.startswith("["):
                active = seconds(line) >= start and (stop is None or seconds(line) < stop)
            if active:
                selected.append(line)
        if not selected:
            raise ValueError("Summary section has no source lines")
        source = "\n".join(selected)
        content = f"หัวข้อเบื้องต้น: {segment.subject}\nผู้พูดเบื้องต้น: {segment.speaker}\nkind: {segment.kind.value}\n\n{source}\n\n## ผู้พูด{speakers}"
        section_schema = ExpandedSection.model_json_schema()
        section_schema["$defs"]["Segment"]["properties"]["kind"] = {"type": "string", "enum": [segment.kind.value]}
        response = client.models.generate_content(model=model_id, contents=content, config=types.GenerateContentConfig(
            system_instruction=prompt, response_mime_type="application/json",
            response_json_schema=section_schema, max_output_tokens=65536,
        ))
        if not response.candidates or response.candidates[0].finish_reason.name != "STOP":
            raise ValueError("Incomplete summary section; not saved")
        result = ExpandedSection.model_validate_json(response.text)
        if result.segment.kind != segment.kind:
            raise ValueError("Expanded section changed the meeting structure")
        result.segment.start, result.segment.end = segment.start, segment.end
        return result, response.usage_metadata

    with ThreadPoolExecutor(max_workers=3) as executor:
        results = list(executor.map(expand, range(len(minutes.segments))))
    for index, (result, _) in enumerate(results):
        minutes.segments[index] = result.segment
        minutes.needs_confirmation.extend(result.needs_confirmation)
    return [usage for _, usage in results]


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
        return f"วาระ: {seg.subject.removeprefix('วาระ:').strip()}"
    if seg.kind is SegmentKind.advice:
        return f"ข้อชี้แนะจาก{seg.speaker}"
    return f"ประเด็นถาม-ตอบ: {seg.subject}"


def render_text(m: MeetingMinutes, source: Path, model_id: str) -> str:
    del source, model_id
    out = [m.title]
    if m.overview.strip():
        out += ["", m.overview]

    for s in m.segments:
        out += ["", heading(s)]
        if s.kind in (SegmentKind.report, SegmentKind.discussion):
            out.append(f"โดย {s.speaker}")
        out += s.details if s.kind is SegmentKind.report else [f"- {d}" for d in s.details]
        for section in s.report_sections:
            out.append("")
            if section.heading.strip():
                out.append(section.heading)
            out += section.paragraphs
            out += [f"{i}. {item}" if section.numbered else f"- {item}" for i, item in enumerate(section.items, 1)]

    requesters = {a.requested_by for a in m.action_items if a.requested_by}
    all_attributed = all(a.requested_by and a.requested_by.strip() for a in m.action_items)
    action_heading = f"สรุปงานที่{next(iter(requesters))}มอบหมาย" if len(requesters) == 1 and all_attributed else "สรุปงานที่ได้รับมอบหมาย"
    out += ["", action_heading]
    previous_group = object()
    for a in m.action_items:
        group = (a.owner or None, a.assigned_on, a.requested_by)
        if group != previous_group:
            out += ["", f"ฝาก{a.owner}" if a.owner else "งานที่ต้องดำเนินการ"]
            if a.assigned_on and a.assigned_on.strip():
                out[-1] += f" เมื่อวันที่ {a.assigned_on}"
            if (not all_attributed or len(requesters) != 1) and a.requested_by:
                out.append(f"ผู้มอบหมาย: {a.requested_by}")
            previous_group = group
        out.append(f"- {a.task}")
        if a.due:
            out.append(f"  กำหนด: {a.due}")
    if not m.action_items:
        out.append("- ไม่มี")

    if m.needs_confirmation:
        out += ["", "ประเด็นที่ควรตรวจสอบกับเสียงจริง"]
        out += [f"- {c.text} ({', '.join(c.timestamps)})" for c in m.needs_confirmation]

    out.append("")
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
    if not response.candidates or response.candidates[0].finish_reason.name != "STOP":
        raise ValueError("Incomplete summary; not saved")
    minutes = response.parsed if isinstance(response.parsed, MeetingMinutes) else MeetingMinutes.model_validate_json(response.text)
    expansion_usage = expand_minutes(client, model_id, transcript, minutes)
    elapsed = time.monotonic() - started

    usage = response.usage_metadata
    all_usage = [usage, *expansion_usage]
    tokens_in = sum(u.prompt_token_count or 0 for u in all_usage)
    tokens_out = sum(u.candidates_token_count or 0 for u in all_usage)
    tokens_thinking = sum(u.thoughts_token_count or 0 for u in all_usage)
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
        "detail_points": sum(len(s.details) + sum(len(r.paragraphs) + len(r.items) for r in s.report_sections) for s in minutes.segments),
        "format_version": 2,
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
