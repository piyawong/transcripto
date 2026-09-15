# /// script
# requires-python = ">=3.11"
# dependencies = ["google-genai>=2.23", "httpx"]
# ///
"""Transcribe a Thai audio clip with one model and save the result for side-by-side comparison.

Usage:
    uv run bench/transcribe.py gemini-3.1-pro
    uv run bench/transcribe.py scribe-v2
    uv run bench/transcribe.py gemini-3.1-pro --audio path/to/clip.wav

API keys (GEMINI_API_KEY, ELEVENLABS_API_KEY) are read from .env.test at the project root.
Results go to bench/results/<model>.txt (+ .json).
"""
import argparse
import json
import os
import re
import sys
import time
import wave
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR = Path(__file__).resolve().parent / "results"
DEFAULT_AUDIO = ROOT / "samples/2026-03-17_0b2544a9_ครั้งที่5.2026/clip_senior_chairman_43m30-end.wav"

# Shared by every model that takes a prompt, so outputs stay comparable.
PROMPT = """Transcribe this Thai audio verbatim.

Rules:
- Write exactly what is spoken, in Thai. Do not summarize, paraphrase, reorder, or correct grammar.
- Keep filler words, repetitions, and false starts.
- Write English words that are spoken in English using English letters.
- Write numbers as digits.
- If a word or phrase cannot be heard clearly, write [ฟังไม่ชัด] instead of guessing.
- Start a new line at each sentence, or at least every 20 seconds.
- Begin every line with the start time as [MM:SS], measured from the start of the audio.
- No speaker labels, headings, notes, or commentary. Output only the transcript lines."""

DIARIZE_PROMPT = """Transcribe this Thai audio verbatim and label who is speaking.

Rules:
- Write exactly what is spoken, in Thai. Do not summarize, paraphrase, reorder, or correct grammar.
- Keep filler words, repetitions, and false starts.
- Write English words that are spoken in English using English letters.
- Write numbers as digits.
- If a word or phrase cannot be heard clearly, write [ฟังไม่ชัด] instead of guessing.
- Begin every line with the start time as [MM:SS], measured from the start of the audio, then the speaker label, e.g. "[01:23] ผู้พูด 1: ...".
- Start a new line whenever the speaker changes, and at least every 20 seconds.
- Number speakers in order of first appearance (ผู้พูด 1, ผู้พูด 2, ...) and keep the same number for the same voice throughout.
- After the transcript, add a section "## ผู้พูด" listing each speaker number with their role or name only if it is stated or clearly implied in the audio (e.g. someone is invited to speak by title); otherwise write "ไม่ทราบ"."""

TIMESTAMP_RE = re.compile(r"^\[(\d{1,3}):(\d{2})\]", re.MULTILINE)
SPEAKER_RE = re.compile(r"^\[\d{1,3}:\d{2}\]\s*(ผู้พูด\s*\d+)", re.MULTILINE)


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.removeprefix("export ").strip(), value.strip().strip("'\""))


def gemini(model_id: str, price_in: float, price_out: float, prompt: str = PROMPT):
    """price_in / price_out: USD per 1M tokens; thinking tokens are billed as output."""

    def run(audio: Path) -> tuple[str, dict]:
        from google import genai
        from google.genai import types

        if not os.environ.get("GEMINI_API_KEY"):
            sys.exit("GEMINI_API_KEY is not set (add it to .env.test)")

        client = genai.Client()
        uploaded = client.files.upload(file=audio, config={"mime_type": "audio/wav"})
        try:
            while uploaded.state and uploaded.state.name == "PROCESSING":
                time.sleep(2)
                uploaded = client.files.get(name=uploaded.name)
            response = client.models.generate_content(
                model=model_id,
                contents=[prompt, uploaded],
                config=types.GenerateContentConfig(
                    max_output_tokens=65536,
                    automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
                ),
            )
        finally:
            client.files.delete(name=uploaded.name)

        usage = response.usage_metadata
        tokens_in = usage.prompt_token_count or 0
        tokens_out = usage.candidates_token_count or 0
        tokens_thinking = usage.thoughts_token_count or 0
        return response.text or "", {
            "model_id": model_id,
            "finish_reason": response.candidates[0].finish_reason.name if response.candidates else None,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "tokens_thinking": tokens_thinking,
            "cost_usd": round((tokens_in * price_in + (tokens_out + tokens_thinking) * price_out) / 1e6, 4),
        }

    return run


def stamp(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60:02d}:{s % 60:02d}"


