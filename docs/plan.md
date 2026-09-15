# Transcripto v2 — แผนการพัฒนา

อ้างอิง design: `prototype/transcripto.html` (artifact 6d834fdc) ใช้ธีม **Minimal** อย่างเดียว (ขาว–ฟ้า `#0A74DA`)
อ้างอิง logic: `docs/rust-implementation/README.md` (ElevenLabs → Gemini ตรวจแก้ → Gemini สรุป) และ POC ใน `bench/`

## Stack

| ส่วน | เลือกใช้ | เหตุผล |
|---|---|---|
| Frontend | Next.js (App Router, TypeScript) + CSS จาก prototype | ตรงตาม design ที่สุด ไม่ต้องแปลงเป็น utility class |
| Backend | Rust: axum, tokio, sqlx, reqwest, argon2, tower-http | ตามที่ผู้ใช้กำหนด |
| Database | PostgreSQL 16 (docker compose) | เก็บ user, session, job, segment, summary และใช้เป็น job queue |
| Queue | ตาราง `jobs` + `FOR UPDATE SKIP LOCKED` ใน worker (tokio task) | ไม่ต้องเพิ่ม Redis/Celery |
| Storage | **MinIO** (container แยกใน docker compose) ผ่าน `aws-sdk-s3` | ไฟล์วิดีโอ/เสียงไม่อยู่ใน container ของ API; ในเครื่อง API มีแค่ไฟล์ทำงานชั่วคราว |
| Media | ffmpeg / ffprobe | แยกเสียง WAV 16 kHz mono, ภาพ thumbnail, ความยาว |
| AI | ElevenLabs Scribe v2 (ถอดเสียง+แยกผู้พูด) → Gemini 3.1 Pro (ตรวจแก้, สรุป) | ตัดสินใจแล้วใน `docs/transcription-solution.md` |
| E2E | Playwright (headless) | อัปโหลดวิดีโอจริง ตรวจ flow ทั้งหมด |

พอร์ต dev: web `3010`, api `8010`, postgres `5440`, MinIO `9010` (S3) / `9011` (console) — 3000/8080 ถูกโปรเจกต์อื่นใช้อยู่
Next.js `rewrites` `/api/*` → api เพื่อให้ cookie เป็น same-origin

## Pipeline ของงาน (4 ช่องใน progress bar ตาม design)

1. **อัปโหลดไฟล์** (ฝั่ง browser, XHR มี progress, ยกเลิกได้) → API เขียนลงไฟล์ทำงาน ตรวจขนาด แล้วส่งขึ้น MinIO `jobs/<id>/source.<ext>`
2. **แยกเสียงจากวิดีโอ** (stage 0) — ffprobe → WAV 16 kHz mono → thumbnail → ส่ง `audio.wav`, `thumb.jpg` ขึ้น MinIO
3. **ถอดความและแยกผู้พูด** (stage 1, มีสองขั้นย่อยในแถบเดียว)
   - ① ElevenLabs `scribe_v2` ส่งเสียง**ทั้งไฟล์** (`language_code=tha`, `diarize=true`, keyterms) → เก็บ response ดิบเป็น `jobs/<id>/stt.json` (ลองใหม่ไม่ต้องจ่ายซ้ำ) → `words_to_lines` ได้บรรทัด `[MM:SS] ผู้พูด N: ข้อความ` พร้อมเวลาเริ่ม/จบจริงของแต่ละบรรทัด (แถบ 0–55%)
   - ② Gemini ตรวจแก้ได้ `Corrections {edits, unclear, speakers}` → `apply_edits` (สคริปต์เป็นคนแก้ ไม่ใช่ LLM) → segments ใน DB + บันทึกการแก้ (`render_changes`) (แถบ 55–100%)
     - ไฟล์ยาว: แบ่งช่วงละ 30 นาทีตามเวลาบรรทัด + บริบทซ้อน ±1 นาที, ส่งพร้อมกันสูงสุด 3, ทิ้ง edit/unclear ที่อยู่นอกช่วงของตัวเอง, รวม edit แล้ว `apply_edits` ครั้งเดียว, รวม speakers ตามกฎข้อ 5.6.6, `MAX_TOKENS` → แบ่งครึ่ง (ลึกสุด 2 ชั้น)
     - ถ้าเสียงยาวไม่เกิน ~35 นาที ส่งครั้งเดียวทั้งไฟล์ (เหมือน POC ทุกอย่าง)
4. **สรุปการประชุม** (stage 2) — Gemini + `responseSchema` ของ MeetingMinutes → `check_minutes` → `render_text` (ข้อความธรรมดา)
   - เนื้อหาที่ส่ง = ทรานสคริปต์หลังแก้ + `## ผู้พูด` (ใช้ชื่อที่ผู้ใช้ตั้งไว้ถ้ามี)
   - ส่งครั้งเดียว ถ้าได้ `MAX_TOKENS` ให้สรุปไม่สำเร็จพร้อมข้อความชัดเจน (README 6.4 v1; การสรุปทีละช่วงรอทดสอบกับไฟล์ยาวจริงก่อน)
   - สรุปล้มเหลวไม่ทำให้งานล้ม: งานเป็น `done` แต่มี `summary_error` และปุ่ม "สรุปใหม่"

