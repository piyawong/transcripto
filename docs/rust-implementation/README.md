# Handoff: ทำ pipeline ถอดเสียงประชุมภาษาไทยเป็น Rust

เอกสารนี้เขียนให้ agent ที่จะ implement เป็น Rust อ่านแล้วลงมือได้เลย

- **ตัดสินใจแล้ว (ไม่ต้องทดลองซ้ำ):** ใช้ ElevenLabs ถอดเสียง แล้วใช้ Gemini 3.1 Pro ตรวจแก้และสรุปประชุม เหตุผลและผลทดสอบอยู่ใน `docs/transcription-solution.md`
- **โค้ดต้นแบบ (Python ที่รันกับคลิปจริงแล้ว):** `bench/transcribe.py`, `bench/correct.py`, `bench/summarize.py` ใช้เป็น reference ได้ทุกบรรทัด
- **ข้อมูลทดสอบ:** `docs/rust-implementation/fixtures/` สร้างด้วย `uv run bench/export_fixtures.py` (ไม่เรียก API)
- วันที่เขียน: 15 ก.ย. 2026

---

## 0. สรุปสั้นสำหรับคนรับงาน

```
ไฟล์เสียงทั้งไฟล์ (ไม่ตัดท่อน)
  │
  ① ElevenLabs Scribe v2  ──► words[] (ตัวอักษร/พยางค์ย่อย + เวลา + speaker_id)
  │   words_to_lines()     ──► transcript.txt   "[MM:SS] ผู้พูด N: ข้อความ"            ← deterministic
  │
  ② Gemini 3.1 Pro         ──► Corrections JSON {edits[], unclear[], speakers[]}         ← LLM (ผลไม่คงที่)
  │   apply_edits()        ──► corrected.txt (+ "## ผู้พูด")  และ changes.txt (log)      ← deterministic
  │
  ③ Gemini 3.1 Pro         ──► MeetingMinutes JSON                                      ← LLM (ผลไม่คงที่)
      check_minutes()      ──► ผลตรวจเวลาอ้างอิงและคำพูดที่ยกมา                           ← deterministic
      render_text()        ──► minutes.txt (ข้อความธรรมดา ไม่ใช่ Markdown)               ← deterministic
```

**สิ่งที่ต้องทำ**
1. Client เรียก ElevenLabs และ Gemini (REST ตรง ไม่มี SDK ทางการสำหรับ Rust)
2. ฟังก์ชัน deterministic 5 ตัวให้ผลตรงกับ Python แบบ byte-for-byte: `words_to_lines`, `apply_edits` (รวม `rejection`, `pad_digits`), `leftover_numbers` + `render_changes`, `check_minutes`, `render_text`
3. แบ่งข้อความเป็นช่วงในขั้นที่ ② สำหรับไฟล์ยาว (**ต้องทำ** ดูหัวข้อ 5.6)
4. Golden test ตามหัวข้อ 9 ต้องผ่านทั้งหมด

**ยังไม่ได้กำหนด (ถามเจ้าของงานก่อนถ้าจำเป็น):** จะเป็น CLI, service หรือ worker ที่ต่อกับ transcripto (Django + Celery) และเก็บผลลัพธ์ที่ไหน เอกสารนี้จึงกำหนดแค่ logic, API และรูปแบบไฟล์

---

## 1. ค่าตั้งต้น

| ชื่อ | ค่า | ที่มา |
|---|---|---|
| `ELEVENLABS_API_KEY` | env | ห้าม log |
| `GEMINI_API_KEY` | env | ห้าม log |
| ElevenLabs model | `scribe_v2` | `bench/transcribe.py:168` |
| Gemini model (ขั้น ② และ ③) | `gemini-3.1-pro-preview` | ตัวสำรอง `gemini-3.8-flash` |
| ราคา ElevenLabs | $0.22/ชม. เสียง, ถ้าส่ง keyterms เพิ่ม 20% | `bench/transcribe.py:262` |
| ราคา Gemini 3.1 Pro | $2.00 / $12.00 ต่อ 1M token (input / output) สำหรับ prompt ≤ 200k token | `bench/summarize.py:34` |
| ราคา Gemini 3.8 Flash | $0.75 / $3.75 (ขึ้น 2 เท่าตั้งแต่ 1 ม.ค. 2027) | |
| สูตรค่า Gemini | `(promptTokenCount × in + (candidatesTokenCount + thoughtsTokenCount) × out) / 1e6` | thinking token คิดราคา output |
| `maxOutputTokens` | 65536 | รวม thinking |
| keyterms | ไฟล์ละบรรทัด, ข้ามบรรทัดว่างและบรรทัดที่ขึ้นต้นด้วย `#`, ตัดคำที่ยาวเกิน 50 **ตัวอักษร (char)** และเก็บไม่เกิน 1000 คำ | `bench/transcribe.py:163`, `bench/keyterms.txt` |

**keyterms ห้ามใส่ชื่อคน** จนกว่าจะมีคนตรวจรายชื่อ ชื่อผิดทำให้ขั้นที่ ② เปลี่ยนชื่อคนผิด

---

