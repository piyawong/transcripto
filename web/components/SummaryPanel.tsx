"use client";

import { useState } from "react";
import { api, type JobDetail, type Minutes } from "@/lib/api";
import { etaText, stampSeconds } from "@/lib/format";
import { saveSummary } from "@/lib/exports";
import { Icon } from "./Icon";
import { useToast } from "./Toasts";

const KIND_LABEL: Record<Minutes["segments"][number]["kind"], string> = { report: "รายงาน", advice: "ข้อชี้แนะ", discussion: "ถาม-ตอบ" };

function heading(s: Minutes["segments"][number]) {
  if (s.kind === "report") return `${s.speaker} รายงานเรื่อง${s.subject}`;
  if (s.kind === "advice") return `${s.speaker} ให้ข้อชี้แนะเรื่อง${s.subject}`;
  return `ถาม-ตอบเรื่อง${s.subject} (${s.speaker})`;
}

function Stamp({ at, onSeek }: { at: string; onSeek: (t: number) => void }) {
  const sec = stampSeconds(at);
  if (sec < 0) return <span className="mono">{at}</span>;
  return (
    <button type="button" className="stamp mono" onClick={() => onSeek(sec)} title={`ข้ามไปฟังช่วง ${at}`}>
      {at}
    </button>
  );
}

