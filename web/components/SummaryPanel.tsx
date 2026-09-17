"use client";

import { useState } from "react";
import { api, type JobDetail, type Minutes } from "@/lib/api";
import { etaText, stampSeconds } from "@/lib/format";
import { saveSummary } from "@/lib/exports";
import { Icon } from "./Icon";
import { useToast } from "./Toasts";

function heading(s: Minutes["segments"][number]) {
  if (s.kind === "report") return `วาระ: ${s.subject.replace(/^วาระ:\s*/, "")}`;
  if (s.kind === "advice") return `ข้อชี้แนะจาก${s.speaker}`;
  return `ประเด็นถาม-ตอบ: ${s.subject}`;
}

function actionHeading(items: Minutes["action_items"]) {
  const requesters = [...new Set(items.map((a) => a.requested_by).filter((name): name is string => Boolean(name)))];
  return requesters.length === 1 && items.every((a) => a.requested_by?.trim()) ? `สรุปงานที่${requesters[0]}มอบหมาย` : "สรุปงานที่ได้รับมอบหมาย";
}

function groupActions(items: Minutes["action_items"]) {
  const groups: { owner: string | null; items: Minutes["action_items"] }[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (!last || last.owner !== item.owner || last.items[0].assigned_on !== item.assigned_on || last.items[0].requested_by !== item.requested_by) groups.push({ owner: item.owner, items: [item] });
    else last.items.push(item);
  }
  return groups;
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

export function SummaryPanel({
  job,
  onSeek,
  onRetried,
}: {
  job: JobDetail;
  onSeek: (t: number) => void;
  onRetried: () => void;
}) {
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
  const actionGroups = groupActions(m.action_items);

  return (
    <div className="sum" data-testid="summary">
      {job.summary_stale && (
        <div className="sum-stale" role="status" data-testid="summary-stale">
          <Icon name="info" />
          <p>ทรานสคริปต์ถูกแก้ไขหลังสรุปครั้งล่าสุด สรุปด้านล่างอาจยังใช้ข้อความหรือชื่อเดิม</p>
          <button className="btn btn-primary btn-sm" type="button" onClick={retry} disabled={busy} data-testid="btn-resummarize">
            <Icon name="refresh" />
            สรุปใหม่จากข้อความที่แก้
          </button>
        </div>
      )}
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
        <button className="btn btn-ghost btn-sm" type="button" onClick={retry} disabled={busy} title="ให้ AI สรุปใหม่จากทรานสคริปต์ล่าสุด (รวมข้อความและชื่อผู้พูดที่แก้ไว้)">
          <Icon name="refresh" />
          สรุปใหม่
        </button>
      </div>

      <h3 className="sum-title">{m.title}</h3>
      {m.overview && <p className="sum-overview">{m.overview}</p>}

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

      {m.segments.map((s, i) => (
        <section className="sum-sec sum-seg" key={i}>
          <h4>{heading(s)}</h4>
          {(s.kind === "report" || s.kind === "discussion") && <p className="sum-overview">โดย {s.speaker}</p>}
          <p className="sum-when">
            เวลา <Stamp at={s.start} onSeek={onSeek} />–<span className="mono">{s.end}</span>
            {s.responds_to ? ` · ต่อจากการรายงานเรื่อง${s.responds_to}` : ""}
          </p>
          {s.kind === "report" ? (
            <div className="sum-points" style={{ paddingLeft: 0 }}>
              {s.details.map((d, k) => <p key={k}>{d}</p>)}
            </div>
          ) : (
            <ul className="sum-points">
              {s.details.map((d, k) => <li key={k}>{d}</li>)}
            </ul>
          )}
          {s.report_sections?.map((section, sectionIndex) => (
            <div key={sectionIndex} className="sum-report-section">
              {section.heading && <h5>{section.heading}</h5>}
              {section.paragraphs.map((paragraph, k) => <p key={k}>{paragraph}</p>)}
              {section.items.length > 0 && (section.numbered ? (
                <ol className="sum-points">{section.items.map((item, k) => <li key={k}>{item}</li>)}</ol>
              ) : (
                <ul className="sum-points">{section.items.map((item, k) => <li key={k}>{item}</li>)}</ul>
              ))}
            </div>
          ))}
        </section>
      ))}

      <section className="sum-sec">
        <h4>{actionHeading(m.action_items)}</h4>
        {m.action_items.length ? (
          <div className="sum-actions">
            {actionGroups.map((group, i) => (
              <div key={`${group.owner ?? "unassigned"}-${i}`}>
                <p><strong>{group.owner ? `ฝาก${group.owner}` : "งานที่ต้องดำเนินการ"}{group.items[0].assigned_on ? ` เมื่อวันที่ ${group.items[0].assigned_on}` : ""}</strong></p>
                <ul className="sum-points">
                  {group.items.map((a, k) => (
                    <li key={k}>
                      <p>{a.task}</p>
                      <p className="sum-meta">
                        ผู้สั่งการ: {a.requested_by || "-"} · กำหนด: {a.due || "-"}
                        {a.timestamps.length > 0 && (
                          <>
                            {" · อ้างอิง "}
                            {a.timestamps.map((t, stampIndex) => (
                              <span key={stampIndex}>
                                {stampIndex > 0 && ", "}
                                <Stamp at={t} onSeek={onSeek} />
                              </span>
                            ))}
                          </>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
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