## 2. ขั้นที่ ① ElevenLabs Speech-to-Text

### 2.1 Request
```bash
curl -X POST https://api.elevenlabs.io/v1/speech-to-text \
  -H "xi-api-key: $ELEVENLABS_API_KEY" \
  -F model_id=scribe_v2 \
  -F language_code=tha \
  -F diarize=true \
  -F timestamps_granularity=word \
  -F keyterms=ประธานอาวุโส \
  -F keyterms=Lotus \
  -F "file=@meeting.wav;type=audio/wav"
```
- `multipart/form-data`
- **`keyterms` ส่งเป็น field ชื่อซ้ำกันหลายตัว** หนึ่ง field ต่อหนึ่งคำ (แบบที่ httpx ส่งและใช้ได้จริง) ถ้าไม่มี keyterms ไม่ต้องส่ง field นี้
- `language_code=tha` บังคับภาษาไทย เพราะสำเนียงจีนอาจถูกตรวจเป็นภาษาจีน
- ส่ง**ไฟล์เสียงทั้งไฟล์** ห้ามตัดท่อน ไม่อย่างนั้น `speaker_id` จะเริ่มนับใหม่ทุกท่อน (รับได้ถึง 10 ชม. / 3 GB)
- timeout: คลิป 17 นาทีใช้ 88–109 วินาที ไฟล์ 3 ชม. ต้องเผื่อหลายสิบนาที หรือศึกษาโหมด webhook ของ ElevenLabs (ยังไม่ได้ทดสอบ)
- HTTP ที่ไม่ใช่ 200 ให้ถือว่าล้มเหลว เก็บ body 500 ตัวอักษรแรกไว้ใน error

### 2.2 Response
ตัวอย่างเต็ม: `fixtures/elevenlabs-response.json` (คลิป 17 นาที, 8,155 tokens)
```json
{
  "language_code": "tha", "language_probability": 1.0, "audio_duration_secs": 1029.0,
  "transcription_id": "...", "text": "...",
  "words": [
    {"text": "ค", "start": 3.16, "end": 3.24, "type": "word", "speaker_id": "speaker_0", "logprob": -3.1e-06},
    {"text": "ต", "start": 3.24, "end": 3.42, "type": "word", "speaker_id": "speaker_0", "logprob": -1.7e-06},
    {"text": " ", "start": 3.42, "end": 3.46, "type": "spacing", "speaker_id": "speaker_0", "logprob": -0.28},
    {"text": "ถ้", "start": 3.46, "end": 3.52, "type": "word", "speaker_id": "speaker_0", "logprob": -0.28}
  ]
}
```
- `type` มี 3 แบบ: `word` (7,900), `spacing` (254), `audio_event` (1 เช่น `"[เสียงหัวเราะ]"`)
- **ภาษาไทย "word" ไม่ใช่คำ** แต่เป็นตัวอักษรหรือพยางค์ย่อย (`"เ"`, `"ร"`, `"า"`) จุดเดียวที่ตัดบรรทัดได้ปลอดภัยคือหลัง token `spacing`
- ใช้ `audio_duration_secs` คิดค่าใช้จ่าย

### 2.3 `words_to_lines` (ต้องตรงกับ Python ทุก byte)
Reference: `bench/transcribe.py:118`

```python
def words_to_lines(words, soft_seconds=15, hard_seconds=25, max_seconds=60):
    labels = {}; lines = []; current = None; prev_end = 0.0; after_spacing = False

    def flush():
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
        if current["text"][-1:].isascii() and current["text"][-1:].isalnum() and text[:1].isascii() and text[:1].isalnum():
            current["text"] += " "
        current["text"] += text
        prev_end = w.get("end") or start
        after_spacing = False
    if current:
        flush()
    return lines

def stamp(seconds):            # ปัดลง นาทีเกิน 99 ได้ เช่น "180:05"
    s = int(seconds)
    return f"{s // 60:02d}:{s % 60:02d}"
```

กฎที่ต้องระวังตอนแปลงเป็น Rust:
- `w.get("start") or prev_end`: ใน Python ค่า `0.0` นับเป็น false ด้วย ดังนั้นทั้ง `None` และ `0.0` ต้องใช้ `prev_end` แทน เช่นเดียวกับ `w.get("end") or start`
- label ผู้พูดนับตาม**ลำดับที่ปรากฏครั้งแรก** ไม่ได้ใช้เลขใน `speaker_N`
- token `spacing` ที่มาก่อนบรรทัดแรกถูกทิ้ง และ `after_spacing` ถูก reset หลัง token ที่ไม่ใช่ spacing ทุกตัว (รวม `audio_event`)
- เติมช่องว่างเฉพาะเมื่อตัวสุดท้ายของข้อความเดิม**และ**ตัวแรกของ token ใหม่เป็น ASCII ตัวอักษรหรือตัวเลข (`char::is_ascii_alphanumeric`) ถ้าข้อความว่างให้ถือว่าไม่ใช่
- `strip()` ตัด whitespace แบบ Unicode ใช้ `str::trim()` ได้
- ต่อบรรทัดด้วย `\n` และมี `\n` ปิดท้ายไฟล์

