# Transcripto

ถอดเสียงวิดีโอภาษาไทยเป็นข้อความ แยกผู้พูด ตรวจแก้คำที่ถอดผิด และสรุปการประชุมแบบเรียงตามเวลา

- **Frontend** `web/` — Next.js 16 (App Router) ใช้ธีม Minimal จาก prototype
- **Backend** `api/` — Rust (axum + sqlx) มี worker ประมวลผลในตัว
- **Database** PostgreSQL 16 (ใช้เป็น job queue ด้วย `FOR UPDATE SKIP LOCKED`)
- **Storage** MinIO (container แยก) เก็บวิดีโอ เสียง thumbnail และผลถอดเสียงดิบ
- **AI** ElevenLabs Scribe v2 ถอดเสียง+แยกผู้พูด → Gemini 3.1 Pro ตรวจแก้ (change list) → Gemini 3.1 Pro สรุป ตาม [`docs/rust-implementation/README.md`](docs/rust-implementation/README.md)
- **Media** ffmpeg / ffprobe

แผนและการตัดสินใจ: [`docs/plan.md`](docs/plan.md) · เหตุผลที่เลือก ElevenLabs + Gemini: `docs/transcription-solution.md` (ไม่อยู่ใน repo สาธารณะ เพราะยกเนื้อหาประชุมจริง)

## โครงสร้าง

```
api/                 Rust API + worker
  migrations/        SQL (รันอัตโนมัติตอนเริ่ม)
  keyterms.txt       รายการคำเฉพาะเริ่มต้น สำหรับผู้ใช้ที่ยังไม่เคยตั้งค่าเอง (ห้ามใส่ชื่อคน)
  src/elevenlabs.rs  ① speech-to-text ทั้งไฟล์ (multipart, keyterms)
  src/lines.rs       ① words → "[MM:SS] ผู้พูด N: ข้อความ" (words_to_lines ตรงกับ Python ทุก byte)
  src/correct.rs     ② prompt/schema, rejection, pad_digits, apply_edits, leftover_numbers, render_changes, แบ่งช่วงไฟล์ยาว
  src/minutes.rs     ③ prompt/schema, check_minutes, render_text
  src/gemini.rs      generateContent + retry (ไม่มี Rust SDK จึงเรียก REST เอง)
  src/pipeline.rs    ต่อ ① ② ③ เข้าด้วยกัน + โหมด fixture
  src/storage.rs     MinIO/S3 (aws-sdk-s3): อัปโหลด ดาวน์โหลด stream แบบ Range ลบทั้งงาน
  src/settings.rs    การตั้งค่าของผู้ใช้: คำเฉพาะ (keyterms) + กฎตรวจความถูกต้อง
  src/worker.rs      claim งานจาก Postgres, heartbeat, progress/ETA, ทำต่อจากขั้นที่ค้าง
  src/routes/        HTTP API
  src/bin/transcribe_file.rs   CLI รัน pipeline กับไฟล์ในเครื่อง (ไม่ใช้ DB/MinIO)
web/                 Next.js
  app/login                    เข้าสู่ระบบด้วยอีเมล/รหัสผ่าน (บัญชี admin ที่ seed ไว้)
  app/(app)/page.tsx           รายการงาน + อัปโหลด (ลากวางหรือเลือกไฟล์) + ค้นหา/กรอง
  app/(app)/settings/page.tsx  ตั้งค่าของบัญชี: คำเฉพาะสำหรับการถอดเสียง (เพิ่ม/วางหลายบรรทัด/ลบ/ค้นหา/บันทึก)
  app/(app)/jobs/[id]/page.tsx ซ้าย: player + ผู้พูด (ตั้งชื่อ, ไทม์ไลน์, ใครกำลังพูด) · ขวาบน: ทรานสคริปต์ + ลิงก์บันทึกการตรวจแก้ · ขวาล่าง: สรุปการประชุม (เลื่อนอ่านในกรอบ)
  app/api/jobs/[id]/file/route.ts  ส่งไฟล์อัปโหลดต่อให้ API แบบ stream (ส่วน /api อื่นใช้ rewrite)
  e2e/                         Playwright
docs/rust-implementation/fixtures/   golden test + ข้อมูลโหมด fixture (มีเนื้อหาประชุมจริง ห้ามเผยแพร่ ไม่อยู่ใน git; ถ้าไม่มี test ที่ใช้จะข้ามไป)
scripts/dev.sh       เปิด db + minio + api + web สำหรับพัฒนา
```

