"use client";

import Link from "next/link";
import { memo } from "react";
import { STAGE_NAMES, type Job, type TranscriptMatch } from "@/lib/api";
import { ci, etaText, fmtSize, initialOf, tc, thWhen } from "@/lib/format";
import type { UploadState } from "@/lib/jobs";
import { snippet, splitMatches } from "@/lib/libraryFilters";
import { Icon } from "./Icon";

export function pipeFractions(j: Job, up?: UploadState): number[] {
  if (j.status === "uploading") return [up ? up.loaded / Math.max(1, up.total) : 0, 0, 0, 0];
  if (j.status === "done") return [1, 1, 1, 1];
  return [1, ...[0, 1, 2].map((k) => (k < j.stage ? 1 : k === j.stage ? j.stage_pct : 0))];
}

const actIdx = (j: Job) => (j.status === "uploading" ? 0 : j.status === "processing" ? j.stage + 1 : -1);

function uploadEta(up: UploadState) {
  const elapsed = (performance.now() - up.startedAt) / 1000;
  if (up.loaded <= 0 || elapsed < 0.5) return "";
  const rate = up.loaded / elapsed;
  return ` · ${etaText((up.total - up.loaded) / rate)}`;
}

function StatusBlock({ j, up }: { j: Job; up?: UploadState }) {
  const fr = pipeFractions(j, up);
  const pipe = (
    <div className={`pipe${j.status === "failed" ? " err" : ""}`} aria-hidden="true">
      {fr.map((v, k) => (
        <i key={k} className={k === actIdx(j) ? "act" : ""} style={{ ["--f" as string]: v.toFixed(3) }} />
      ))}
    </div>
  );
  if (j.status === "uploading") {
    if (!up) {
      return (
        <>
          <span className="pill err">
            <Icon name="alert" />
            อัปโหลดค้างอยู่
          </span>
          {pipe}
          <span className="job-err">การอัปโหลดถูกขัดจังหวะ ยกเลิกแล้วอัปโหลดใหม่อีกครั้ง</span>
        </>
      );
    }
    return (
      <>
        <span className="pill up">
          <Icon name="upload" />
          กำลังอัปโหลด
        </span>
        {pipe}
        <span className="pipe-label" data-lbl>
          <span className="mono">{Math.round((up.loaded / Math.max(1, up.total)) * 100)}%</span> · {fmtSize(up.loaded)} จาก {fmtSize(up.total)}
          {uploadEta(up)}
        </span>
      </>
    );
  }
  if (j.status === "processing") {
    return (
      <>
        <span className="pill run">
          <Icon name="loader" className="spin" />
          กำลังถอดเสียง
        </span>
        {pipe}
        <span className="pipe-label" data-lbl>
          {STAGE_NAMES[Math.min(2, j.stage)]} <span className="mono">{Math.round(j.stage_pct * 100)}%</span>
          {j.eta_sec != null ? ` · ${etaText(j.eta_sec)}` : ""}
        </span>
      </>
    );
  }
  if (j.status === "failed") {
    return (
      <>
        <span className="pill err">
          <Icon name="alert" />
          ไม่สำเร็จ
        </span>
        {pipe}
        <span className="job-err">{j.error}</span>
      </>
    );
  }
  return (
    <>
      <span className="pill ok">
        <Icon name="check" />
        เสร็จแล้ว
      </span>
      {pipe}
      <span className="pipe-label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span className="av-stack" aria-hidden="true">
          {j.speakers.slice(0, 4).map((s, i) => (
            <span key={i} className={`c${ci(i)}`}>
              {initialOf(s.name)}
            </span>
          ))}
        </span>
        ผู้พูด {j.speakers.length} คน · {j.segment_count} ช่วง
        {j.summary_status === "failed" ? " · สรุปไม่สำเร็จ" : j.summary_status === "running" || j.summary_status === "pending" ? " · กำลังสรุปใหม่" : ""}
      </span>
    </>
  );
}

function Highlight({ text, q }: { text: string; q: string }) {
  return (
    <>
      {splitMatches(text, q).map((p, k) => (p.hit ? <mark key={k}>{p.t}</mark> : <span key={k}>{p.t}</span>))}
    </>
  );
}