> ผลใน `bench/results/` ทำไว้**ก่อน**แก้บั๊กนี้ ตอนนั้นตัดบรรทัดกลางพยางค์ได้ (1 จาก 77 บรรทัด คือ `[12:30] ผู้พูด 3: าทำการบ้าน...`) fixture `lines.expected.txt` ใช้โค้ดที่แก้แล้ว (73 บรรทัด) ส่วน `correct.input.txt` เป็นไฟล์ 77 บรรทัดแบบเดิม เพราะ edits ที่บันทึกไว้อิงไฟล์นั้น ทั้งสองเป็น test แยกกัน

### 2.4 รูปแบบ transcript
```
[MM:SS] ผู้พูด N: ข้อความ
```
- regex ที่ใช้อ่านในขั้นถัดไป: `^(\[(\d{1,3}:\d{2})\]\s*(?:ผู้พูด\s*\d+\s*[:：]\s*)?)(.*)$` (`bench/correct.py:41`) group 1 คือ prefix, group 2 คือเวลา, group 3 คือข้อความ
- หลังขั้นที่ ② มีส่วนต่อท้ายไฟล์:
```

## ผู้พูด
ผู้พูด 1: ไม่ทราบ
ผู้พูด 3: ประธานอาวุโส
```

---

## 3. Gemini REST (ใช้ร่วมกันในขั้นที่ ② และ ③)

### 3.1 Request
```bash
curl -X POST "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -d @docs/rust-implementation/fixtures/gemini-correct-request.json
```
- Body จริงที่ Python SDK (`google-genai` 2.23) ส่ง ถูกดักเก็บไว้ที่
  - `fixtures/gemini-correct-request.json` (ขั้นที่ ②)
  - `fixtures/gemini-summary-request.json` (ขั้นที่ ③)
- ในไฟล์มี `systemInstruction` (prompt เต็ม), `contents` (ใส่ข้อความตัวอย่างสั้นๆ ไว้ ของจริงให้แทนด้วยข้อมูลจริง), `generationConfig.responseSchema`, `responseMimeType: "application/json"`, `maxOutputTokens: 65536`
- **`responseSchema` เป็น schema แบบของ Gemini** (`"type": "STRING"`, `"nullable": true`, `required`) ไม่ใช่ JSON Schema มาตรฐาน **ให้ใช้ค่าในไฟล์ตรงๆ** (เช่น `include_str!`) ไม่ต้อง generate เองจาก struct
- ถ้าจะแก้ prompt หรือ schema ให้แก้ Python แล้วดัก body ใหม่ด้วยวิธีเดียวกัน หรือแก้ใน JSON ให้ตรงกัน
- ทดสอบแล้วว่า body ของขั้นที่ ② ส่งผ่าน REST ตรง (ไม่ใช้ SDK) ได้ status 200 ใช้ 7.6 วินาทีกับข้อความ 2 บรรทัด ผลอยู่ใน `fixtures/gemini-correct-response.json`

### 3.2 Response
ตัวอย่างจริง: `fixtures/gemini-correct-response.json`
```json
{
  "candidates": [{
    "content": {"role": "model", "parts": [{"text": "{\n  \"edits\": [ ... ] }", "thoughtSignature": "..."}]},
    "finishReason": "STOP", "index": 0
  }],
  "usageMetadata": {"promptTokenCount": 646, "candidatesTokenCount": 271, "thoughtsTokenCount": 495, "totalTokenCount": 1412},
  "modelVersion": "...", "responseId": "..."
}
```
การอ่านผล:
1. เอา `text` ของทุก part ใน `candidates[0].content.parts` ที่ `thought != true` มาต่อกัน (แบบเดียวกับ `response.text` ของ SDK) แล้ว parse เป็น JSON ตาม schema
2. ถ้า `finishReason` ไม่ใช่ `STOP` เช่น `MAX_TOKENS` ให้ถือว่าผลไม่ครบ **ห้ามใช้ JSON ที่ถูกตัด** ให้แบ่งข้อความให้เล็กลงแล้วส่งใหม่
3. ถ้าไม่มี `candidates` (เช่นโดน safety block) ให้ error พร้อม `promptFeedback`
4. เก็บ `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`, เวลาที่ใช้ และค่าใช้จ่ายไว้ใน metadata

### 3.3 Retry
- รุ่น preview ตอบ 429 / 500 / 503 ได้บ่อย ให้ retry แบบ exponential backoff 3–5 ครั้ง
- 400 / 401 / 403 ห้าม retry
- timeout ต่อ request: ขั้นที่ ② ของคลิป 17 นาทีใช้ 96 วินาที ตั้งไว้อย่างน้อย 10 นาที

---

## 4. ขั้นที่ ② ตรวจแก้: สร้าง request

Reference: `bench/correct.py:205`