def words_to_lines(words: list[dict], soft_seconds: float = 15, hard_seconds: float = 25, max_seconds: float = 60) -> list[str]:
    """Group word timings into "[MM:SS] ผู้พูด N: text" lines, the same shape as the Gemini output.

    For Thai, ElevenLabs "words" are fragments of a syllable ("เ", "ร", "า"), so a line may only be cut where a
    spacing token came before: at the first pause after soft_seconds, or at hard_seconds. A line is cut anywhere
    only after max_seconds without spacing. A new line always starts when the speaker changes.
    Speakers (speaker_id or speaker) are numbered in order of first appearance; without them lines have no label.
    """
    labels: dict[str, str] = {}
    lines: list[str] = []
    current: dict | None = None
    prev_end = 0.0
    after_spacing = False

    def flush() -> None:
        label = f"{current['speaker']}: " if current["speaker"] else ""
        lines.append(f"[{stamp(current['start'])}] {label}{current['text'].strip()}")

    for w in words:
        text, start = w.get("text", ""), w.get("start") or prev_end
        if w.get("type") == "spacing":
            if current:
                current["text"] += text
            after_spacing = True
            continue
        speaker_id = w.get("speaker_id", w.get("speaker"))
        speaker = labels.setdefault(str(speaker_id), f"ผู้พูด {len(labels) + 1}") if speaker_id is not None else None
        elapsed = start - current["start"] if current else 0
        paused = start - prev_end >= 0.3
        at_boundary = after_spacing and (elapsed >= hard_seconds or (elapsed >= soft_seconds and paused))
        if not current or speaker != current["speaker"] or at_boundary or elapsed >= max_seconds:
            if current:
                flush()
            current = {"start": start, "speaker": speaker, "text": ""}
        # Thai words join without spaces, but adjacent English words or numbers need one.
        if current["text"][-1:].isascii() and current["text"][-1:].isalnum() and text[:1].isascii() and text[:1].isalnum():
            current["text"] += " "
        current["text"] += text
        prev_end = w.get("end") or start
        after_spacing = False
    if current:
        flush()
    return lines


def read_keyterms(path: Path) -> list[str]:
    terms = [line.strip() for line in path.read_text().splitlines() if line.strip() and not line.startswith("#")]
    return [t for t in terms if len(t) <= 50][:1000]


