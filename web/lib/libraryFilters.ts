import type { Job } from "./api";

export type StatusFilter = "all" | "active" | "done" | "failed";
export type RangeFilter = "all" | "today" | "7d" | "30d" | "custom";
export type SortKey = "new" | "old" | "long" | "name";

/** Library search and filters. Kept in the URL so a filtered list can be shared and survives going back. */
export interface LibraryFilters {
  q: string;
  status: StatusFilter;
  range: RangeFilter;
  /** yyyy-mm-dd, used when range is "custom" */
  from: string;
  to: string;
  sort: SortKey;
}

export const DEFAULT_FILTERS: LibraryFilters = { q: "", status: "all", range: "all", from: "", to: "", sort: "new" };

const pick = <T extends string>(v: string | null, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseFilters(sp: URLSearchParams): LibraryFilters {
  const date = (k: string) => (DATE_RE.test(sp.get(k) ?? "") ? sp.get(k)! : "");
  return {
    q: (sp.get("q") ?? "").slice(0, 100),
    status: pick(sp.get("status"), ["all", "active", "done", "failed"], "all"),
    range: pick(sp.get("range"), ["all", "today", "7d", "30d", "custom"], "all"),
    from: date("from"),
    to: date("to"),
    sort: pick(sp.get("sort"), ["new", "old", "long", "name"], "new"),
  };
}

/** "/" or "/?q=…" with only the non-default values. */
export function libraryHref(f: LibraryFilters) {
  const sp = new URLSearchParams();
  if (f.q.trim()) sp.set("q", f.q.trim());
  if (f.status !== "all") sp.set("status", f.status);
  if (f.range !== "all") sp.set("range", f.range);
  if (f.range === "custom" && f.from) sp.set("from", f.from);
  if (f.range === "custom" && f.to) sp.set("to", f.to);
  if (f.sort !== "new") sp.set("sort", f.sort);
  const qs = sp.toString();
  return qs ? `/?${qs}` : "/";
}

export const hasActiveFilters = (f: LibraryFilters) => !!f.q.trim() || f.status !== "all" || f.range !== "all";

export function inDateRange(createdAt: string, f: LibraryFilters, now = new Date()) {
  const t = new Date(createdAt).getTime();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  switch (f.range) {
    case "today":
      return t >= startOfToday;
    case "7d":
      return t >= startOfToday - 6 * 86400_000;
    case "30d":
      return t >= startOfToday - 29 * 86400_000;
    case "custom": {
      // Local calendar days, both ends inclusive.
      const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : -Infinity;
      const to = f.to ? new Date(`${f.to}T00:00:00`).getTime() + 86400_000 : Infinity;
      return t >= from && t < to;
    }
    default:
      return true;
  }
}

export const STATUS_TEST: Record<StatusFilter, (j: Job) => boolean> = {
  all: () => true,
  active: (j) => j.status === "uploading" || j.status === "processing",
  done: (j) => j.status === "done",
  failed: (j) => j.status === "failed",
};

export function sortJobs(jobs: Job[], sort: SortKey) {
  const xs = [...jobs];
  if (sort === "old") xs.sort((a, b) => a.created_at.localeCompare(b.created_at));
  else if (sort === "long") xs.sort((a, b) => (b.duration_sec ?? 0) - (a.duration_sec ?? 0));
  else if (sort === "name") xs.sort((a, b) => a.name.localeCompare(b.name, "th"));
  else xs.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return xs;
}

/** A short window of `text` around the first occurrence of `q` (case-insensitive), with ellipses where cut. */
export function snippet(text: string, q: string, radius = 42) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + q.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** Splits text around case-insensitive matches of q, for wrapping matches in <mark>. */
export function splitMatches(text: string, q: string): { t: string; hit: boolean }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [{ t: text, hit: false }];
  const out: { t: string; hit: boolean }[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, at)) {
    if (i > at) out.push({ t: text.slice(at, i), hit: false });
    out.push({ t: text.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < text.length) out.push({ t: text.slice(at), hit: false });
  return out;
}
