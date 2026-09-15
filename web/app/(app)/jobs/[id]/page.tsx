"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DownloadDialog } from "@/components/DownloadDialog";
import { Icon } from "@/components/Icon";
import { SummaryPanel } from "@/components/SummaryPanel";
import { useToast } from "@/components/Toasts";
import { api, ApiError, STAGE_NAMES, type JobDetail, type Segment } from "@/lib/api";
import { ci, clamp, etaText, fmtSize, initialOf, tc, thDur, thWhen } from "@/lib/format";
import { saveSummary } from "@/lib/exports";
import { useJobs } from "@/lib/jobs";
import { splitMatches } from "@/lib/libraryFilters";
import { splitWords, wordAt, type Word } from "@/lib/words";

const RM = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Index of the segment playing at t, or -1 (segments are sorted by start). */
function findSeg(segs: Segment[], t: number) {
  let lo = 0, hi = segs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 && t < segs[ans].end ? ans : -1;
}

function changesLabel(j: JobDetail) {
  const c = j.transcript_meta?.correct;
  if (!c) return "บันทึกการตรวจแก้";
  const fixed = c.applied_correction + c.applied_number;
  return c.names_to_confirm > 0 ? `ตรวจแก้ ${fixed} จุด · ชื่อรอยืนยัน ${c.names_to_confirm}` : `ตรวจแก้ ${fixed} จุด`;
}

const needsPolling = (j: JobDetail) =>
  j.status === "processing" || j.status === "uploading" || j.summary_status === "pending" || j.summary_status === "running";

export default function JobPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { setViewing, patchJob, refresh: refreshJobs, libraryHref } = useJobs();
  const [job, setJob] = useState<JobDetail | null>(null);

  const load = useCallback(async () => {
    try {
      const j = await api<JobDetail>(`/api/jobs/${id}`);
      if (j.status === "uploading" || j.status === "failed") {
        toast(j.status === "uploading" ? "ยังเปิดดูไม่ได้ รอให้อัปโหลดเสร็จก่อน" : "งานนี้ถอดเสียงไม่สำเร็จ กด “ลองอีกครั้ง” ที่หน้ารายการงาน", { kind: "err" });
        router.replace("/");
        return;
      }
      setJob(j);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 400)) {
        toast("ไม่พบงานนี้ อาจถูกลบไปแล้ว", { kind: "err" });
        router.replace("/");
      }
    }
  }, [id, router, toast]);

  useEffect(() => {
    setViewing(id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch; state is set after the request resolves
    load();
    return () => setViewing(null);
  }, [id, load, setViewing]);

  const polling = job ? needsPolling(job) : false;
  useEffect(() => {
    if (!polling) return;
    const h = setInterval(load, 2000);
    return () => clearInterval(h);
  }, [polling, load]);

  if (!job) {
    return (
      <div className="wrap">
        <p className="empty">กำลังโหลด…</p>
      </div>
    );
  }
  return (
    <JobView
      key={job.id}
      job={job}
      setJob={setJob}
      reload={() => {
        load();
        refreshJobs();
      }}
      patchJob={patchJob}
      libraryHref={libraryHref}
    />
  );
}