## เริ่มใช้งาน (dev)

ต้องมี: Docker, Rust (stable), Node 24, ffmpeg, yt-dlp (`brew install yt-dlp` ซึ่งลง deno ให้ด้วย — ใช้กับงานจากลิงก์), Google Chrome (สำหรับ e2e)

1. ใส่ key ใน `.env` หรือ `.env.test` ที่ root (ดู `.env.example`)
   ```
   ELEVENLABS_API_KEY=...
   GEMINI_API_KEY=...
   ```
   บัญชี ElevenLabs ต้องปิด "Improve the models for everyone" (Terms and privacy → Data use) ก่อนส่งเสียงประชุมจริง และ Gemini ต้องเป็น key ของบัญชีที่เปิด billing
2. เปิดทุกอย่าง
   ```bash
   scripts/dev.sh            # เรียก ElevenLabs + Gemini จริง
   scripts/dev.sh --fixture  # ไม่เรียก API ใช้ผลที่บันทึกไว้ใน docs/rust-implementation/fixtures (ไว้ทดสอบ flow)
   ```
3. เปิด http://localhost:3010 — บัญชี admin `admin@transcripto.app` รหัสผ่านตาม `ADMIN_PASSWORD` ใน `.env` (seed ตอน API เริ่มครั้งแรก ถ้ายังไม่มีบัญชีและไม่ได้ตั้งค่านี้ API จะไม่เริ่ม; e2e อ่านค่าเดียวกัน)

พอร์ต: web `3010`, api `8010`, postgres `5440`, MinIO S3 `9010` และ console http://localhost:9011 (user/password ตาม `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` หรือค่า dev ใน `docker-compose.yml`) — MinIO เปิดเฉพาะ localhost

รันแยกทีละส่วน:
```bash
docker compose -p transcripto up -d db minio
cd api && cargo run --bin transcripto-api
cd web && npm run dev
```

## Pipeline

