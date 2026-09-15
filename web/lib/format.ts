// Formatting helpers ported from the prototype.

export const pad = (n: number) => String(n).padStart(2, "0");

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 83 → "01:23", 3723 → "1:02:03" */
export function tc(t: number) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function tcLong(t: number) {
  const ms = Math.round((t % 1) * 1000);
  t = Math.floor(t);
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}.${String(ms).padStart(3, "0")}`;
}

export function thDur(t: number) {
  t = Math.round(t);
  const m = Math.floor(t / 60), s = t % 60;
  return m ? `${m} นาที ${s} วินาที` : `${s} วินาที`;
}

export function fmtSize(bytes: number) {
  const mb = bytes / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

const TH_MON = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

export function thWhen(ts: string | number) {
  const d = new Date(ts), now = new Date(), diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 90) return "เมื่อสักครู่";
  if (diff < 3600) return `${Math.floor(diff / 60)} นาทีที่แล้ว`;
  const hmTxt = `${pad(d.getHours())}:${pad(d.getMinutes())} น.`;
  if (d.toDateString() === now.toDateString()) return `วันนี้ ${hmTxt}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `เมื่อวาน ${hmTxt}`;
  return `${d.getDate()} ${TH_MON[d.getMonth()]} ${d.getFullYear() + 543}`;
}

export const etaText = (sec: number) => {
  const s = Math.ceil(sec);
  return s >= 60 ? `เหลือประมาณ ${Math.ceil(s / 60)} นาที` : `เหลือประมาณ ${Math.max(1, s)} วินาที`;
};

/** Speaker color class index 1..6 */
export const ci = (i: number) => (i % 6) + 1;

export function initialOf(name: string) {
  const m = name.match(/^ผู้พูด\s*(\d+)/);
  if (m) return m[1];
  const n = name.replace(/^(ท่าน|คุณ|นางสาว|นาย|นาง|ดร\.)\s*/, "");
  const c = n.match(/[ก-ฮA-Za-z0-9]/);
  return c ? c[0].toUpperCase() : "?";
}

/** "ณัฐธิดา ศรีสุข" → "ณศ" */
export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = (s: string) => (s.match(/[ก-ฮA-Za-z0-9]/)?.[0] ?? "").toUpperCase();
  return (first(parts[0] ?? "") + first(parts[1] ?? "")) || "?";
}

/** "12:34" or "75:30" → seconds */
export function stampSeconds(stamp: string) {
  const m = stamp.match(/(\d{1,3}):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : -1;
}