- `systemInstruction` = `PROMPT` ใน `bench/correct.py:50` (อยู่ใน fixture แล้ว)
- `contents` (ข้อความเดียว):
```
ชื่อและคำศัพท์ในการประชุมนี้:
- ประธานอาวุโส
- Lotus
...

TRANSCRIPT:
[00:00] ผู้พูด 1: ...
[00:13] ผู้พูด 2: ...
```
- รายการคำศัพท์อ่านจากไฟล์ keyterms ชุดเดียวกับขั้นที่ ① (ข้ามบรรทัดว่างและบรรทัด `#`)
- บรรทัด transcript ส่งตามไฟล์ทุกบรรทัด

### Schema ผลลัพธ์
```
Corrections {
  edits:    [ Edit { timestamp: "MM:SS", original, replacement, kind: "correction" | "number" | "name", reason } ]
  unclear:  [ Unclear { timestamp, text, reason } ]
  speakers: [ Speaker { label: "ผู้พูด 3", role: "ประธานอาวุโส" | "ไม่ทราบ" } ]
}
```
ตัวอย่างจริง: `fixtures/correct-pro.corrections.json`

---

## 5. ขั้นที่ ② ตรวจแก้: `apply_edits` (deterministic)

หลักการ: **LLM ไม่ได้เขียนข้อความใหม่** สคริปต์เป็นคนแก้ และแก้เฉพาะ edit ที่ผ่านกฎ

### 5.1 `rejection` (`bench/correct.py:112`)
```python
MAX_ORIGINAL_CHARS = 40
PARTICLES = ("ครับ", "ค่ะ", "คะ", "ฮะ")
NEEDS_CONFIRMATION = "ชื่อคน รอคนยืนยันก่อนแก้"

def rejection(edit):
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
```
- ตรวจตามลำดับนี้ ข้อความ reason ต้องตรงทุกตัวอักษร เพราะอยู่ใน log
- `len()` นับ **char** ไม่ใช่ byte (`chars().count()`)
- `str.count` นับแบบไม่ซ้อนทับ ใน Rust ใช้ `matches(p).count()`
- `\d` ใน Python ตรงกับเลขไทย ๐–๙ ด้วย ใน Rust `regex` ก็เป็น Unicode โดย default จึงให้ผลเหมือนกัน

### 5.2 `pad_digits` (`bench/correct.py:126`)
```python
THAI_LETTER_RE = re.compile(r"[ก-๏]")   # U+0E01..U+0E4F
DIGIT_RE = re.compile(r"[0-9]")         # ASCII เท่านั้น

def pad_digits(before, replacement, after):   # before/after = ตัวอักษร 1 ตัวที่ติดกัน หรือ "" ถ้าไม่มี
    if not replacement:
        return replacement
    first, last = replacement[0], replacement[-1]
    if before and ((THAI_LETTER_RE.match(before) and DIGIT_RE.match(first)) or ((DIGIT_RE.match(before) or before == "%") and THAI_LETTER_RE.match(first))):
        replacement = " " + replacement
    if after and (((DIGIT_RE.match(last) or last == "%") and THAI_LETTER_RE.match(after)) or (THAI_LETTER_RE.match(last) and DIGIT_RE.match(after))):
        replacement += " "
    return replacement
```
ใช้กับทุก edit ที่ถูกนำไปแก้ ไม่ใช่เฉพาะ `number`

| before | replacement | after | ผล |
|---|---|---|---|
| `ง` | `5` | ` ` | ` 5` |
| `0` | `ตารางเมตร` | `ท` | ` ตารางเมตร` |
| `ด` | `100%` | `ย` | ` 100% ` |
| `.` | `1` | `ถ` | `1 ` |
| `""` | `2 คน` | `""` | `2 คน` |

### 5.3 `apply_edits` (`bench/correct.py:141`)
```python
def apply_edits(lines, edits):
    parsed = [LINE_RE.match(line) for line in lines]          # parse ครั้งเดียวจากข้อความก่อนแก้
    results = []
    for edit in edits:                                         # ตามลำดับที่ LLM ส่งมา
        reason = rejection(edit)
        if reason is None:
            stamp = normalize_stamp(edit.timestamp)
            same = [i for i, m in enumerate(parsed) if m and normalize_stamp(m.group(2)) == stamp and edit.original in lines[i][len(m.group(1)):]]
            near = [i for i, m in enumerate(parsed)
                    if m and stamp and abs(seconds(m.group(2)) - seconds(stamp)) <= 30 and edit.original in lines[i][len(m.group(1)):]]
            targets = same or (near if len(near) == 1 else [])
            if not targets:
                reason = "ไม่พบข้อความเดิมในบรรทัดนั้น (หรือพบหลายที่)"
            else:
                i = targets[0]
                prefix = parsed[i].group(1)
                body = lines[i][len(prefix):]                  # ข้อความปัจจุบัน (อาจถูก edit ก่อนหน้าแก้ไปแล้ว)
                start = body.index(edit.original)              # ตำแหน่งแรกที่เจอ
                end = start + len(edit.original)
                replacement = pad_digits(body[start - 1 : start], edit.replacement, body[end : end + 1])
                lines[i] = prefix + body[:start] + replacement + body[end:]
        results.append((edit, reason))
    return results

STAMP_RE = re.compile(r"(\d{1,3}):(\d{2})")
def normalize_stamp(value):   # ใช้ search ไม่ใช่ full match: "[0:16]" -> "00:16", ไม่เจอ -> None
    m = STAMP_RE.search(value)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None
def seconds(stamp):
    m = STAMP_RE.search(stamp)
    return int(m.group(1)) * 60 + int(m.group(2)) if m else -1
```
จุดที่พลาดง่ายใน Rust:
- ถ้าเจอหลายบรรทัดใน `same` ให้แก้**บรรทัดแรก** ส่วน `near` แก้เฉพาะเมื่อเจอบรรทัดเดียว
- ทุกการค้นหาและตัดข้อความใช้ offset ของ `str::find` (byte) กับข้อความเดียวกันได้ แต่ `before` / `after` ต้องเป็น **char** ที่ติดกัน: `body[..start].chars().next_back()` และ `body[end..].chars().next()` ห้ามใช้ `body.as_bytes()[start-1]`
- ความยาว prefix ใช้ byte offset จาก regex match ได้ เพราะ prefix ไม่เคยถูกแก้
- `abs(seconds(line) - seconds(stamp)) <= 30` ใช้ integer วินาที
- label ผู้พูดและเวลาไม่ถูกแตะ