function JobView({
  job,
  setJob,
  reload,
  patchJob,
  libraryHref,
}: {
  job: JobDetail;
  setJob: React.Dispatch<React.SetStateAction<JobDetail | null>>;
  reload: () => void;
  patchJob: ReturnType<typeof useJobs>["patchJob"];
  libraryHref: string;
}) {
  const toast = useToast();
  const segs = job.segments;
  const hasTranscript = segs.length > 0;
  const done = job.status === "done";

  const rootRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLInputElement>(null);
  const tCurRef = useRef<HTMLSpanElement>(null);
  const phRef = useRef<HTMLSpanElement>(null);
  const txRef = useRef<HTMLOListElement>(null);
  // Opened from a library search hit (/jobs/<id>?q=<word>&t=<seconds>): start at that line with the word highlighted.
  // JobView only renders in the browser (after the job is fetched), so reading location here is safe.
  const [linkParams] = useState(() => new URLSearchParams(window.location.search));
  const tRef = useRef(Math.max(0, Number(linkParams.get("t")) || 0));
  const rafRef = useRef(0);
  const scrubbing = useRef(false);
  const userScrollUntil = useRef(0);

  const [mode, setMode] = useState<"media" | "audio" | "none">("media");
  const [dur, setDur] = useState(job.duration_sec ?? 0);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(-1);
  const [cc, setCc] = useState(true);
  const [muted, setMuted] = useState(false);
  const [vol, setVol] = useState(100);
  const [rate, setRate] = useState(1);
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState(() => linkParams.get("q") ?? "");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ d: number; k: number } | null>(null);
  const [dlOpen, setDlOpen] = useState<HTMLElement | null>(null);
  const [txIn, setTxIn] = useState(false);
  const segCount = useRef(segs.length);

  const D = dur || job.duration_sec || 1;
  const curRef = useRef(cur);
  const segsRef = useRef(segs);
  useEffect(() => {
    curRef.current = cur;
  }, [cur]);
  // Word being spoken inside the current line (estimated, see lib/words.ts), for caption and transcript.
  const words = useMemo(() => segs.map((g) => splitWords(g.text)), [segs]);
  const wordsRef = useRef(words);
  const [word, setWord] = useState(-1);
  const wordRef = useRef(-1);

  // Transcript arriving while the page is open: animate it in.
  useEffect(() => {
    if (segCount.current === 0 && segs.length > 0 && !RM()) {
      setTxIn(true);
      const t = setTimeout(() => setTxIn(false), 1200);
      segCount.current = segs.length;
      return () => clearTimeout(t);
    }
    segCount.current = segs.length;
  }, [segs.length]);

  const paint = useCallback(() => {
    const t = tRef.current;
    const d = dur || job.duration_sec || 1;
    if (tCurRef.current) tCurRef.current.textContent = tc(t);
    const sc = scrubRef.current;
    if (sc) {
      if (!scrubbing.current) sc.value = String(Math.round((t / d) * 1000));
      sc.style.setProperty("--pct", `${((t / d) * 100).toFixed(2)}%`);
      sc.setAttribute("aria-valuetext", `${thDur(t)} จาก ${thDur(d)}`);
    }
    if (phRef.current) phRef.current.style.left = `${clamp((t / d) * 100, 0, 100).toFixed(3)}%`;
    const idx = findSeg(segsRef.current, t);
    if (idx !== curRef.current) setCur(idx);
    const g = segsRef.current[idx];
    const w = g ? wordAt(wordsRef.current[idx] ?? [], (t - g.start) / Math.max(0.1, g.end - g.start)) : -1;
    if (w !== wordRef.current) {
      wordRef.current = w;
      setWord(w);
    }
  }, [dur, job.duration_sec]);

  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    if (!playing) {
      paint();
      return;
    }
    const loop = () => {
      const v = videoRef.current;
      if (v) tRef.current = v.currentTime || 0;
      paint();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, paint]);

  useEffect(() => {
    rootRef.current?.classList.toggle("is-playing", playing);
  }, [playing]);

  // Segments can arrive while the page is open (transcription finished): re-evaluate the current line.
  useEffect(() => {
    segsRef.current = segs;
    wordsRef.current = words;
    paint();
  }, [segs, words, paint]);

  const seekTo = useCallback(
    (t: number) => {
      const v = videoRef.current;
      tRef.current = clamp(t, 0, dur || job.duration_sec || 0);
      if (v) {
        try {
          v.currentTime = tRef.current;
        } catch {}
      }
      paint();
    },
    [dur, job.duration_sec, paint],
  );

  const play = useCallback(
    (on: boolean) => {
      const v = videoRef.current;
      if (!v || mode === "none") {
        if (on) toast("ไฟล์นี้เล่นในเบราว์เซอร์ไม่ได้", { kind: "err" });
        return;
      }
      if (on) {
        if (tRef.current >= (dur || 0) - 0.05 && dur > 0) seekTo(0);
        const p = v.play();
        p?.catch((e: Error) => {
          if (e.name !== "AbortError") toast("เล่นวิดีโอไม่ได้ ลองกดเล่นอีกครั้ง", { kind: "err" });
          setPlaying(false);
        });
      } else v.pause();
    },
    [dur, mode, seekTo, toast],
  );

  const skip = useCallback(
    (d: number) => {
      seekTo(tRef.current + d);
      if (!RM()) setFlash({ d, k: Date.now() });
    },
    [seekTo],
  );

  // Keyboard shortcuts (same as the prototype).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector("dialog[open]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tg = e.target as HTMLElement;
      if (tg.closest?.('input:not([type="range"]), textarea, select, [contenteditable="true"]')) return;
      if (e.key === " " || e.key === "k") {
        if (tg.closest?.("button, a") && e.key === " ") return;
        e.preventDefault();
        play(videoRef.current?.paused ?? true);
      } else if (e.key === "ArrowLeft" && (tg as HTMLInputElement).type !== "range") {
        e.preventDefault();
        skip(-5);
      } else if (e.key === "ArrowRight" && (tg as HTMLInputElement).type !== "range") {
        e.preventDefault();
        skip(5);
      } else if (e.key === "c" || e.key === "C") setCc((x) => !x);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [play, skip]);

  // Keep the active line in view.
  useEffect(() => {
    if (cur < 0 || !follow || performance.now() < userScrollUntil.current) return;
    const tx = txRef.current;
    const el = tx?.querySelector<HTMLElement>(`.seg[data-i="${cur}"]`);
    if (!tx || !el) return;
    tx.scrollTo({ top: Math.max(0, el.offsetTop - tx.clientHeight * 0.3), behavior: RM() ? "auto" : "smooth" });
  }, [cur, follow]);

  // Stable handler so transcript lines (memoized) don't all re-render on every tick.
  const seekLineRef = useRef<(i: number) => void>(() => {});
  useEffect(() => {
    seekLineRef.current = (i: number) => {
      userScrollUntil.current = 0;
      seekTo(segs[i].start + 0.01);
      if (!playing) play(true);
    };
  }, [segs, playing, play, seekTo]);
  const onSeekLine = useCallback((i: number) => seekLineRef.current(i), []);

  const s = cur >= 0 ? segs[cur] : null;
  const spkName = (i: number) => job.speakers[i]?.name ?? `ผู้พูด ${i + 1}`;

  const hits = useMemo(() => {
    const needle = q.trim();
    if (!needle) return 0;
    return segs.reduce((n, g) => n + splitMatches(g.text, needle).filter((p) => p.hit).length, 0);
  }, [q, segs]);

  const saveName = async (i: number, value: string) => {
    setRenaming(null);
    const old = job.speakers[i].name;
    const name = value.trim();
    if (!name || name === old) return;
    setJob((j) => (j ? { ...j, speakers: j.speakers.map((sp, k) => (k === i ? { ...sp, name } : sp)) } : j));
    try {
      const r = await api<{ speakers: JobDetail["speakers"] }>(`/api/jobs/${job.id}/speakers/${i}`, { method: "PATCH", body: { name } });
      patchJob({ id: job.id, speakers: r.speakers });
      toast(`เปลี่ยน “${old}” เป็น “${name}” ทั้งทรานสคริปต์แล้ว`, { icon: "pencil" });
    } catch (e) {
      setJob((j) => (j ? { ...j, speakers: j.speakers.map((sp, k) => (k === i ? { ...sp, name: old } : sp)) } : j));
      toast((e as Error).message, { kind: "err" });
    }
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-rename="${i}"]`)?.focus());
  };

  const mediaSrc = mode === "audio" ? `/api/jobs/${job.id}/audio` : `/api/jobs/${job.id}/media`;
  const audioOnly = mode === "audio" || job.has_video === false;
  const stepState = (k: number) => {
    if (k === 0) return "done";
    const st = k - 1;
    return job.stage > st || job.status === "done" ? "done" : job.stage === st ? "active" : "pending";
  };

  return (
    <div className="view-enter" ref={rootRef}>
      <div className="wrap">
        <div className="job-top">
          <div className="job-top-l">
            <Link className="crumb" href={libraryHref}>
              <Icon name="chevron-left" />
              งานถอดเสียงทั้งหมด
            </Link>
            <h1 tabIndex={-1} data-testid="job-title">
              {job.name}
            </h1>
            <div className="job-meta">
              {done ? (
                <span className="pill ok" data-testid="job-status">
                  <Icon name="check" />
                  ถอดเสียงเสร็จแล้ว
                </span>
              ) : (
                <span className="pill run" data-testid="job-status">
                  <Icon name="loader" className="spin" />
                  {hasTranscript ? "กำลังสรุปการประชุม" : "กำลังถอดเสียงเบื้องหลัง"}
                </span>
              )}
              <span>
                <Icon name="hdd" />
                {fmtSize(job.size_bytes)}
              </span>
              <span>
                <Icon name="clock" />
                อัปโหลด {thWhen(job.created_at)}
              </span>
            </div>
          </div>
          <div className="job-top-r">
            <div className="job-dl">
              <button
                className="btn btn-secondary"
                type="button"
                aria-disabled={job.summary_status !== "done" || !job.summary_text}
                data-testid="btn-download-summary"
                onClick={() => {
                  if (job.summary_status === "done" && job.summary_text) {
                    saveSummary(job);
                    toast("ดาวน์โหลดสรุปการประชุม .txt แล้ว", { icon: "download" });
                  } else if (job.summary_status === "failed") {
                    toast("สรุปการประชุมไม่สำเร็จ กด “สรุปใหม่” ในกล่องสรุปการประชุม", { kind: "err" });
                  } else {
                    toast(`สรุปการประชุมยังไม่พร้อม${job.eta_sec != null ? ` ${etaText(job.eta_sec)}` : " จะพร้อมหลังถอดเสียงเสร็จ"}`, { icon: "clock" });
                  }
                }}
              >
                <Icon name="file-text" />
                ดาวน์โหลดสรุปประชุม
              </button>
              <button
                className="btn btn-primary"
                type="button"
                aria-disabled={!hasTranscript}
                data-testid="btn-download"
                onClick={(e) => {
                  if (!hasTranscript) {
                    toast(`ทรานสคริปต์ยังไม่พร้อม${job.eta_sec != null ? ` ${etaText(job.eta_sec)}` : ""}`, { icon: "clock" });
                    return;
                  }
                  videoRef.current?.pause();
                  setDlOpen(e.currentTarget);
                }}
              >
                <Icon name="download" />
                ดาวน์โหลดทรานสคริปต์
              </button>
            </div>
            <span className="dl-note">{hasTranscript ? `${segs.length} ช่วง · ผู้พูด ${job.speakers.length} คน` : "ดาวน์โหลดได้เมื่อถอดเสียงเสร็จ"}</span>
          </div>
        </div>

        <div className="job-grid">
          <div className="main-col">
            <div className="player" ref={playerRef}>
              <div className="stage" onClick={() => play(videoRef.current?.paused ?? true)}>
                {mode !== "none" && (
                  <video
                    ref={videoRef}
                    src={mediaSrc}
                    playsInline
                    preload="metadata"
                    data-testid="video"
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      if (isFinite(v.duration) && v.duration > 0) setDur(v.duration);
                      v.volume = vol / 100;
                      v.muted = muted;
                      v.playbackRate = rate;
                      if (tRef.current > 0) v.currentTime = tRef.current;
                    }}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => setPlaying(false)}
                    onTimeUpdate={(e) => {
                      if (!playing) {
                        tRef.current = e.currentTarget.currentTime;
                        paint();
                      }
                    }}
                    onError={() => {
                      setPlaying(false);
                      if (mode === "media" && job.stage >= 1) {
                        setMode("audio");
                        toast("เบราว์เซอร์เล่นวิดีโอไฟล์นี้ไม่ได้ จึงเล่นเฉพาะเสียงแทน", { icon: "info" });
                      } else {
                        setMode("none");
                      }
                    }}
                  />
                )}
                {(audioOnly || mode === "none") && (
                  <div className="stage-art" aria-hidden="true">
                    <Icon name={mode === "none" ? "alert" : "music"} />
                    <span>{mode === "none" ? "เล่นไฟล์นี้ในเบราว์เซอร์ไม่ได้ ระบบยังถอดเสียงให้ตามปกติ" : "ไฟล์เสียง"}</span>
                  </div>
                )}
                <div
                  key={!hasTranscript ? "proc" : s ? `s${s.speaker}` : "none"}
                  className={`ov-chip${!hasTranscript || !s ? " idle" : ` c${ci(s.speaker)} swap`}`}
                  aria-hidden="true"
                  data-testid="ov-chip"
                >
                  {!hasTranscript ? (
                    <>
                      <Icon name="loader" className="spin" />
                      <span>กำลังวิเคราะห์ผู้พูด…</span>
                    </>
                  ) : !s ? (
                    <span>ไม่มีเสียงพูดในช่วงนี้</span>
                  ) : (
                    <>
                      <span className="ov-av">{initialOf(spkName(s.speaker))}</span>
                      <span className="ov-txt">
                        <small>กำลังพูด</small>
                        <b>{spkName(s.speaker)}</b>
                      </span>
                      <span className="eq on">
                        <i />
                        <i />
                        <i />
                        <i />
                      </span>
                    </>
                  )}
                </div>
                {s && cc && (
                  <p key={cur} className={`caption c${ci(s.speaker)}${RM() ? "" : " cap-in"}`} data-testid="caption">
                    <b>{spkName(s.speaker)}</b>
                    <Spoken words={words[cur]} at={word} />
                  </p>
                )}
                {!playing && mode !== "none" && (
                  <button
                    className="big-play"
                    type="button"
                    aria-label="เล่นวิดีโอ"
                    onClick={(e) => {
                      e.stopPropagation();
                      play(true);
                    }}
                  >
                    <Icon name="play" className="fill" />
                  </button>
                )}
                {flash && (
                  <span key={flash.k} className={`seek-flash ${flash.d < 0 ? "l" : "r"}`} onAnimationEnd={() => setFlash(null)}>
                    <Icon name={flash.d < 0 ? "back" : "fwd"} />
                    <b>
                      {flash.d < 0 ? "−" : "+"}
                      {Math.abs(flash.d)} วินาที
                    </b>
                  </span>
                )}
              </div>
              <div className="scrub-row">
                <span className="time" ref={tCurRef}>
                  00:00
                </span>
                <input
                  ref={scrubRef}
                  className="scrub"
                  type="range"
                  min={0}
                  max={1000}
                  step={1}
                  defaultValue={0}
                  aria-label="ตำแหน่งในวิดีโอ"
                  onInput={(e) => {
                    scrubbing.current = true;
                    seekTo((+e.currentTarget.value / 1000) * D);
                  }}
                  onChange={() => {
                    scrubbing.current = false;
                  }}
                  onPointerUp={() => {
                    scrubbing.current = false;
                  }}
                />
                <span className="time">{tc(D)}</span>
              </div>
              <div className="ctrl-row">
                <button className="cbtn" type="button" aria-label={playing ? "หยุดชั่วคราว" : "เล่น"} onClick={() => play(!playing)} data-testid="c-play">
                  <Icon key={String(playing)} name={playing ? "pause" : "play"} className={RM() ? "fill" : "fill ico-in"} />
                </button>
                <button className="cbtn c-fwd-back" type="button" aria-label="ย้อนกลับ 5 วินาที" title="ย้อนกลับ 5 วินาที" onClick={() => skip(-5)}>
                  <Icon name="back" />
                </button>
                <button className="cbtn c-fwd-back" type="button" aria-label="ข้ามไปข้างหน้า 5 วินาที" title="ข้ามไปข้างหน้า 5 วินาที" onClick={() => skip(5)}>
                  <Icon name="fwd" />
                </button>
                <button
                  className="cbtn"
                  type="button"
                  aria-label={muted ? "เปิดเสียง" : "ปิดเสียง"}
                  onClick={() => {
                    const m = !muted;
                    setMuted(m);
                    if (videoRef.current) videoRef.current.muted = m;
                  }}
                >
                  <Icon name={muted ? "mute" : "volume"} />
                </button>
                <input
                  className="vol"
                  type="range"
                  min={0}
                  max={100}
                  value={vol}
                  aria-label="ระดับเสียง"
                  style={{ ["--pct" as string]: `${vol}%` }}
                  onChange={(e) => {
                    const v = +e.target.value;
                    setVol(v);
                    if (videoRef.current) {
                      videoRef.current.volume = v / 100;
                      videoRef.current.muted = v === 0;
                    }
                    setMuted(v === 0);
                  }}
                />
                <span className="ctrl-spacer" />
                <button className="cbtn" type="button" aria-pressed={cc} aria-label="ซับไตเติล" title="ซับไตเติล (C)" onClick={() => setCc((x) => !x)}>
                  <Icon name="captions" />
                </button>
                <label>
                  <span className="sr-only">ความเร็วในการเล่น</span>
                  <select
                    className="rate"
                    value={rate}
                    onChange={(e) => {
                      const r = +e.target.value;
                      setRate(r);
                      if (videoRef.current) videoRef.current.playbackRate = r;
                    }}
                  >
                    {[0.75, 1, 1.25, 1.5, 2].map((r) => (
                      <option key={r} value={r}>
                        {r}×
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="cbtn"
                  type="button"
                  aria-label="เต็มจอ"
                  title="เต็มจอ"
                  onClick={() => {
                    const el = playerRef.current;
                    if (document.fullscreenElement) {
                      document.exitFullscreen?.();
                      return;
                    }
                    if (!el?.requestFullscreen) {
                      toast("เบราว์เซอร์นี้ไม่รองรับโหมดเต็มจอ", { kind: "err" });
                      return;
                    }
                    el.requestFullscreen().catch(() => toast("หน้านี้ไม่อนุญาตโหมดเต็มจอ", { kind: "err" }));
                  }}
                >
                  <Icon name="maximize" />
                </button>
              </div>
            </div>
            <p className="player-note">
              <span>{mode === "audio" ? "เบราว์เซอร์เล่นวิดีโอนี้ไม่ได้ จึงเล่นเสียงที่แยกจากวิดีโอแทน" : "กำลังเล่นไฟล์ของคุณพร้อมเสียงต้นฉบับ"}</span>
              <span>
                แป้นลัด <span className="kbd">Space</span> เล่น/หยุด · <span className="kbd">←</span> <span className="kbd">→</span> ข้าม 5 วินาที · <span className="kbd">C</span>{" "}
                ซับไตเติล
              </span>
            </p>

            <section className="card lanes-card" aria-labelledby="lanes-h" data-testid="speakers">
              <div className="sec-title">
                <h2 id="lanes-h">ผู้พูด</h2>
                <span className="sec-note">
                  {hasTranscript ? `ตรวจพบ ${job.speakers.length} คน · กดดินสอเพื่อตั้งชื่อ · คลิกที่แถบเพื่อข้ามไปช่วงนั้น` : "จะแสดงเมื่อแยกผู้พูดเสร็จ"}
                </span>
              </div>
              {!hasTranscript ? (
                <div className="lanes" aria-hidden="true">
                  {[0, 1].map((r) => (
                    <div key={r} style={{ display: "contents" }}>
                      <div className="lane-label" style={{ gridRow: r + 1, gridColumn: 1 }}>
                        <div className="skel" style={{ width: "80%" }} />
                      </div>
                      <div className="lane-skel skel" style={{ gridRow: r + 1, height: 30 }} />
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="lanes"
                  data-testid="lanes"
                  onClick={(e) => {
                    const tr = (e.target as HTMLElement).closest(".lane-track");
                    if (!tr) return;
                    const r = tr.getBoundingClientRect();
                    seekTo(((e.clientX - r.left) / r.width) * D);
                  }}
                >
                  {job.speakers.map((sp, i) => (
                    <div key={i} style={{ display: "contents" }}>
                      <div className={`spk lane-spk c${ci(i)}${s?.speaker === i ? " on" : ""}`} style={{ gridRow: i + 1, gridColumn: 1 }}>
                        <span className="avatar" aria-hidden="true">
                          {initialOf(sp.name)}
                        </span>
                        <div className="spk-main">
                          <span className="spk-name">
                            {renaming === i ? (
                              <>
                                <label className="sr-only" htmlFor={`rn-${i}`}>
                                  ชื่อผู้พูด
                                </label>
                                <input
                                  className="rename"
                                  id={`rn-${i}`}
                                  defaultValue={sp.name}
                                  maxLength={40}
                                  autoFocus
                                  onFocus={(e) => e.currentTarget.select()}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      saveName(i, e.currentTarget.value);
                                    }
                                    if (e.key === "Escape") {
                                      e.preventDefault();
                                      setRenaming(null);
                                    }
                                  }}
                                  onBlur={(e) => saveName(i, e.currentTarget.value)}
                                />
                              </>
                            ) : (
                              <>
                                <span className="t" title={sp.name}>
                                  {sp.name}
                                </span>
                              </>
                            )}
                          </span>
                          <span className="spk-meta">
                            <span className="mono">{tc(sp.talk_sec)}</span>
                            <span className="mono">{Math.round(sp.pct * 100)}%</span>
                            <span className="now">กำลังพูด</span>
                          </span>
                        </div>
                        <span className="eq" aria-hidden="true">
                          <i />
                          <i />
                          <i />
                          <i />
                        </span>
                        <button className="icon-btn" type="button" data-rename={i} aria-label={`ตั้งชื่อ ${sp.name}`} onClick={() => setRenaming(i)}>
                          <Icon name="pencil" />
                        </button>
                      </div>
                      <div className={`lane-track c${ci(i)}`} style={{ gridRow: i + 1, gridColumn: 2 }} aria-hidden="true">
                        {segs.map((g, k) =>
                          g.speaker === i ? (
                            <i
                              key={k}
                              className={k === cur ? "on" : ""}
                              style={{ left: `${((g.start / D) * 100).toFixed(3)}%`, width: `${(((g.end - g.start) / D) * 100).toFixed(3)}%` }}
                            />
                          ) : null,
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="ph-col" style={{ gridRow: `1 / span ${job.speakers.length}` }}>
                    <span className="ph" ref={phRef} />
                  </div>
                  <div className="ruler" style={{ gridRow: job.speakers.length + 1 }}>
                    {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                      <span key={f}>{tc(D * f)}</span>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>

          <div className="side-col">
            <section className="card tx-card" aria-label="ทรานสคริปต์">
              {!hasTranscript ? (
                <div className="proc" data-testid="proc">
                  <div className="proc-head">
                    <span className="pill run">
                      <Icon name="loader" className="spin" />
                      ทำงานอยู่เบื้องหลัง
                    </span>
                    <h2>ดูวิดีโอไปก่อนได้เลย</h2>
                    <p>ระบบกำลังถอดเสียง แยกผู้พูด และสรุปการประชุม ปิดหน้านี้หรือไปทำงานอื่นได้ เราจะแจ้งเตือนเมื่อเสร็จ</p>
                  </div>
                  <ol className="steps">
                    {[
                      ["อัปโหลดไฟล์", `${fmtSize(job.size_bytes)}${job.duration_sec ? ` · ความยาว ${tc(job.duration_sec)}` : ""}`],
                      [STAGE_NAMES[0], "แปลงเป็นไฟล์เสียง WAV 16 kHz โมโน"],
                      [STAGE_NAMES[1], "ถอดเสียงทั้งไฟล์พร้อมเวลาและผู้พูด แล้วตรวจแก้คำที่ถอดผิดและตัวเลข"],
                      [STAGE_NAMES[2], "สรุปเรียงตามเวลา: ใครรายงานอะไร ข้อชี้แนะ และข้อสั่งการ"],
                    ].map(([t, d], k) => {
                      const st = stepState(k);
                      return (
                        <li key={k} className={`step ${st}`} data-step={k}>
                          <span className="step-ic">{st === "done" ? <Icon name="check" /> : k + 1}</span>
                          <div className="step-b">
                            <b>{t}</b>
                            <span className="s">{d}</span>
                            {st === "active" && (
                              <div className="bar">
                                <i style={{ ["--f" as string]: job.stage_pct.toFixed(3) }} />
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                  <p className="proc-eta">
                    <Icon name="clock" />
                    <span>
                      {STAGE_NAMES[Math.min(2, job.stage)]} {Math.round(job.stage_pct * 100)}%{job.eta_sec != null ? ` · ${etaText(job.eta_sec)}` : ""}
                    </span>
                  </p>
                  <div className="skel-list" aria-hidden="true">
                    {[78, 92, 64, 86].map((w, i) => (
                      <div className="skel-row" key={i}>
                        <div className="skel" style={{ width: 40 }} />
                        <div>
                          <div className="skel" style={{ width: "34%" }} />
                          <div className="skel" style={{ width: `${w}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className="tx-head">
                    <div className="sec-title">
                      <h2 id="tx-h">ทรานสคริปต์</h2>
                      <span className="sec-note">
                        {segs.length} ช่วง · ผู้พูด {job.speakers.length} คน
                        {job.has_changes && (
                          <>
                            {" · "}
                            <a
                              className="link"
                              href={`/api/jobs/${job.id}/changes.txt`}
                              download
                              title="คำที่แก้ ชื่อคนที่รอยืนยัน และช่วงที่ควรฟังเสียงอีกครั้ง"
                              data-testid="dl-changes"
                            >
                              {changesLabel(job)}
                            </a>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="tx-tools">
                      <label className="search">
                        <Icon name="search" />
                        <span className="sr-only">ค้นหาในทรานสคริปต์</span>
                        <input type="search" placeholder="ค้นหาคำในทรานสคริปต์" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} data-testid="tx-search" />
                      </label>
                      <label className="follow">
                        <input
                          className="switch"
                          type="checkbox"
                          role="switch"
                          checked={follow}
                          onChange={(e) => {
                            setFollow(e.target.checked);
                            userScrollUntil.current = 0;
                          }}
                        />
                        เลื่อนตามวิดีโอ
                      </label>
                    </div>
                    {q.trim() && (
                      <p className="tx-found" aria-live="polite" data-testid="tx-found">
                        {hits ? `พบ “${q.trim()}” ${hits} ตำแหน่ง · กดที่ประโยคเพื่อข้ามไปฟัง` : `ไม่พบ “${q.trim()}” ลองใช้คำที่สั้นลง`}
                      </p>
                    )}
                  </div>
                  <ol
                    className={`tx${q.trim() ? " searching" : ""}${txIn ? " tx-in" : ""}`}
                    ref={txRef}
                    data-testid="transcript"
                    onWheel={() => (userScrollUntil.current = performance.now() + 5000)}
                    onTouchMove={() => (userScrollUntil.current = performance.now() + 5000)}
                  >
                    {segs.map((g, i) => (
                      <SegLine
                        key={i}
                        i={i}
                        g={g}
                        cont={i > 0 && segs[i - 1].speaker === g.speaker}
                        name={spkName(g.speaker)}
                        on={i === cur}
                        words={words[i]}
                        at={i === cur ? word : -1}
                        q={q.trim()}
                        onSeek={onSeekLine}
                      />
                    ))}
                  </ol>
                </>
              )}
            </section>

            <section className="card sum-card" aria-labelledby="sum-h">
              <div className="sum-head">
                <div className="sec-title">
                  <h2 id="sum-h">สรุปการประชุม</h2>
                  <span className="sec-note">
                    {job.summary_status === "done" ? "เลื่อนลงเพื่ออ่านต่อ" : job.summary_status === "failed" ? "สรุปไม่สำเร็จ" : "กำลังเตรียมสรุป"}
                  </span>
                </div>
              </div>
              <div className="sum-scroll" data-testid="summary-scroll">
                <SummaryPanel
                  job={job}
                  onSeek={(t) => {
                    seekTo(t);
                    play(true);
                  }}
                  onRetried={reload}
                />
              </div>
            </section>
          </div>
        </div>
      </div>
      <DownloadDialog job={dlOpen ? job : null} opener={dlOpen} onClose={() => setDlOpen(null)} />
    </div>
  );
}