Model ตั้งค่าได้: `CORRECT_MODEL`, `SUMMARY_MODEL` (ค่าเริ่มต้น `gemini-3.1-pro-preview`, สลับเป็น `gemini-3.8-flash` ได้)
Keyterms/glossary: ตั้งค่าแยกตามผู้ใช้ในหน้า `/settings` (ดูหัวข้อท้ายไฟล์); รายการเริ่มต้นคือ `api/keyterms.txt` (สำเนาจาก `bench/keyterms.txt`, ไม่มีชื่อคน) เปลี่ยนไฟล์ได้ด้วย `KEYTERMS_FILE`
`AI_FIXTURE_DIR` = โหมดทดสอบ ใช้ `docs/rust-implementation/fixtures` แทนการเรียก ElevenLabs/Gemini (ไม่เสียเงิน)

## Storage (MinIO)

- image `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` (MinIO เลิกอัปเดต image บน Docker Hub แล้ว), volume `miniodata`, bucket `transcripto-media` — API สร้าง bucket เองตอนเริ่ม
- object ต่องาน: `jobs/<id>/source.<ext>`, `audio.wav`, `thumb.jpg`, `stt.json`
- `WORK_DIR` (ค่าเริ่มต้น `<tmp>/transcripto-work`) เก็บไฟล์ระหว่างประมวลผลเท่านั้น ลบทิ้งเมื่องานเสร็จหรือล้มเหลว worker ดาวน์โหลดจาก MinIO เองถ้าไม่มีไฟล์ในเครื่อง (เช่นรีสตาร์ต/ลองใหม่)
- `/media`, `/audio`, `/thumbnail` ส่งต่อจาก MinIO ผ่าน API (ส่ง `Range` ต่อ ได้ 206 เพื่อให้ seek วิดีโอได้, ยังตรวจสิทธิ์เจ้าของงานเหมือนเดิม)
- ลบงาน = ลบทุก object ใต้ `jobs/<id>/`
- งานเก่าใน `data/jobs/` ย้ายขึ้น MinIO ครั้งเดียวด้วย `mc mirror`

## ข้อมูลที่เพิ่ม

- migration `0004`: `jobs.corrections jsonb` (Corrections ดิบ + ผลของแต่ละ edit) และ `jobs.changes_text text`
- `GET /api/jobs/<id>/changes.txt` ดาวน์โหลดบันทึกการตรวจแก้ (ชื่อคนที่รอยืนยัน และช่วงที่ควรฟังเสียงอยู่ในไฟล์นี้ ยังไม่มีหน้าจอยืนยัน)
- `transcript_meta`: เวลาและค่าใช้จ่ายของ ElevenLabs และ Gemini, จำนวนที่แก้/ปฏิเสธ/รอยืนยัน

## Golden tests (README หัวข้อ 9)

`words_to_lines`, `apply_edits` + `render_changes` (Pro, Flash + `leftover_numbers`), `check_minutes`, `render_text`, parse Gemini response, request body (เทียบ JSON value) — อ่านจาก `docs/rust-implementation/fixtures` ตรงแบบ byte-for-byte + unit test การแบ่งช่วงด้วยบรรทัดสังเคราะห์

## ฟีเจอร์ตาม design

- Login อย่างเดียว (อีเมล/รหัสผ่าน, จดจำการเข้าสู่ระบบ, แสดง/ซ่อนรหัสผ่าน, validation) ด้วยบัญชี admin ที่ seed ไว้ — ไม่มี Google login, สมัครใช้งาน, ลืมรหัสผ่าน หรือบัญชีทดลอง (ตัดออกตามที่ผู้ใช้ขอ 15 ก.ย. 2026)
- หน้ารายการงาน: drop zone ลากวางหรือคลิกเลือกไฟล์อย่างเดียว (ไม่มีโควตา ตัวเลือกภาษา จำนวนผู้พูด หรือวิดีโอตัวอย่าง), ค้นหาจากชื่อไฟล์หรือคำในทรานสคริปต์ (แสดงช่วงที่พูด กดแล้วเปิดที่บรรทัดนั้น) + ช่วงวันที่ + เรียงลำดับ + สถานะ เก็บใน URL, ยกเลิก/ลองใหม่/เล่น/ดาวน์โหลด, กระดิ่งนับงานที่กำลังทำ, toast แจ้งเมื่อเสร็จ
- หน้างาน: player (เล่น/หยุด, ±5 วิ, เสียง, ซับ, ความเร็ว, เต็มจอ, แป้นลัด), chip ผู้พูดบนวิดีโอ, การ์ดผู้พูดใต้ player (ตั้งชื่อ บันทึกลง DB + ไทม์ไลน์ + ใครกำลังพูด), ทรานสคริปต์ด้านขวาบน+ค้นหา+เลื่อนตามวิดีโอ, ไฮไลต์คำที่กำลังพูดทั้งซับและทรานสคริปต์ (ประมาณจากเวลาของบรรทัด), ปุ่มดาวน์โหลดสรุปประชุมที่หัวหน้า, ขั้นตอนประมวลผลระหว่างรอ
- **เพิ่มจาก design**: กล่อง "สรุปการประชุม" ด้านขวาล่าง ใต้ทรานสคริปต์ เลื่อนอ่านในกรอบ (ลำดับการประชุม, รายละเอียด, คำพูดสำคัญกดแล้วข้ามไปฟัง, ข้อสั่งการ, ประเด็นที่ควรตรวจสอบ) + ดาวน์โหลด `.txt` แบบ plain text (ตาม `render_text`)
- ดาวน์โหลดทรานสคริปต์ .txt / .csv / .md พร้อมตัวเลือกและตัวอย่าง