### 5.4 `leftover_numbers` (`bench/correct.py:43`, `:170`)
```python
LEFTOVER_NUMBER_RE = re.compile(
    r"(?:หนึ่ง|สอง|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ยี่สิบ|ร้อย|พัน|หมื่น|แสน|ล้าน)+\s?"
    r"(?:เปอร์เซ็นต์|ตารางเมตร|ชั่วโมง|สัปดาห์|อาทิตย์|เดือน|นาที|สาขา|เมือง|ครั้ง|แห่ง|บาท|วิธี|ราย|ปี|วัน|คน|เขต)"
)
# รันกับ group 3 ของทุกบรรทัดหลังแก้แล้ว ได้ "[MM:SS] คำที่เจอ" เรียงตามบรรทัด
```
- regex ของ Rust ใช้ leftmost-first แบบเดียวกับ Python pattern นี้จึงได้ผลเหมือนกัน (ตรวจด้วย fixture `correct-flash` ที่มี 2 จุด)
- ใช้แค่รายงาน ไม่ได้แก้ข้อความ

### 5.5 ไฟล์ผลลัพธ์
- `<name>.corrected-<model>.txt` = บรรทัดหลังแก้ + `""` + `"## ผู้พูด"` + `"<label>: <role>"` ต่อบรรทัด + `\n` ท้ายไฟล์
- `<name>.changes-<model>.txt` = `render_changes` ใน `bench/correct.py:179` ต้องตรงทุก byte (ลำดับหัวข้อ, ตัวคั่น ` · `, ` -> `, ช่องว่าง) ดู fixture `correct-*.expected-changes.txt`
- `name` ในบรรทัดแรกคือชื่อไฟล์ transcript (`scribe-v2-keyterms.txt` ใน fixture) และ `model_id` คือ id เต็ม (`gemini-3.1-pro-preview`)

### 5.6 ไฟล์ยาว: ต้องแบ่งข้อความ (requirement)
คลิป 17 นาทีใช้ output + thinking ของ Pro ประมาณ 14,000 token ดังนั้นไฟล์ 1 ชม. จะใช้ประมาณ 49,000 (ใกล้เพดาน 65,536) และไฟล์ 3 ชม. เกินแน่นอน

ข้อกำหนด (**ออกแบบไว้ แต่ยังไม่ได้ทดสอบกับไฟล์จริง**):
1. แบ่งบรรทัดเป็นช่วงละประมาณ 30 นาทีตามเวลาเริ่มของบรรทัด แต่ละช่วงมีส่วน "ของตัวเอง" คือ `[start, end)`
2. ข้อความที่ส่งแต่ละ request = บรรทัดของช่วงนั้น + บรรทัดที่ซ้อนกับช่วงก่อนหน้าและถัดไปประมาณ 1 นาที เพื่อให้มีบริบท
3. ส่งพร้อมกันได้ แต่จำกัด concurrency (เช่น 3–4) เพื่อลด 429
4. **ทิ้ง edit และ unclear ที่ `seconds(timestamp)` อยู่นอก `[start, end)` ของช่วงนั้น** ห้ามใช้แค่ dedupe เพราะถ้า edit เดียวกันถูกใช้สองครั้ง (เช่น `สองคน` → `2 คน`) ครั้งที่สองจะไปแก้ `สองคน` อีกจุดในบรรทัดเดียวกัน
5. รวม edit ทุกช่วงตามลำดับเวลาของช่วง แล้วเรียก `apply_edits` ครั้งเดียวกับ transcript ทั้งไฟล์
6. รวม speakers: ต่อหนึ่ง label ถ้ามี role ที่ไม่ใช่ `ไม่ทราบ` แบบเดียว ให้ใช้ค่านั้น ถ้ามีหลายแบบให้ต่อด้วย ` / ` แล้วรายงานให้คนยืนยัน ถ้าไม่มีให้เป็น `ไม่ทราบ`
7. ถ้าช่วงไหนได้ `MAX_TOKENS` ให้แบ่งช่วงนั้นครึ่งหนึ่งแล้วส่งใหม่

