"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DownloadDialog } from "@/components/DownloadDialog";
import { Icon } from "@/components/Icon";
import { JobRow } from "@/components/JobRow";
import { useToast } from "@/components/Toasts";
import { api, type JobDetail, type KeytermSettings, type TranscriptMatch } from "@/lib/api";
import { useJobs } from "@/lib/jobs";
import {
  DEFAULT_FILTERS,
  hasActiveFilters,
  inDateRange,
  libraryHref,
  parseFilters,
  sortJobs,
  STATUS_TEST,
  type LibraryFilters,
  type RangeFilter,
  type SortKey,
  type StatusFilter,
} from "@/lib/libraryFilters";

const STATUSES: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "ทั้งหมด" },
  { id: "active", label: "กำลังประมวลผล" },
  { id: "done", label: "เสร็จแล้ว" },
  { id: "failed", label: "ไม่สำเร็จ" },
];

const RANGES: { id: RangeFilter; label: string }[] = [
  { id: "all", label: "ทุกช่วงเวลา" },
  { id: "today", label: "วันนี้" },
  { id: "7d", label: "7 วันล่าสุด" },
  { id: "30d", label: "30 วันล่าสุด" },
  { id: "custom", label: "กำหนดช่วงวันที่…" },
];

const SORTS: { id: SortKey; label: string }[] = [
  { id: "new", label: "ใหม่สุดก่อน" },
  { id: "old", label: "เก่าสุดก่อน" },
  { id: "long", label: "ความยาวมากสุด" },
  { id: "name", label: "ชื่อไฟล์ ก–ฮ" },
];

const thDate = (ymd: string) => new Date(`${ymd}T00:00:00`).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "2-digit" });

export default function Page() {
  return (
    <Suspense>
      <LibraryPage />
    </Suspense>
  );
}