| ขั้น (แถบสถานะ) | ทำอะไร |
|---|---|
| อัปโหลดไฟล์ / ดาวน์โหลดจากลิงก์ | **ลิงก์** (`POST /api/jobs/import {url}`): API ตรวจรูปแบบลิงก์ + host ต้องไม่ใช่ localhost/เครือข่ายภายใน แล้วสร้างงาน `processing` ที่ `downloading=true` → worker เรียก `yt-dlp -J` อ่านข้อมูลหน้า (ปฏิเสธเพลย์ลิสต์, ไลฟ์, ยาวเกิน 5 ชม. (`MAX_DURATION_SEC`), ใหญ่เกิน 2 GB) → ตั้งชื่องานตามชื่อวิดีโอ → ดาวน์โหลด (เลือก ≤720p H.264 + AAC, รวมเป็น MP4) → ffprobe ต้องมีเสียงหรือภาพ → เก็บเป็น `source.<ext>` แล้วทำขั้นต่อไปเหมือนไฟล์อัปโหลด ยกเลิก = ลบงาน (worker ฆ่า yt-dlp ทั้ง process group) ลองใหม่ = ดาวน์โหลดใหม่ถ้ายังไม่เสร็จ · **ไฟล์**: browser ส่งไฟล์ด้วย `PUT /api/jobs/{id}/file` → route handler ของ Next ส่งต่อแบบ stream → API เขียนไฟล์ชั่วคราว เช็กว่าขนาดครบ → เก็บใน MinIO `jobs/<id>/source.<ext>` แล้วจึงเข้าคิว |
| แยกเสียงจากวิดีโอ | ffprobe ตรวจความยาว/แทร็กเสียง → WAV 16 kHz mono → thumbnail → เก็บ `audio.wav`, `thumb.jpg` ใน MinIO |
| ถอดความและแยกผู้พูด | ① ElevenLabs `scribe_v2` ส่งเสียง**ทั้งไฟล์** (`language_code=tha`, diarize, keyterms) → เก็บ response ดิบเป็น `stt.json` → `words_to_lines` ② Gemini เสนอรายการแก้ `{edits, unclear, speakers}` → สคริปต์แก้เฉพาะ edit ที่ผ่านกฎ (ไม่แก้ชื่อคนอัตโนมัติ, ไม่เปลี่ยน ครับ/ค่ะ, ข้อความเดิมยาวไม่เกิน 40 ตัวอักษร) → segments + บันทึกการตรวจแก้ |
| สรุปการประชุม | ส่งทรานสคริปต์หลังแก้ + `## ผู้พูด` ให้ Gemini พร้อม `responseSchema` เดียวกับ POC → ตรวจเวลาอ้างอิงและคำพูดว่าตรงกับทรานสคริปต์ → เก็บ JSON และข้อความ .txt |

- ทรานสคริปต์ขึ้นเมื่อตรวจแก้เสร็จ ไม่ต้องรอสรุป
- **ไฟล์ยาว (ขั้นตรวจแก้)**: เกิน ~35 นาทีแบ่งเป็นช่วงละ 30 นาที + บริบทซ้อน ±1 นาที ส่งพร้อมกันสูงสุด 3 ช่วง เก็บเฉพาะ edit ที่อยู่ในช่วงของตัวเอง ถ้าได้ `MAX_TOKENS` แบ่งครึ่ง (ยังไม่ได้ทดสอบกับไฟล์ 1-3 ชม. จริง)
- **ไฟล์ยาว (ขั้นสรุป)**: ส่งครั้งเดียว ถ้าได้ `MAX_TOKENS` จะแจ้งว่าสรุปไม่สำเร็จ (ยังไม่มีการสรุปทีละช่วง ตาม README หัวข้อ 6.4 v1)
- ลองใหม่ได้โดยไม่จ่ายซ้ำ: ถ้าล้มหลังถอดเสียงแล้ว worker ใช้ `stt.json` เดิม และใช้ `audio.wav` เดิม
- สรุปล้มเหลวไม่ทำให้งานล้ม กด "สรุปใหม่" ได้ (ใช้ชื่อผู้พูดที่แก้ไว้ด้วย)
- ปิด/รีสตาร์ต API กลางคัน งานจะถูกหยิบกลับมาทำต่อหลัง lock หมดอายุ 90 วินาที
- เปลี่ยนโมเดลได้ด้วย `CORRECT_MODEL` / `SUMMARY_MODEL` (เช่น `gemini-3.8-flash`)
- **คำเฉพาะ (keyterms) แยกตามผู้ใช้**: ตั้งในหน้า ตั้งค่า (เมนูบัญชี) เก็บในตาราง `user_settings` (`GET/PUT/DELETE /api/settings/keyterms`, DELETE = กลับไปใช้รายการเริ่มต้น) ใช้ทั้งส่งให้ ElevenLabs และเป็นรายการคำอ้างอิงของขั้นตรวจแก้ ผู้ใช้ที่ยังไม่เคยตั้งจะใช้ `api/keyterms.txt` (เปลี่ยนไฟล์ได้ด้วย `KEYTERMS_FILE`) คำจะถูกคัดลอกเข้างานตอนสร้างงาน (`jobs.keyterms`) แก้การตั้งค่าภายหลังไม่กระทบงานเดิมหรือการกดลองใหม่ กฎ: คำละไม่เกิน 50 ตัวอักษร ไม่เกิน 1000 คำ ไม่ซ้ำ (ไม่สนตัวพิมพ์เล็กใหญ่) — มีคำอย่างน้อย 1 คำ ElevenLabs คิดเพิ่ม 20%