การแบ่ง**ข้อความ**ไม่กระทบ label ผู้พูด เพราะ ElevenLabs แยกผู้พูดจากเสียงทั้งไฟล์มาแล้วในขั้นที่ ①

---

## 6. ขั้นที่ ③ สรุปประชุม

Reference: `bench/summarize.py`

### 6.1 Request
- `systemInstruction` = `PROMPT` ใน `bench/summarize.py:39`
- `contents` = ไฟล์ corrected ทั้งไฟล์ (รวม `## ผู้พูด`)
- schema: `fixtures/gemini-summary-request.json`
```
MeetingMinutes {
  title, overview,
  participants:       [ { speaker, role } ],
  segments:           [ { kind: report|advice|discussion, speaker, subject, responds_to: string|null,
                          start: "MM:SS", end: "MM:SS", details: [string], quotes: [ { text, timestamp } ] } ],
  action_items:       [ { task, requested_by: string|null, owner: string|null, due: string|null, timestamps: [string] } ],
  needs_confirmation: [ { text, timestamps: [string] } ]
}
```

### 6.2 `check_minutes` (deterministic, `bench/summarize.py:128`–`:153`, `:260`–`:262`)
ผลลัพธ์ 3 รายการ ถ้ามีรายการไหนไม่ว่างต้องแสดงคำเตือน
1. `unmatched_citations`
   - เวลาที่ถูกอ้าง = `start` ของทุก segment + `timestamp` ของทุก quote + `timestamps` ของ action_items + `timestamps` ของ needs_confirmation (**ไม่นับ `end`** เพราะโมเดลมักคำนวณเอง)
   - เวลาที่มีจริง = ทุกจุดที่ตรงกับ `\d{1,3}:\d{2}` ใน transcript ผ่าน `normalize_stamp`
   - ผล = `sorted({normalize_stamp(s) or s for s in cited} - known)`
2. `quotes_not_in_transcript`: ข้อความ quote ที่ลบ whitespace ออกแล้ว ไม่อยู่ใน `spoken_text(transcript)`
   - `spoken_text` = ลบ prefix `^\[\d{1,3}:\d{2}\]\s*(ผู้พูด\s*\d+\s*[:：])?` ของทุกบรรทัด (multiline) → ลบ `\(\d{1,3}:\d{2}\)` → ลบ whitespace ทั้งหมด
   - quote จึงคร่อมหลายบรรทัดได้
3. `quotes_outside_segment`: quote ที่เวลาไม่อยู่ในช่วง `[seconds(seg.start), limit]` โดย `limit` = `start` ของ segment ถัดไป หรือ `max(seconds(end), seconds(start))` ถ้าเป็น segment สุดท้าย ผลเป็น `"<timestamp> <text>"`

fixture `summary-flash` มี `unmatched_citations: ["05:04"]` ใช้ทดสอบกรณีเจอปัญหา

### 6.3 `render_text` (`bench/summarize.py:156`–`:194`)
ข้อความธรรมดา **ไม่ใช่ Markdown** ต้องตรง fixture `summary-*.expected.txt` ทุก byte
- หัวข้อ segment: `report` → `"{speaker} รายงานเรื่อง{subject}"`, `advice` → `"{speaker} ให้ข้อชี้แนะเรื่อง{subject}"`, `discussion` → `"ถาม-ตอบเรื่อง{subject} ({speaker})"`
- ป้ายชนิด: `รายงาน` / `ข้อชี้แนะ` / `ถาม-ตอบ`
- ค่า null แสดงเป็น `-`; ถ้าไม่มี action item แสดง `- ไม่มี`; ส่วน "ประเด็นที่ควรตรวจสอบกับเสียงจริง" แสดงเฉพาะเมื่อมีรายการ
- บรรทัดท้าย: `สรุปอัตโนมัติด้วย {model_id} จาก {ชื่อไฟล์ transcript} (เวลาอ้างอิงนับจากต้นไฟล์เสียงที่ถอด)` แล้วตามด้วย `\n`

### 6.4 ไฟล์ยาว
Pro ใช้ output + thinking ประมาณ 7,500 token ต่อเสียง 17 นาที ไฟล์ 1 ชม. (~26,000) ส่งครั้งเดียวได้ ไฟล์ 3 ชม. (~78,000) มีโอกาสเกินเพดาน
- v1: ส่งครั้งเดียว ถ้า `finishReason` เป็น `MAX_TOKENS` ให้ error ชัดเจน
- ถ้าต้องรองรับ 3 ชม.: สรุปทีละช่วงประมาณ 60 นาทีด้วย schema เดิม แล้วรวม segments / action_items / needs_confirmation ตามเวลา และเรียกอีกครั้งเพื่อเขียน title + overview จากผลที่รวมแล้ว (**ยังไม่ได้ทดสอบ**)

---

## 7. โครงสร้าง Rust ที่แนะนำ

