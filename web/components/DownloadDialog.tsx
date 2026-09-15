"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { JobDetail } from "@/lib/api";
import { buildExport, type ExportFormat, safeBase, saveFile } from "@/lib/exports";
import { Icon } from "./Icon";
import { useToast } from "./Toasts";

export function DownloadDialog({ job, opener, onClose }: { job: JobDetail | null; opener: HTMLElement | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const toast = useToast();
  const [fmt, setFmt] = useState<ExportFormat>("txt");
  const [time, setTime] = useState(true);
  const [spk, setSpk] = useState(true);
  const [merge, setMerge] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (job && !d.open) {
      setNote("");
      d.showModal();
    }
    if (!job && d.open) d.close();
  }, [job]);

  const ex = useMemo(() => {
    if (!job) return null;
    const body = buildExport(job, fmt, { time, spk, merge });
    return { name: `${safeBase(job.name)}.${fmt}`, body, data: fmt === "csv" ? "\uFEFF" + body : body };
  }, [job, fmt, time, spk, merge]);

  const bytes = ex ? new Blob([ex.data]).size : 0;

  const download = async () => {
    if (!ex) return;
    try {
      saveFile(ex.name, ex.data, fmt === "csv" ? "text/csv;charset=utf-8" : fmt === "md" ? "text/markdown;charset=utf-8" : "text/plain;charset=utf-8");
      ref.current?.close();
      toast(`ดาวน์โหลด ${ex.name} แล้ว`, { icon: "download" });
    } catch {
      try {
        await navigator.clipboard.writeText(ex.body);
        ref.current?.close();
        toast("คัดลอกทรานสคริปต์ไปที่คลิปบอร์ดแล้ว วางในเอกสารได้เลย", { icon: "copy" });
      } catch {
        setNote("หน้านี้ดาวน์โหลดหรือคัดลอกอัตโนมัติไม่ได้ เลือกข้อความในช่องตัวอย่างแล้วกด ⌘C หรือ Ctrl+C");
      }
    }
  };

  return (
    <dialog
      className="dlg"
      ref={ref}
      aria-labelledby="dlg-h"
      onClose={() => {
        onClose();
        if (opener?.isConnected) opener.focus();
      }}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <form className="dlg-in" method="dialog" onSubmit={(e) => e.preventDefault()}>
        <div className="dlg-head">
          <div>
            <h2 id="dlg-h">ดาวน์โหลดทรานสคริปต์</h2>
            <p className="dlg-sub">{job ? `${job.name} · ${job.segments.length} ช่วง · ผู้พูด ${job.speakers.length} คน` : ""}</p>
          </div>
          <button className="icon-btn" type="button" aria-label="ปิดหน้าต่าง" onClick={() => ref.current?.close()}>
            <Icon name="x" />
          </button>
        </div>
        <div className="dlg-body">
          <fieldset className="fs">
            <legend>รูปแบบไฟล์</legend>
            <div className="fmt">
              {(
                [
                  ["txt", "ข้อความ", "อ่านง่าย มีเวลาและชื่อผู้พูดทุกช่วง"],
                  ["csv", "ตาราง", "เปิดใน Excel หรือ Google Sheets"],
                  ["md", "Markdown", "วางต่อใน Notion หรือเอกสารสรุป"],
                ] as const
              ).map(([v, b, d]) => (
                <label key={v}>
                  <input type="radio" name="fmt" value={v} checked={fmt === v} onChange={() => setFmt(v)} />
                  <span className="ext">.{v}</span>
                  <b>{b}</b>
                  <span className="d">{d}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="fs">
            <legend>ตัวเลือก</legend>
            <div className="opts">
              <label className="check">
                <input type="checkbox" checked={time} onChange={(e) => setTime(e.target.checked)} /> ใส่เวลา
              </label>
              <label className="check">
                <input type="checkbox" checked={spk} onChange={(e) => setSpk(e.target.checked)} /> ใส่ชื่อผู้พูด
              </label>
              <label className="check">
                <input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} /> รวมประโยคต่อเนื่องของคนเดียวกัน
              </label>
            </div>
          </fieldset>
          <div className="field">
            <div className="label-row">
              <label className="label" htmlFor="dlg-prev">
                ตัวอย่างเนื้อหาในไฟล์
              </label>
              <span className="sec-note mono">{bytes > 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`}</span>
            </div>
            <textarea className="preview" id="dlg-prev" readOnly spellCheck={false} value={ex?.body ?? ""} />
          </div>
          {note && (
            <p className="dlg-note" role="status">
              {note}
            </p>
          )}
        </div>
        <div className="dlg-foot">
          <button className="btn btn-secondary" type="button" onClick={() => ref.current?.close()}>
            ยกเลิก
          </button>
          <button className="btn btn-primary" type="button" onClick={download} data-testid="dlg-go">
            <Icon name="download" />
            <span>ดาวน์โหลด .{fmt}</span>
          </button>
        </div>
      </form>
    </dialog>
  );
}