`transcript_meta` ของงานเก็บเวลา/ค่าใช้จ่ายของแต่ละขั้น, `corrections` เก็บรายการแก้ทั้งหมดพร้อมผล, `GET /api/jobs/{id}/changes.txt` ดาวน์โหลดบันทึกการตรวจแก้ (ชื่อคนที่รอยืนยัน และช่วงที่ควรฟังเสียงอีกครั้งอยู่ในไฟล์นี้)

## ค่าใช้จ่ายและเวลา (วัดจริง 15 ก.ย. 2026)

| ไฟล์ | ① ElevenLabs | ② ตรวจแก้ (Pro) | ③ สรุป (Pro) |
|---|---|---|---|
| ประชุมจริง 17 นาที (bench) | $0.076, 82 วินาที | $0.18, 96 วินาที | $0.10, 65 วินาที |
| ประชุมจริง 11 นาที (ผ่านแอป) | ~$0.05 | $0.13, 132 วินาที | $0.11, 63 วินาที |

ประมาณ $1.3/ชั่วโมงเสียง ($0.26 ElevenLabs พร้อม keyterms + Gemini Pro ที่คิด thinking token เป็น output)

## ทดสอบ

```bash
cd api && cargo test                      # golden test ตาม docs/rust-implementation README หัวข้อ 9 (ตรงกับ Python ทุก byte) + การแบ่งช่วง
cd web && npx playwright test             # e2e (ต้องเปิด stack ไว้ก่อน)
```