function LibraryPage() {
  const router = useRouter();
  const params = useSearchParams();
  const filters = useMemo(() => parseFilters(new URLSearchParams(params.toString())), [params]);
  const { jobs, uploads, loaded, setLibraryHref, addUpload, cancelUpload, retry, remove, celebrateId } = useJobs();
  const toast = useToast();
  const [over, setOver] = useState(false);
  const [got, setGot] = useState(0);
  // Shown under the upload area so it's clear which terms new uploads are transcribed with.
  const [keyterms, setKeyterms] = useState<KeytermSettings | null>(null);
  useEffect(() => {
    api<KeytermSettings>("/api/settings/keyterms").then(setKeyterms, () => {});
  }, []);
  const [dl, setDl] = useState<{ job: JobDetail; opener: HTMLElement } | null>(null);
  const [qDraft, setQDraft] = useState(filters.q);
  const [matches, setMatches] = useState<{ q: string; byId: Map<string, TranscriptMatch> } | null>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  // Rows created after this page opened slide in.
  const [openedAt] = useState(() => Date.now());
  const chipsRef = useRef<HTMLDivElement>(null);
  const indRef = useRef<HTMLSpanElement>(null);
  const chipPos = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const setFilters = useCallback(
    (patch: Partial<LibraryFilters>) => router.replace(libraryHref({ ...filters, ...patch }), { scroll: false }),
    [filters, router],
  );
  const clearFilters = useCallback(() => {
    setQDraft("");
    router.replace(libraryHref({ ...DEFAULT_FILTERS, sort: filters.sort }), { scroll: false });
  }, [filters.sort, router]);

  // "งานถอดเสียงทั้งหมด" on a job page comes back to this exact view.
  useEffect(() => setLibraryHref(libraryHref(filters)), [filters, setLibraryHref]);

  // Typing updates the URL (and the search) after a short pause.
  useEffect(() => {
    if (qDraft.trim() === filters.q.trim()) return;
    const h = setTimeout(() => setFilters({ q: qDraft }), 250);
    return () => clearTimeout(h);
  }, [qDraft, filters.q, setFilters]);

  // Transcript search runs on the server; re-run when a transcript finishes so new jobs can match.
  const q = filters.q.trim();
  const transcribed = jobs.filter((j) => j.segment_count > 0).length;
  useEffect(() => {
    if (!q) return;
    const ctl = new AbortController();
    api<{ matches: TranscriptMatch[] }>(`/api/jobs/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal })
      .then((r) => setMatches({ q, byId: new Map(r.matches.map((m) => [m.id, m])) }))
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setMatches({ q, byId: new Map() });
        toast("ค้นหาในทรานสคริปต์ไม่สำเร็จ แสดงเฉพาะงานที่ชื่อตรงกัน", { kind: "err" });
      });
    return () => ctl.abort();
  }, [q, transcribed, toast]);
  const byId = matches?.q === q ? matches.byId : undefined;
  const searchingTranscripts = !!q && !byId;

  // Search and date narrow the list first; status chips count within that, then sort.
  const narrowed = useMemo(() => {
    const needle = q.toLowerCase();
    return jobs.filter((j) => inDateRange(j.created_at, filters) && (!needle || j.name.toLowerCase().includes(needle) || !!byId?.has(j.id)));
  }, [jobs, filters, q, byId]);
  const list = useMemo(() => sortJobs(narrowed.filter(STATUS_TEST[filters.status]), filters.sort), [narrowed, filters.status, filters.sort]);
  const filtered = hasActiveFilters(filters);

  useLayoutEffect(() => {
    const box = chipsRef.current, ind = indRef.current;
    const on = box?.querySelector<HTMLElement>('.chip[aria-pressed="true"]');
    if (!box || !ind || !on || !on.offsetWidth) return;
    const next = { x: on.offsetLeft, y: on.offsetTop, w: on.offsetWidth, h: on.offsetHeight };
    const put = (p: typeof next) => {
      ind.style.transform = `translate(${p.x}px,${p.y}px)`;
      ind.style.width = `${p.w}px`;
      ind.style.height = `${p.h}px`;
    };
    if (chipPos.current) {
      ind.style.transition = "none";
      put(chipPos.current);
      void ind.offsetWidth;
      ind.style.transition = "";
    }
    put(next);
    chipPos.current = next;
  });

  const onFiles = useCallback(
    (files: FileList | File[] | null | undefined) => {
      const arr = Array.from(files ?? []);
      if (!arr.length) return;
      // New uploads must be visible: drop any filter that could hide them.
      if (hasActiveFilters(filters)) clearFilters();
      arr.forEach((f) => addUpload(f));
      setGot((n) => n + 1);
    },
    [addUpload, clearFilters, filters],
  );

  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    // "/" jumps to search, like most list views.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement).closest?.('input, textarea, select, [contenteditable="true"]') || document.querySelector("dialog[open]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const openDownload = useCallback(
    async (id: string, opener: HTMLElement) => {
      try {
        const job = await api<JobDetail>(`/api/jobs/${id}`);
        setDl({ job, opener });
      } catch (e) {
        toast((e as Error).message, { kind: "err" });
      }
    },
    [toast],
  );

  const rangeText =
    filters.range === "custom"
      ? filters.from || filters.to
        ? ` · ${filters.from ? thDate(filters.from) : "…"} – ${filters.to ? thDate(filters.to) : "วันนี้"}`
        : ""
      : filters.range !== "all"
        ? ` · ${RANGES.find((r) => r.id === filters.range)!.label}`
        : "";

  return (
    <section className="wrap view-enter" id="view-library">
      <div className="lib-head">
        <div>
          <h1 tabIndex={-1}>ถอดเสียงวิดีโอ</h1>
          <p>อัปโหลดไฟล์แล้วระบบจะถอดเสียงเป็นข้อความ แยกผู้พูด และสรุปการประชุมอยู่เบื้องหลัง ระหว่างรอ คุณเปิดดูวิดีโอหรือทำงานอื่นต่อได้เลย</p>
        </div>
      </div>

      {/* The whole area opens the file picker; the button inside is the visible, keyboard-reachable way in. */}
      <div
        key={got}
        className={`drop${over ? " is-over" : ""}${got ? " got" : ""}`}
        data-testid="drop"
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) fileIn.current?.click();
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          depth.current++;
          setOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (!depth.current) setOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          depth.current = 0;
          setOver(false);
          onFiles(e.dataTransfer.files);
        }}
      >
        <div className="drop-ic" aria-hidden="true">
          <Icon name="upload" />
        </div>
        <div className="drop-main">
          <div>
            <p className="drop-title">ลากไฟล์วิดีโอมาวางที่นี่ หรือคลิกเพื่อเลือกไฟล์</p>
            <p className="drop-sub">MP4, MOV, MKV หรือ WEBM · ขนาดไม่เกิน 2 GB · ความยาวไม่เกิน 3 ชั่วโมง · ระบบแยกผู้พูดให้เอง</p>
          </div>
        </div>
        <div className="drop-actions">
          <button className="btn btn-primary" type="button" onClick={() => fileIn.current?.click()}>
            <Icon name="upload" />
            เลือกไฟล์วิดีโอ
          </button>
        </div>
      </div>
      {keyterms && (
        <p className="kt-lib" data-testid="kt-lib">
          <Icon name="tag" />
          <span>
            {keyterms.terms.length ? `ใช้คำเฉพาะ ${keyterms.terms.length.toLocaleString()} คำช่วยถอดเสียง` : "ยังไม่มีคำเฉพาะช่วยถอดเสียง"}
          </span>
          <Link className="link" href="/settings">
            {keyterms.terms.length ? "ดูหรือแก้ไข" : "เพิ่มคำ"}
          </Link>
        </p>
      )}
      <input
        ref={fileIn}
        className="sr-only"
        type="file"
        id="file-in"
        accept="video/*,audio/*,.mkv,.mov"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          onFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="jobs-head">
        <h2 id="jobs-h">งานของฉัน</h2>
      </div>

      <div className="lib-tools" role="search" aria-label="ค้นหาและกรองงาน">
        <label className="search lib-search">
          <Icon name={searchingTranscripts ? "loader" : "search"} className={searchingTranscripts ? "spin" : undefined} />
          <span className="sr-only">ค้นหาจากชื่อไฟล์หรือคำที่พูดในวิดีโอ</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="ค้นหาชื่อไฟล์ หรือคำที่พูดในวิดีโอ"
            autoComplete="off"
            enterKeyHint="search"
            value={qDraft}
            data-testid="lib-search"
            onChange={(e) => setQDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setFilters({ q: qDraft });
              if (e.key === "Escape" && qDraft) {
                e.preventDefault();
                setQDraft("");
                setFilters({ q: "" });
              }
            }}
          />
          {qDraft ? (
            <button
              className="lib-search-clear"
              type="button"
              aria-label="ล้างคำค้นหา"
              onClick={() => {
                setQDraft("");
                setFilters({ q: "" });
                searchRef.current?.focus();
              }}
            >
              <Icon name="x" />
            </button>
          ) : (
            <span className="kbd" aria-hidden="true" title="กด / เพื่อค้นหา">
              /
            </span>
          )}
        </label>

        <div className="lib-selects">
          <label className={`lib-sel${filters.range !== "all" ? " on" : ""}`} title="ช่วงวันที่อัปโหลด">
            <Icon name="calendar" />
            <span className="sr-only">ช่วงวันที่อัปโหลด</span>
            <select value={filters.range} data-testid="lib-range" onChange={(e) => setFilters({ range: e.target.value as RangeFilter })}>
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" className="lib-sel-arrow" />
          </label>
          <label className={`lib-sel${filters.sort !== "new" ? " on" : ""}`} title="เรียงลำดับ">
            <Icon name="sort" />
            <span className="sr-only">เรียงลำดับ</span>
            <select value={filters.sort} data-testid="lib-sort" onChange={(e) => setFilters({ sort: e.target.value as SortKey })}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <Icon name="chevron-down" className="lib-sel-arrow" />
          </label>
        </div>

        {filters.range === "custom" && (
          <div className="lib-dates" data-testid="lib-dates">
            <label>
              <span>ตั้งแต่</span>
              <input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => setFilters({ from: e.target.value })} data-testid="lib-from" />
            </label>
            <label>
              <span>ถึง</span>
              <input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => setFilters({ to: e.target.value })} data-testid="lib-to" />
            </label>
          </div>
        )}

        <div className="chips" role="group" aria-label="กรองตามสถานะ" ref={chipsRef}>
          <span className="chip-ind" aria-hidden="true" ref={indRef} />
          {STATUSES.map((s) => (
            <button key={s.id} className="chip" type="button" aria-pressed={filters.status === s.id} onClick={() => setFilters({ status: s.id })}>
              {s.label}
              <span className="n">{narrowed.filter(STATUS_TEST[s.id]).length}</span>
            </button>
          ))}
        </div>
      </div>

      {loaded && filtered && (
        <p className="lib-result" aria-live="polite" data-testid="lib-result">
          <span>
            พบ <b>{list.length}</b> งาน
            {q ? ` ที่ชื่อหรือทรานสคริปต์มีคำว่า “${q}”` : ""}
            {rangeText}
            {searchingTranscripts ? " · กำลังค้นหาในทรานสคริปต์…" : ""}
          </span>
          <button className="link" type="button" onClick={clearFilters}>
            ล้างตัวกรองทั้งหมด
          </button>
        </p>
      )}

      <ul className="jobs" aria-labelledby="jobs-h" data-testid="jobs">
        {!loaded ? (
          <li className="empty">กำลังโหลดรายการงาน…</li>
        ) : list.length ? (
          list.map((j, k) => (
            <JobRow
              key={j.id}
              j={j}
              up={uploads[j.id]}
              index={k}
              isNew={new Date(j.created_at).getTime() >= openedAt - 1000}
              justDone={celebrateId === j.id}
              q={q}
              match={byId?.get(j.id)}
              onCancel={cancelUpload}
              onRetry={retry}
              onRemove={remove}
              onDownload={openDownload}
            />
          ))
        ) : q || filters.range !== "all" ? (
          <li className="empty lib-empty" data-testid="lib-empty">
            <Icon name="search" />
            <b>{searchingTranscripts ? "กำลังค้นหาในทรานสคริปต์…" : q ? `ไม่พบงานที่มีคำว่า “${q}”` : "ไม่มีงานในช่วงเวลานี้"}</b>
            {!searchingTranscripts && <span>ลองใช้คำที่สั้นลง ตรวจตัวสะกด หรือขยายช่วงเวลา</span>}
            <button className="btn btn-secondary btn-sm" type="button" onClick={clearFilters}>
              ล้างตัวกรอง
            </button>
          </li>
        ) : (
          <li className="empty">
            {filters.status === "active"
              ? "ไม่มีงานที่กำลังประมวลผล อัปโหลดวิดีโอด้านบนเพื่อเริ่มงานใหม่"
              : jobs.length
                ? "ยังไม่มีงานในหมวดนี้"
                : "ยังไม่มีงานถอดเสียง ลากไฟล์วิดีโอมาวางด้านบนเพื่อเริ่มต้น"}
          </li>
        )}
      </ul>
      <DownloadDialog job={dl?.job ?? null} opener={dl?.opener ?? null} onClose={() => setDl(null)} />
    </section>
  );
}