crate ที่ใช้: `tokio`, `reqwest` (features `json`, `multipart`, `rustls-tls`), `serde` + `serde_json`, `regex`, `anyhow` หรือ `thiserror`, `tracing`

```rust
// เป็นแค่โครงร่าง signature ยังไม่ได้ compile
mod elevenlabs {
    pub struct SttResponse { pub words: Vec<Word>, pub audio_duration_secs: f64, pub language_code: String }
    pub struct Word { pub text: String, pub start: Option<f64>, pub end: Option<f64>, pub kind: WordType, pub speaker_id: Option<String> }
    pub enum WordType { Word, Spacing, AudioEvent }            // serde rename: "word" | "spacing" | "audio_event"
    pub async fn transcribe(http: &reqwest::Client, key: &str, audio: &Path, keyterms: &[String]) -> Result<SttResponse>;
}
mod lines {
    pub fn words_to_lines(words: &[Word], soft: f64, hard: f64, max: f64) -> Vec<String>;
}
mod gemini {
    pub struct Usage { pub prompt: u64, pub candidates: u64, pub thoughts: u64 }
    pub async fn generate_json<T: DeserializeOwned>(http: &reqwest::Client, key: &str, model: &str,
        system: &str, content: &str, response_schema: &serde_json::Value) -> Result<(T, Usage, String /* finishReason */)>;
}
mod correct {
    pub enum EditKind { Correction, Number, Name }
    pub struct Edit { pub timestamp: String, pub original: String, pub replacement: String, pub kind: EditKind, pub reason: String }
    pub struct Corrections { pub edits: Vec<Edit>, pub unclear: Vec<Unclear>, pub speakers: Vec<Speaker> }
    pub fn rejection(edit: &Edit) -> Option<&'static str>;     // ข้อความยาวเกินเป็น format string ใช้ Cow/String แทนได้
    pub fn pad_digits(before: Option<char>, replacement: &str, after: Option<char>) -> String;
    pub fn apply_edits(lines: &mut [String], edits: &[Edit]) -> Vec<Option<String>>;   // None = แก้แล้ว
    pub fn leftover_numbers(lines: &[String]) -> Vec<String>;
    pub fn render_changes(name: &str, model_id: &str, edits: &[Edit], results: &[Option<String>], c: &Corrections, leftovers: &[String]) -> String;
    pub async fn correct_long(/* แบ่งช่วงตามหัวข้อ 5.6 */);
}
mod minutes {
    pub struct MeetingMinutes { /* ตามหัวข้อ 6.1, ฟิลด์ nullable ใช้ Option<String> */ }
    pub struct Checks { pub unmatched_citations: Vec<String>, pub quotes_not_in_transcript: Vec<String>, pub quotes_outside_segment: Vec<String> }
    pub fn check_minutes(m: &MeetingMinutes, transcript: &str) -> Checks;
    pub fn render_text(m: &MeetingMinutes, source_name: &str, model_id: &str) -> String;
}
```

### Unicode และความต่างระหว่าง Python กับ Rust
| Python | Rust | หมายเหตุ |
|---|---|---|
| `len(s)` | `s.chars().count()` | ใช้กับ 40 ตัวอักษร และ 50 ตัวอักษรของ keyterms |
| `s[i-1:i]` | `s[..i].chars().next_back()` | ตัวอักษรก่อนหน้า |
| `x or default` กับ float | `x.filter(\|v\| *v != 0.0).unwrap_or(default)` | `0.0` เป็น false ใน Python |
| `str.strip()` | `str::trim()` | |
| `text.splitlines()` | `str::lines()` | ให้ผลเท่ากันเมื่อไม่มีตัวคั่นบรรทัดพิเศษ (`\x0b`, `\x0c`, `\x85`, `\u2028` ฯลฯ) ซึ่ง transcript ชุดนี้ไม่มี |
| `c.isascii() and c.isalnum()` | `c.is_ascii_alphanumeric()` | |
| `sorted(set_of_str)` | `BTreeSet<String>` | เรียงตาม code point / UTF-8 byte ได้ผลเท่ากัน |
| `re` `\s`, `\d` | `regex` `\s`, `\d` | ทั้งคู่เป็น Unicode |
| `[ก-๏]` | `[ก-๏]` | U+0E01..U+0E4F |

---

## 8. ความเป็นส่วนตัวและความปลอดภัย
- API key อ่านจาก env หรือ secret manager ห้ามพิมพ์ลง log หรือ error
- บัญชี ElevenLabs ต้องปิด "Improve the models for everyone" (Terms and privacy → Data use) ก่อนส่งเสียงจริง ถ้าเป็นประชุมลับควรใช้ Enterprise + Zero Retention Mode (`enable_logging=false`)
- Gemini ต้องใช้ key ของบัญชีที่เปิด billing (paid tier) ข้อมูลจึงไม่ถูกใช้เทรน
- ห้ามส่งเสียงไป Paxa Labs (ข้อตกลงให้สิทธิ์เอาไปเทรน)
- fixtures มีเนื้อหาประชุมจริง ห้าม commit ขึ้น repo สาธารณะหรือส่งออกนอกองค์กร