- e2e ใช้ Google Chrome (`channel: "chrome"`) เพราะ Chromium ของ Playwright เล่น H.264/AAC ไม่ได้
- โหมด fixture จบในไม่ถึงนาที ผลตรวจแก้ในโหมดนี้ส่วนใหญ่ถูกปฏิเสธเพราะ fixture ทำจากไฟล์ 77 บรรทัด (ปกติ)
- ไฟล์ทดสอบอยู่ใน `samples/` (`demo_meeting_150s.mp4`, `e2e_no_audio.mp4`, `e2e_not_video.txt`) เปลี่ยนวิดีโอได้ด้วย `E2E_VIDEO=/path/to/video.mp4`
- smoke test กับ API จริงโดยไม่ใช้ DB: `cd api && cargo run --bin transcribe_file -- <ไฟล์> <โฟลเดอร์ผลลัพธ์>` (ได้ transcript/corrected/changes/summary .txt)
- `link.spec.ts` เสิร์ฟวิดีโอจาก 127.0.0.1 เอง จึงต้องเปิด API ด้วย `URL_IMPORT_ALLOW_PRIVATE=1` (`scripts/dev.sh --fixture` ตั้งให้) และมี yt-dlp ในเครื่อง — ตรวจ: คลิกช่องลิงก์ไม่เปิดตัวเลือกไฟล์, ลิงก์ผิดรูปแบบ, ดาวน์โหลดแล้วเล่น/Range 206/ถอดเสียงจนเสร็จ, ไม่ส่ง token ในลิงก์กลับมา, ลากลิงก์มาวาง, ลิงก์ที่ไม่ใช่วิดีโอ + ลองใหม่ + ลบ, เปิดหน้างานระหว่างดาวน์โหลดไม่ได้, ยกเลิกแล้วเซิร์ฟเวอร์หยุดดาวน์โหลดจริง
- สิ่งที่ e2e ตรวจ: แก้ข้อความทีละบรรทัด (Esc ยกเลิก, Enter บันทึก, รีโหลดแล้วยังอยู่), เปลี่ยนชื่อผู้พูดแล้วชื่อในข้อความเปลี่ยนตาม + เลิกทำ, ป้ายสรุปไม่ตรงทรานสคริปต์ + สรุปใหม่, หน้าตั้งค่าคำเฉพาะ (เพิ่ม, คำซ้ำ, คำยาวเกิน, วางหลายบรรทัด, ยกเลิก, บันทึกแล้วรีโหลด, ฉบับร่างค้างเมื่อออกจากหน้า, ลบทั้งหมด, API ปฏิเสธคำยาว — คืนค่ารายการเดิมให้หลังจบ), login/validation/logout, ไม่มีหน้าสมัครและลืมรหัสผ่าน, ค้นหางานจากคำในทรานสคริปต์ + กรองวันที่ + เรียง + กดผลค้นหาแล้วเปิดที่บรรทัดนั้น + ย้อนกลับได้ตัวกรองเดิม, ไฮไลต์คำที่กำลังพูด, ปุ่มดาวน์โหลดสรุปที่หัวหน้า, บันทึกการตรวจแก้, อัปโหลดและติดตามสถานะ, เปิดดูระหว่างประมวลผล, เล่นและ seek วิดีโอจริง, แป้นลัด, ค้นหา, เปลี่ยนชื่อผู้พูดแล้วรีโหลด, ดาวน์โหลด .txt/.csv, สรุปใต้ทรานสคริปต์ที่เลื่อนในกรอบ + ดาวน์โหลดสรุป + กดเวลาเพื่อข้ามไปฟัง, คลิกพื้นที่อัปโหลดเพื่อเลือกไฟล์, ลากวางไฟล์, ไฟล์ที่ไม่ใช่วิดีโอ, วิดีโอไม่มีเสียง + ลองใหม่ + ลบ, ยกเลิกระหว่างอัปโหลด, อัปโหลดไฟล์เกิน 10 MB ได้ครบทุกไบต์, ไม่มี Google login และโควตา, ไม่มี error ใน console

## Deploy ด้วย Docker

```bash
# .env ข้าง docker-compose.yml (chmod 600): ELEVENLABS_API_KEY, GEMINI_API_KEY, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD,
# POSTGRES_PASSWORD, ADMIN_PASSWORD (ต้องตั้งก่อนเริ่มครั้งแรก), COOKIE_SECURE=true, WEB_PORT=127.0.0.1:3011
docker compose -p transcripto --profile app up -d --build
```

ควรวาง reverse proxy (HTTPS) ไว้หน้า web ไฟล์ทั้งหมดอยู่ใน volume `miniodata` ของ MinIO ถ้าใช้ nginx ให้ตั้ง `client_max_body_size 2g` และ `proxy_request_buffering off` เพื่อให้อัปโหลดไฟล์ใหญ่ได้

> อย่าย้ายการอัปโหลดกลับไปใช้ rewrite ของ Next: rewrite จะคัดลอก body เข้าหน่วยความจำและตัดไฟล์ที่ 10 MB

ย้ายไฟล์ของงานเก่า (ก่อนมี MinIO เก็บใน `data/jobs/<id>/` หรือ volume `media`) เข้า bucket:
```bash
# U / P = MINIO_ROOT_USER / MINIO_ROOT_PASSWORD
docker run --rm --network transcripto_default -v "$PWD/data/jobs:/src:ro" -e U="$MINIO_ROOT_USER" -e P="$MINIO_ROOT_PASSWORD" \
  --entrypoint sh quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z -c \
  'mc alias set local http://minio:9000 "$U" "$P" && mc mb --ignore-existing local/transcripto-media && mc mirror /src local/transcripto-media/jobs'
```

## Environment