/** Line text with words already spoken, the word being spoken, and words still to come styled apart. */
function Spoken({ words, at }: { words: Word[]; at: number }) {
  return (
    <>
      {words.map((w, k) => (
        <span key={k} className={k < at ? "kw kw-said" : k === at ? "kw kw-now" : "kw"}>
          {w.t}
        </span>
      ))}
    </>
  );
}

const SegLine = memo(function SegLine({
  i,
  g,
  cont,
  name,
  on,
  words,
  at,
  q,
  onSeek,
}: {
  i: number;
  g: Segment;
  cont: boolean;
  name: string;
  on: boolean;
  words: Word[];
  /** Word being spoken when this is the current line, else -1. */
  at: number;
  q: string;
  onSeek: (i: number) => void;
}) {
  const parts = q ? splitMatches(g.text, q) : null;
  const hit = !!parts && parts.some((p) => p.hit);
  return (
    <li style={i < 14 ? { ["--seg-delay" as string]: `${i * 35}ms` } : undefined}>
      <button className={`seg c${ci(g.speaker)}${cont ? " cont" : ""}${on ? " on" : ""}${hit ? " hit" : ""}`} type="button" data-i={i} aria-current={on || undefined} onClick={() => onSeek(i)}>
        <span className="seg-time">{tc(g.start)}</span>
        <span className="seg-body">
          {cont ? (
            <span className="sr-only">{name}</span>
          ) : (
            <span className="seg-who">
              <i className="dot" />
              <span>{name}</span>
            </span>
          )}
          <span className="seg-text">
            {hit ? (
              parts!.map((p, k) => (p.hit ? <mark key={k}>{p.t}</mark> : <span key={k}>{p.t}</span>))
            ) : on && at >= 0 ? (
              <Spoken words={words} at={at} />
            ) : (
              g.text
            )}
          </span>
        </span>
        <span className="seg-prog" aria-hidden="true" />
      </button>
    </li>
  );
});
