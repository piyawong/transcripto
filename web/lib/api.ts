export type JobStatus = "uploading" | "processing" | "done" | "failed";
export type SummaryStatus = "waiting" | "pending" | "running" | "done" | "failed";

export interface Speaker {
  label: string;
  name: string;
  role?: string | null;
  talk_sec: number;
  pct: number;
}

export interface Job {
  id: string;
  name: string;
  size_bytes: number;
  status: JobStatus;
  /** 0 แยกเสียง, 1 ถอดความ แยกผู้พูด และตรวจแก้, 2 สรุป */
  stage: number;
  stage_pct: number;
  eta_sec: number | null;
  error: string | null;
  duration_sec: number | null;
  has_video: boolean | null;
  has_thumb: boolean;
  speakers: Speaker[];
  segment_count: number;
  summary_status: SummaryStatus;
  summary_error: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface Segment {
  start: number;
  end: number;
  speaker: number;
  text: string;
}

export interface Minutes {
  title: string;
  participants: { speaker: string; role: string }[];
  overview: string;
  segments: {
    kind: "report" | "advice" | "discussion";
    speaker: string;
    subject: string;
    responds_to: string | null;
    start: string;
    end: string;
    details: string[];
    quotes: { text: string; timestamp: string }[];
  }[];
  action_items: { task: string; requested_by: string | null; owner: string | null; due: string | null; timestamps: string[] }[];
  needs_confirmation: { text: string; timestamps: string[] }[];
}

export interface SummaryMeta {
  model_id: string;
  cost_usd: number;
  checks?: { unmatched_citations: string[]; quotes_not_in_transcript: string[]; quotes_outside_segment: string[] };
}

/** What the correction step did (transcript_meta.correct); absent on jobs transcribed before it existed. */
export interface CorrectionMeta {
  applied_correction: number;
  applied_number: number;
  names_to_confirm: number;
  unclear: number;
}

export interface JobDetail extends Job {
  segments: Segment[];
  /** A correction log (changes.txt) can be downloaded. */
  has_changes: boolean;
  transcript_meta: { correct?: CorrectionMeta } & Record<string, unknown> | null;
  summary: Minutes | null;
  summary_text: string | null;
  summary_meta: SummaryMeta | null;
}

export interface User {
  id: string;
  email: string;
  name: string;
}

/** GET/PUT /api/settings/keyterms: the user's terms for speech-to-text and the correction glossary. */
export interface KeytermSettings {
  terms: string[];
  /** Never saved: the system defaults apply. */
  is_default: boolean;
  updated_at: string | null;
  default_terms: string[];
  max_terms: number;
  max_chars: number;
}

/** A job whose transcript contains the search text, with the first matching line. */
export interface TranscriptMatch {
  id: string;
  hits: number;
  start: number;
  text: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
      cache: "no-store",
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง");
  }
  if (!res.ok) {
    let msg = "เกิดข้อผิดพลาด ลองใหม่อีกครั้ง";
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

export const STAGE_NAMES = ["แยกเสียงจากวิดีโอ", "ถอดความและแยกผู้พูด", "สรุปการประชุม"];