def scribe(model_id: str, price_per_hour: float, keyterms_file: Path | None = None, name: str | None = None):
    """ElevenLabs speech-to-text with built-in diarization and word timestamps, optionally biased with keyterms."""

    def run(audio: Path) -> tuple[str, dict]:
        import httpx

        key = os.environ.get("ELEVENLABS_API_KEY")
        if not key:
            sys.exit("ELEVENLABS_API_KEY is not set (add it to .env.test)")

        # Force Thai: a Chinese accent could otherwise be auto-detected as Chinese.
        data = {"model_id": model_id, "language_code": "tha", "diarize": "true", "timestamps_granularity": "word"}
        keyterms = read_keyterms(keyterms_file) if keyterms_file else []
        if keyterms:
            data["keyterms"] = keyterms  # httpx sends a list as repeated form fields
        with audio.open("rb") as f:
            response = httpx.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={"xi-api-key": key},
                data=data,
                files={"file": (audio.name, f, "audio/wav")},
                timeout=900,
            )
        if response.status_code != 200:
            sys.exit(f"ElevenLabs API error {response.status_code}: {response.text[:500]}")
        result = response.json()

        RESULTS_DIR.mkdir(exist_ok=True)
        (RESULTS_DIR / f"{name or model_id}.raw.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        with wave.open(str(audio)) as w:
            audio_seconds = w.getnframes() / w.getframerate()
        return "\n".join(words_to_lines(result.get("words", []))) + "\n", {
            "model_id": model_id,
            "keyterms": len(keyterms),
            "language_code": result.get("language_code"),
            "language_probability": result.get("language_probability"),
            "cost_usd": round(audio_seconds / 3600 * price_per_hour, 4),
        }

    return run


def paxa(model_id: str, usd_per_credit: float, max_bytes: int = 26_000_000):
    """Paxa Labs /v1/stt (Thai-focused, research preview). Diarization only works under ~9 minutes, so it is off."""

    def run(audio: Path) -> tuple[str, dict]:
        import base64
        import subprocess
        import tempfile

        import httpx

        key = os.environ.get("PAXA_API_KEY")
        if not key:
            sys.exit("PAXA_API_KEY is not set (add it to .env.test)")

        with tempfile.TemporaryDirectory() as tmp:
            upload = audio
            if audio.stat().st_size > max_bytes:
                # Lossless FLAC to fit the 26.2 MB request limit without changing what the model hears.
                upload = Path(tmp) / f"{audio.stem}.flac"
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(audio), "-c:a", "flac", str(upload)], check=True)
            payload = {
                "audio": base64.b64encode(upload.read_bytes()).decode(),
                "model": model_id,
                "language": "th",
                "timestamps": "word",
                "style": "verbatim",
                "convention": "written",  # digits, matching the shared Gemini prompt
            }
        response = httpx.post(
            "https://api.paxalabs.com/v1/stt",
            headers={"Authorization": f"Bearer {key}"},
            json=payload,
            timeout=900,
        )
        if response.status_code != 200:
            sys.exit(f"Paxa API error {response.status_code}: {response.text[:500]}")
        result = response.json()

        RESULTS_DIR.mkdir(exist_ok=True)
        (RESULTS_DIR / f"{model_id}.raw.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        words = result.get("words") or []
        lines = words_to_lines(words) if words else [f"[00:00] {result.get('text', '')}"]
        credits = (result.get("usage") or {}).get("credits") or 0
        return "\n".join(lines) + "\n", {
            "model_id": model_id,
            "credits": credits,
            "cost_usd": round(credits * usd_per_credit, 4),
        }

    return run


MODELS = {
    # Prices for prompts <= 200k tokens, from ai.google.dev/gemini-api/docs/pricing (checked 2026-09-15).
    "gemini-3.1-pro": gemini("gemini-3.1-pro-preview", price_in=2.00, price_out=12.00),
    "gemini-3.1-pro-diarize": gemini("gemini-3.1-pro-preview", price_in=2.00, price_out=12.00, prompt=DIARIZE_PROMPT),
    # $0.22 per audio hour, diarization included; elevenlabs.io/pricing/api (checked 2026-09-15).
    "scribe-v2": scribe("scribe_v2", price_per_hour=0.22),
    # Keyterm prompting adds 20% (elevenlabs.io/docs/api-reference/speech-to-text/convert, checked 2026-09-15).
    "scribe-v2-keyterms": scribe(
        "scribe_v2", price_per_hour=0.22 * 1.2, keyterms_file=Path(__file__).resolve().parent / "keyterms.txt", name="scribe_v2_keyterms"
    ),
    # 500 credits per audio hour; 1 credit = $0.001 (paxalabs.com/speech-to-text, checked 2026-09-15).
    "paxa-stt-lite": paxa("paxa-stt-lite-v1-preview", usd_per_credit=0.001),
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", choices=sorted(MODELS))
    parser.add_argument("--audio", type=Path, default=DEFAULT_AUDIO)
    args = parser.parse_args()

    load_env(ROOT / ".env.test")
    with wave.open(str(args.audio)) as w:
        audio_seconds = w.getnframes() / w.getframerate()

    print(f"transcribing {args.audio.name} ({audio_seconds / 60:.1f} min) with {args.model} ...", flush=True)
    started = time.monotonic()
    text, meta = MODELS[args.model](args.audio)
    elapsed = time.monotonic() - started

    stamps = [int(m) * 60 + int(s) for m, s in TIMESTAMP_RE.findall(text)]
    last = max(stamps, default=0)
    meta |= {
        "audio": str(args.audio),
        "audio_seconds": round(audio_seconds, 1),
        "elapsed_seconds": round(elapsed, 1),
        "chars": len(text),
        "timestamped_lines": len(stamps),
        "last_timestamp": f"{last // 60:02d}:{last % 60:02d}",
    }
    speakers = [re.sub(r"\s+", " ", s) for s in SPEAKER_RE.findall(text)]
    if speakers:
        meta["speaker_lines"] = dict(Counter(speakers))
        meta["speaker_turns"] = 1 + sum(1 for a, b in zip(speakers, speakers[1:]) if a != b)

    RESULTS_DIR.mkdir(exist_ok=True)
    (RESULTS_DIR / f"{args.model}.txt").write_text(text)
    (RESULTS_DIR / f"{args.model}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))

    print(json.dumps(meta, ensure_ascii=False, indent=2))
    if last < audio_seconds * 0.9:
        print("WARNING: timestamps cover < 90% of the audio, the transcript may be truncated", file=sys.stderr)


if __name__ == "__main__":
    main()