## สิ่งที่ตัดออก / เปลี่ยนจาก prototype

- ตัวเลือกธีม, ฉากวิดีโอจำลอง (canvas), เสียงสังเคราะห์, ข้อมูลตัวอย่าง
- "ความแม่นยำ %" — ไม่มีค่านี้จากบริการ จึงแสดงจำนวนช่วงและผู้พูดแทน (ไม่แต่งตัวเลข)
- ไฟล์ที่ browser เล่นไม่ได้ (เช่น MKV/HEVC) → เล่นเฉพาะเสียงที่แยกแล้วแทน
- การถอดเสียงด้วย Gemini โดยตรง (ตัดท่อน 20 นาที + DIARIZE_PROMPT) ถูกแทนด้วย ElevenLabs ทั้งไฟล์ ตั้งแต่ 15 ก.ย. 2026

## ลำดับการทำงาน (รอบ ElevenLabs + MinIO)

1. compose: MinIO + `storage.rs` + ย้ายทุกจุดที่อ่าน/เขียนไฟล์ + ย้ายงานเก่า
2. `elevenlabs.rs`, `lines.rs`, `correct.rs`, ปรับ `minutes.rs`/`gemini.rs` + golden tests
3. worker (stage 1 สองขั้นย่อย, cache `stt.json`, ไฟล์ทำงานชั่วคราว) + fixture mode + CLI `transcribe_file`
4. web: คำอธิบายขั้นตอน + ปุ่มดาวน์โหลดบันทึกการตรวจแก้
5. `cargo test` → e2e โหมด fixture → e2e กับ API จริง (วิดีโอเดโม 2.5 นาที) → smoke test คลิป 17 นาทีตาม README หัวข้อ 9 → docker build

## ตั้งค่า keyterms แยกตามผู้ใช้ (15 ก.ย. 2026)

- ตาราง `user_settings (user_id PK, keyterms text[], updated_at)` — ไม่มีแถว = ใช้รายการเริ่มต้นจาก `api/keyterms.txt`
- `jobs.keyterms text[]` คัดลอกคำของเจ้าของงานตอนสร้างงาน → ลองใหม่ใช้ชุดเดิม, แก้การตั้งค่าแล้วมีผลเฉพาะงานใหม่ (งานเก่าที่เป็น NULL ใช้ค่าปัจจุบันของเจ้าของ)
- ใช้คำชุดเดียวกันทั้งส่งให้ ElevenLabs และเป็น glossary ของขั้นตรวจแก้
- `DELETE /api/settings/keyterms` — ลบแถวของผู้ใช้ กลับไปใช้รายการเริ่มต้น (หน้า Settings เรียกตัวนี้เมื่อกดบันทึกแล้วรายการตรงกับค่าเริ่มต้นพอดี)
- `GET/PUT /api/settings/keyterms` — ตรวจฝั่ง API: ตัดช่องว่างหัวท้าย/ซ้ำ, ตัดคำซ้ำ (ไม่สนตัวพิมพ์เล็กใหญ่), คำละ ≤ 50 ตัวอักษร, ≤ 1000 คำ (ผิดกฎตอบ 400 พร้อมบอกคำที่ผิด ไม่ตัดทิ้งเงียบๆ)
- หน้า `/settings` (เมนูบัญชี → ตั้งค่า): เพิ่มคำ (Enter หรือวางหลายบรรทัด), ชิปลบได้, ค้นหาในรายการ, นับ N/1000, คำเตือนห้ามใส่ชื่อคนและค่าใช้จ่าย +20%, "ใช้รายการเริ่มต้น" / "ลบทั้งหมด" แก้แค่ฉบับร่าง, แถบบันทึก/ยกเลิกเมื่อมีการเปลี่ยนแปลง, เตือนก่อนปิดหน้าเมื่อยังไม่บันทึก
- หน้ารายการงานบอกใต้กล่องอัปโหลดว่าใช้คำเฉพาะกี่คำ พร้อมลิงก์ไปแก้