ดูทั้งหมดใน `.env.example` — ตัวที่ต้องตั้งใน production: `ELEVENLABS_API_KEY`, `GEMINI_API_KEY`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `POSTGRES_PASSWORD`, `ADMIN_PASSWORD`, `COOKIE_SECURE=true`, `WEB_PORT`

เข้าสู่ระบบด้วยบัญชี admin ที่ seed ไว้เท่านั้น (ไม่มีสมัครใช้งาน ลืมรหัสผ่าน หรือโควตา) รหัสผ่าน hardcode ไว้ ก่อนเปิดให้คนนอกเข้าถึงควรเปลี่ยนรหัสผ่านใน DB

## ข้อจำกัดที่รู้อยู่

- **ความแม่นยำ %** ใน design ถูกตัดออก เพราะบริการไม่ให้ค่านี้ (แสดงจำนวนช่วงและผู้พูดแทน)
- **เปลี่ยนชื่อผู้พูดแล้วแทนชื่อเดิมในข้อความด้วย** แบบหาข้อความตรงตัว ภาษาไทยไม่มีช่องว่างคั่นคำ ชื่อที่เป็นส่วนหนึ่งของชื่ออื่นจึงถูกแทนด้วย (เปลี่ยน "คุณเบน" จะไปแก้ "คุณเบนซ์" เป็น "คุณ Aซ์") มีปุ่มเลิกทำใน toast และแก้ทีละบรรทัดได้; ชื่อที่เป็นป้าย "ผู้พูด N" ไม่ถูกแทน
- **แก้ข้อความแล้วสรุปไม่อัปเดตเอง** กล่องสรุปจะบอกว่าทรานสคริปต์เปลี่ยน (เทียบ hash ของข้อความที่ใช้สรุป ใน `summary_meta.transcript_hash`) ให้กด "สรุปใหม่" เอง เพราะเรียก Gemini มีค่าใช้จ่าย; สรุปที่ทำก่อนมีฟีเจอร์นี้จะไม่ขึ้นป้าย
- **ชื่อคนที่รอยืนยัน / ช่วงที่ถอดไม่ชัด** ยังไม่มีหน้าจอให้ยืนยัน ดูได้จากบันทึกการตรวจแก้ (`changes.txt`) เท่านั้น
- **ไฮไลต์คำที่กำลังพูด** ยังเป็นค่าประมาณจากเวลาเริ่ม-จบของบรรทัด (กระจายตามความยาวคำ) ทั้งที่ `stt.json` มีเวลารายคำจาก ElevenLabs แล้ว — ทำให้ตรงทุกคำได้ในรอบถัดไป
- **สรุปการประชุมยาวมาก** (ประมาณ 2-3 ชม.) อาจเกินเพดาน output ของ Gemini และสรุปไม่สำเร็จ
- ไม่มี rate limit ที่ endpoint login
- ไฟล์ที่ browser เล่นไม่ได้ (เช่น MKV/HEVC) จะเล่นเฉพาะเสียงที่แยกไว้
- **งานจากลิงก์**: ได้เฉพาะลิงก์ที่เปิดดูได้โดยไม่ต้องเข้าสู่ระบบ (Google Drive ต้องแชร์แบบ "ทุกคนที่มีลิงก์") · YouTube มักบล็อก IP ของ VPS ("confirm you're not a bot") งานจะแจ้งให้ดาวน์โหลดไฟล์มาอัปโหลดเอง · การกัน localhost/เครือข่ายภายในตรวจเฉพาะ host ของลิงก์ที่วาง ไม่ได้ตรวจ redirect ที่ yt-dlp ตามไป (แอปมีบัญชี admin เดียว ถ้าจะเปิดให้คนอื่นใช้ควรบังคับ egress ผ่าน proxy) · yt-dlp/deno pin เวอร์ชันใน `api/Dockerfile` เว็บต้นทางเปลี่ยนบ่อย ถ้าดาวน์โหลดเริ่มพังให้อัปเดตเวอร์ชันและ checksum