---

## 9. Golden tests

ทุกไฟล์อยู่ใน `docs/rust-implementation/fixtures/` สร้างใหม่ได้ด้วย `uv run bench/export_fixtures.py` ผลต้องตรงแบบ byte-for-byte

| Test | Input | Expected |
|---|---|---|
| `words_to_lines` | `elevenlabs-response.json` (`words`) ค่า soft 15 / hard 25 / max 60 | `lines.expected.txt` (73 บรรทัด ไม่มีบรรทัดไหนขึ้นต้นด้วยสระหลังหรือวรรณยุกต์) |
| `apply_edits` + `render_changes` (Pro) | `correct.input.txt` + `correct-pro.corrections.json` | `correct-pro.expected.txt`, `correct-pro.expected-changes.txt` (แก้ 48 · ชื่อรอยืนยัน 4 · ปฏิเสธ 0 · เหลือ 0) |
| `apply_edits` + `leftover_numbers` (Flash) | `correct.input.txt` + `correct-flash.corrections.json` | `correct-flash.expected.txt`, `correct-flash.expected-changes.txt` (แก้ 38 · unclear 4 · เหลือ 2) |
| `check_minutes` | `correct-pro.expected.txt` + `summary-{pro,flash}.minutes.json` | `summary-{pro,flash}.expected-checks.json` |
| `render_text` | `summary-{pro,flash}.minutes.json`, source name `scribe-v2-keyterms.corrected-gemini-3.1-pro.txt`, model id `gemini-3.1-pro-preview` / `gemini-3.8-flash` | `summary-{pro,flash}.expected.txt` |
| parse Gemini response | `gemini-correct-response.json` | parse ได้เป็น `Corrections`, `finishReason = STOP`, usage 646 / 271 / 495 |
| request body | สร้าง body จาก prompt + schema + contents ตัวอย่าง | JSON เท่ากับ `gemini-*-request.json` (เทียบเป็น JSON value ไม่ต้องเทียบ byte) |

ตัวอย่าง test ใน Rust:
```rust
#[test]
fn apply_edits_matches_python_pro() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/rust-implementation/fixtures"); // ปรับ path ตามที่วาง crate
    let mut lines: Vec<String> = std::fs::read_to_string(dir.join("correct.input.txt")).unwrap().lines().map(String::from).collect();
    let c: Corrections = serde_json::from_str(&std::fs::read_to_string(dir.join("correct-pro.corrections.json")).unwrap()).unwrap();
    let results = apply_edits(&mut lines, &c.edits);
    // ... ต่อ "## ผู้พูด" แล้วเทียบกับ correct-pro.expected.txt, และ render_changes เทียบกับ correct-pro.expected-changes.txt
}
```

**สิ่งที่ห้ามทำ golden test:** ผลจากการเรียก ElevenLabs หรือ Gemini ใหม่ ผลของ LLM เปลี่ยนทุกครั้ง ถ้าเรียกใหม่แล้วได้ไม่ตรง `correct-pro.expected.txt` ไม่ได้แปลว่าโค้ดผิด

### Smoke test กับ API จริง (รันมือ มีค่าใช้จ่าย)
1. ① กับ `samples/2026-03-17_0b2544a9_ครั้งที่5.2026/clip_senior_chairman_43m30-end.wav` (17:09, ~$0.08): ได้ `language_code = tha`, มีผู้พูด 5 คน, บรรทัดแรกขึ้นต้นด้วย `[00:00] ผู้พูด 1:`
2. ② ด้วย Pro (~$0.18): `finishReason = STOP`, ปฏิเสธ 0 หรือใกล้ 0, ช่วง 11:10 มี `7,000 หรือ 8,000 ตารางเมตร`
3. ③ ด้วย Pro (~$0.10): `check_minutes` ว่างทั้ง 3 รายการ และมีคำว่า `เจิ้งต้า` (ไม่ใช่ `CP ALL`)

---

## 10. เรื่องที่ยังเปิดอยู่
- **เรื่องชื่อคนเลื่อนไปรอบ improve ไม่ต้องทำใน flow แรก (แผน: `docs/plan-clarification-questions.md`):** keyterms ไม่มีชื่อคน, edit ชนิด `name` แค่แสดงใน log ไม่ต้องทำหน้าจอยืนยัน
- prompt สรุปประชุมยังรวมข้อชี้แนะช่วงสั้นๆ ของประธานอาวุโสไว้ในถาม-ตอบ อาจมีการแก้ prompt ต่อ ถ้าแก้ต้องดัก request body และสร้าง fixture ใหม่
- หน้าจอให้คนฟังเช็คช่วง `unclear` และยืนยันชื่อยังไม่ได้ออกแบบ (รอบ improve)
- ยังไม่ได้ทดสอบกับไฟล์ 1–3 ชม. (การแบ่งช่วงในหัวข้อ 5.6 และ 6.4 เป็นแบบที่ออกแบบไว้เท่านั้น)
- Gemini 3.1 Pro ยังเป็น preview ควรสลับไปใช้ `gemini-3.8-flash` ได้ด้วยการตั้งค่า
