import type { JobDetail } from "./api";
import { tc, tcLong } from "./format";

export type ExportFormat = "txt" | "csv" | "md";
export interface ExportOptions {
  time: boolean;
  spk: boolean;
  merge: boolean;
}

/** Same output as buildExport() in the prototype. */
export function buildExport(j: JobDetail, fmt: ExportFormat, o: ExportOptions) {
  let rows = j.segments.map((s) => ({ ...s }));
  if (o.merge) {
    rows = rows.reduce<typeof rows>((a, r) => {
      const p = a[a.length - 1];
      if (p && p.speaker === r.speaker && r.start - p.end < 2.5) {
        p.end = r.end;
        p.text += " " + r.text;
      } else a.push(r);
      return a;
    }, []);
  }
  const nm = (i: number) => j.speakers[i]?.name ?? `ผู้พูด ${i + 1}`;
  const title = j.name.replace(/\.[^.]+$/, "");
  const meta = `ความยาว ${tc(j.duration_sec ?? 0)} · ผู้พูด ${j.speakers.length} คน · ถอดเสียงโดย Transcripto`;
  if (fmt === "csv") {
    const q = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
    const head = [...(o.time ? ["เริ่ม", "สิ้นสุด"] : []), ...(o.spk ? ["ผู้พูด"] : []), "ข้อความ"];
    const lines = rows.map((r) => [...(o.time ? [tcLong(r.start), tcLong(r.end)] : []), ...(o.spk ? [q(nm(r.speaker))] : []), q(r.text)].join(","));
    return [head.join(","), ...lines].join("\r\n") + "\r\n";
  }
  if (fmt === "md") {
    return (
      `# ${title}\n\n> ${meta}\n\n` +
      rows
        .map((r) => {
          const lead = [o.spk ? `**${nm(r.speaker)}**` : "", o.time ? `\`${tc(r.start)}\`` : ""].filter(Boolean).join(" ");
          return (lead ? lead + "  \n" : "") + r.text;
        })
        .join("\n\n") +
      "\n"
    );
  }
  return `${title}\n${meta}\n\n` + rows.map((r) => `${o.time ? `[${tc(r.start)}] ` : ""}${o.spk ? `${nm(r.speaker)}: ` : ""}${r.text}`).join("\n\n") + "\n";
}

export function safeBase(name: string) {
  return name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "-").trim() || "transcript";
}

/** Meeting minutes as plain text, exactly as the API rendered them (same layout as bench/summarize.py). */
export function saveSummary(j: JobDetail) {
  saveFile(`${safeBase(j.name)} - สรุปการประชุม.txt`, j.summary_text ?? "", "text/plain;charset=utf-8");
}

export function saveFile(filename: string, data: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