export function SummaryPanel({ job, onSeek, onRetried }: { job: JobDetail; onSeek: (t: number) => void; onRetried: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const m = job.summary;
  const st = job.summary_status;

  const retry = async () => {
    setBusy(true);
    try {
      await api(`/api/jobs/${job.id}/summary/retry`, { method: "POST" });
      toast("เริ่มสรุปการประชุมใหม่แล้ว", { icon: "sparkles" });
      onRetried();
    } catch (e) {
      toast((e as Error).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  };

  if (st === "waiting" || st === "pending" || st === "running" || (!m && st !== "failed")) {
    return (
      <div className="sum sum-wait" data-testid="summary-waiting">
        <p className="proc-eta">
          <Icon name="loader" className="spin" />
          <span>
            {st === "waiting" ? "จะสรุปการประชุมให้อัตโนมัติเมื่อถอดเสียงเสร็จ" : "กำลังสรุปการประชุมจากทรานสคริปต์…"}
            {st !== "waiting" && job.eta_sec != null ? ` ${etaText(job.eta_sec)}` : ""}
          </span>
        </p>
        <div className="skel-list" aria-hidden="true">
          {[70, 92, 84, 60, 88].map((w, i) => (
            <div key={i}>
              <div className="skel" style={{ width: "40%" }} />
              <div className="skel" style={{ width: `${w}%` }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (st === "failed" || !m) {
    return (
      <div className="sum">
        <p className="dlg-note" role="alert">
          สรุปการประชุมไม่สำเร็จ{job.summary_error ? `: ${job.summary_error}` : ""}
        </p>
        <button className="btn btn-secondary btn-sm" type="button" onClick={retry} disabled={busy}>
          <Icon name="refresh" />
          สรุปใหม่
        </button>
      </div>
    );
  }

  const checks = job.summary_meta?.checks;
  const issues = checks ? checks.quotes_not_in_transcript.length + checks.quotes_outside_segment.length + checks.unmatched_citations.length : 0;

  return (
    <div className="sum" data-testid="summary">
      <div className="sum-tools">
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          onClick={() => {
            saveSummary(job);
            toast("ดาวน์โหลดสรุปการประชุม .txt แล้ว", { icon: "download" });
          }}
        >
          <Icon name="download" />
          ดาวน์โหลด .txt
        </button>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(job.summary_text ?? "");
              toast("คัดลอกสรุปการประชุมแล้ว", { icon: "copy" });
            } catch {
              toast("คัดลอกอัตโนมัติไม่ได้ ลองดาวน์โหลดเป็นไฟล์แทน", { kind: "err" });
            }
          }}
        >
          <Icon name="copy" />
          คัดลอก
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={retry} disabled={busy} title="ให้ AI สรุปใหม่จากทรานสคริปต์ล่าสุด (รวมชื่อผู้พูดที่แก้ไว้)">
          <Icon name="refresh" />
          สรุปใหม่
        </button>
      </div>

      <h3 className="sum-title">{m.title}</h3>
      <p className="sum-overview">{m.overview}</p>

      {m.participants.length > 0 && (
        <section className="sum-sec">
          <h4>ผู้เข้าร่วม</h4>
          <ul className="sum-people">
            {m.participants.map((p, i) => (
              <li key={i}>
                <span className="mono">{p.speaker}</span> {p.role}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sum-sec">
        <h4>ลำดับการประชุม</h4>
        <ol className="sum-timeline">
          {m.segments.map((s, i) => (
            <li key={i}>
              <Stamp at={s.start} onSeek={onSeek} />
              <span className={`kind kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
              <span className="sum-tl-txt">
                {s.speaker} · {s.subject}
              </span>
            </li>
          ))}
        </ol>
      </section>

      {m.segments.map((s, i) => (
        <section className="sum-sec sum-seg" key={i}>
          <h4>
            {i + 1}. {heading(s)}
          </h4>
          <p className="sum-when">
            เวลา <Stamp at={s.start} onSeek={onSeek} />–<span className="mono">{s.end}</span>
            {s.responds_to ? ` · ต่อจากการรายงานเรื่อง${s.responds_to}` : ""}
          </p>
          <ul className="sum-points">
            {s.details.map((d, k) => (
              <li key={k}>{d}</li>
            ))}
          </ul>
          {s.quotes.length > 0 && (
            <div className="sum-quotes">
              {s.quotes.map((q, k) => (
                <blockquote key={k}>
                  “{q.text}” <Stamp at={q.timestamp} onSeek={onSeek} />
                </blockquote>
              ))}
            </div>
          )}
        </section>
      ))}

      <section className="sum-sec">
        <h4>ข้อสั่งการ / สิ่งที่ต้องดำเนินการ</h4>
        {m.action_items.length ? (
          <ol className="sum-actions">
            {m.action_items.map((a, i) => (
              <li key={i}>
                <p>{a.task}</p>
                <p className="sum-meta">
                  ผู้สั่งการ: {a.requested_by || "-"} · ผู้รับผิดชอบ: {a.owner || "-"} · กำหนด: {a.due || "-"}
                  {a.timestamps.length > 0 && (
                    <>
                      {" · อ้างอิง "}
                      {a.timestamps.map((t, k) => (
                        <span key={k}>
                          {k > 0 && ", "}
                          <Stamp at={t} onSeek={onSeek} />
                        </span>
                      ))}
                    </>
                  )}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="sum-meta">ไม่มี</p>
        )}
      </section>

      {(m.needs_confirmation.length > 0 || issues > 0) && (
        <section className="sum-sec">
          <h4>ประเด็นที่ควรตรวจสอบกับเสียงจริง</h4>
          <ul className="sum-points">
            {m.needs_confirmation.map((c, i) => (
              <li key={i}>
                {c.text}{" "}
                {c.timestamps.map((t, k) => (
                  <span key={k}>
                    {k > 0 && ", "}
                    <Stamp at={t} onSeek={onSeek} />
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {issues > 0 && checks && (
            <p className="mock-note">
              ระบบตรวจพบจุดที่อ้างอิงไม่ตรงกับทรานสคริปต์ {issues} จุด
              {checks.quotes_not_in_transcript.length ? ` · คำพูดที่ไม่พบในทรานสคริปต์: ${checks.quotes_not_in_transcript.map((q) => `“${q}”`).join(", ")}` : ""}
              {checks.quotes_outside_segment.length ? ` · คำพูดที่เวลาอยู่นอกช่วง: ${checks.quotes_outside_segment.join(", ")}` : ""}
              {checks.unmatched_citations.length ? ` · เวลาอ้างอิงที่ไม่มีในทรานสคริปต์: ${checks.unmatched_citations.join(", ")}` : ""}
            </p>
          )}
        </section>
      )}

      <p className="sum-foot">สรุปอัตโนมัติด้วย {job.summary_meta?.model_id ?? "Gemini"} · เวลาอ้างอิงนับจากต้นไฟล์ · กดเวลาเพื่อข้ามไปฟัง</p>
    </div>
  );
}