interface Props {
  j: Job;
  up?: UploadState;
  index: number;
  isNew: boolean;
  justDone: boolean;
  /** Current library search, highlighted in the title and the transcript snippet. */
  q: string;
  match?: TranscriptMatch;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onDownload: (id: string, opener: HTMLElement) => void;
}

export const JobRow = memo(function JobRow({ j, up, index, isNew, justDone, q, match, onCancel, onRetry, onRemove, onDownload }: Props) {
  const playable = j.status === "processing" || j.status === "done";
  const duration = j.duration_sec ?? up?.duration;
  const thumbInner = (
    <>
      {j.has_thumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/jobs/${j.id}/thumbnail`} alt="" />
      ) : up?.frame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={up.frame} alt="" />
      ) : (
        <span className="thumb-ph">
          <Icon name={j.has_video === false ? "music" : "film"} />
        </span>
      )}
      {playable && (
        <span className="thumb-play">
          <Icon name="play" className="fill" />
        </span>
      )}
      {duration ? <span className="dur">{tc(duration)}</span> : null}
    </>
  );
  return (
    <li
      className={`job${isNew ? " is-new" : ""}${justDone ? " just-done" : ""}`}
      id={`row-${j.id}`}
      data-status={j.status}
      data-testid="job-row"
      style={{ ["--d" as string]: `${Math.min(index, 12) * 45}ms` }}
    >
      {playable ? (
        <Link className="thumb" href={`/jobs/${j.id}`} tabIndex={-1} aria-hidden="true">
          {thumbInner}
        </Link>
      ) : (
        <span className="thumb">{thumbInner}</span>
      )}
      <div className="job-info">
        {playable ? (
          <Link className="job-title" href={`/jobs/${j.id}`}>
            <Highlight text={j.name} q={q} />
          </Link>
        ) : (
          <span className="job-title">
            <Highlight text={j.name} q={q} />
          </span>
        )}
        <div className="job-meta">
          <span>
            <Icon name="hdd" />
            {fmtSize(j.size_bytes)}
          </span>
          <span>
            <Icon name="clock" />
            {thWhen(j.created_at)}
          </span>
        </div>
        {match && q.trim() && (
          <Link
            className="job-hit"
            href={`/jobs/${j.id}?q=${encodeURIComponent(q.trim())}&t=${(match.start + 0.05).toFixed(2)}`}
            data-testid="job-hit"
            aria-label={`เปิดทรานสคริปต์ที่ ${tc(match.start)}: ${match.text}`}
          >
            <span className="job-hit-time">
              <Icon name="file-text" />
              <span className="mono">{tc(match.start)}</span>
            </span>
            <span className="job-hit-txt">
              <Highlight text={snippet(match.text, q.trim())} q={q} />
            </span>
            {match.hits > 1 && <span className="job-hit-more">พบอีก {match.hits - 1} ช่วง</span>}
          </Link>
        )}
      </div>
      <div className="job-status">
        <StatusBlock j={j} up={up} />
      </div>
      <div className="job-actions">
        {j.status === "uploading" ? (
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => onCancel(j.id)}>
            <Icon name="x" />
            ยกเลิก
          </button>
        ) : j.status === "failed" ? (
          <>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => onRetry(j.id)}>
              <Icon name="refresh" />
              ลองอีกครั้ง
            </button>
            <button className="icon-btn" type="button" aria-label={`ลบงาน ${j.name}`} title="ลบงาน" onClick={() => onRemove(j.id)}>
              <Icon name="trash" />
            </button>
          </>
        ) : (
          <>
            <Link className="btn btn-secondary btn-sm" href={`/jobs/${j.id}`}>
              <Icon name="play" />
              เล่นวิดีโอ
            </Link>
            <button
              className="icon-btn"
              type="button"
              disabled={j.segment_count === 0}
              aria-label={`ดาวน์โหลดทรานสคริปต์ ${j.name}`}
              title={j.segment_count ? "ดาวน์โหลดทรานสคริปต์" : "ดาวน์โหลดได้เมื่อถอดเสียงเสร็จ"}
              onClick={(e) => onDownload(j.id, e.currentTarget)}
            >
              <Icon name="download" />
            </button>
          </>
        )}
      </div>
    </li>
  );
});
