"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toasts";
import { api, ApiError, type Job } from "./api";

export interface UploadState {
  loaded: number;
  total: number;
  startedAt: number;
  xhr: XMLHttpRequest;
  /** Local preview frame (data URL) and duration read from the file before the server has them. */
  frame?: string;
  duration?: number;
}

interface JobsCtx {
  jobs: Job[];
  uploads: Record<string, UploadState>;
  loaded: boolean;
  /** Where "back to all jobs" goes: the library with the search and filters last used. */
  libraryHref: string;
  setLibraryHref: (href: string) => void;
  refresh: () => Promise<void>;
  addUpload: (file: File) => Promise<void>;
  /** Creates a job from a video link; the server downloads it. Resolves to whether the job was created. */
  addLink: (url: string) => Promise<boolean>;
  cancelUpload: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  retranscribe: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  patchJob: (job: Partial<Job> & { id: string }) => void;
  setViewing: (id: string | null) => void;
  bellRing: number;
  celebrateId: string | null;
}

const Ctx = createContext<JobsCtx | null>(null);

export function useJobs() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useJobs outside JobsProvider");
  return c;
}

export const MEDIA_EXT = /\.(mp4|m4v|mov|mkv|webm|avi|mp3|m4a|wav|aac|ogg|flac)$/i;

export const isActive = (j: Job) =>
  j.status === "uploading" || j.status === "processing" || (j.status === "done" && (j.summary_status === "pending" || j.summary_status === "running"));

export function JobsProvider({ children }: { children: React.ReactNode }) {
  const toast = useToast();
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [loaded, setLoaded] = useState(false);
  const [libraryHref, setLibraryHref] = useState("/");
  const [bellRing, setBellRing] = useState(0);
  const [celebrateId, setCelebrateId] = useState<string | null>(null);
  const prev = useRef(new Map<string, Job>());
  const viewing = useRef<string | null>(null);
  const uploadsRef = useRef(uploads);
  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  const setViewing = useCallback((id: string | null) => {
    viewing.current = id;
  }, []);

  const notify = useCallback(
    (next: Job[]) => {
      const before = prev.current;
      for (const j of next) {
        const p = before.get(j.id);
        if (!p) continue;
        const isViewing = viewing.current === j.id;
        if (p.status !== "done" && j.status === "done") {
          setBellRing((n) => n + 1);
          setCelebrateId(j.id);
          if (isViewing) toast(`ถอดเสียงเสร็จแล้ว พบผู้พูด ${j.speakers.length} คน ทรานสคริปต์แสดงอยู่ด้านขวา`);
          else toast(`ถอดเสียง “${j.name}” เสร็จแล้ว · พบผู้พูด ${j.speakers.length} คน`, { action: { label: "เปิดดู", run: () => router.push(`/jobs/${j.id}`) } });
        } else if (p.downloading && !j.downloading && j.status === "processing") {
          toast(`ดาวน์โหลด “${j.name}” จากลิงก์เสร็จแล้ว ระบบกำลังถอดเสียงอยู่เบื้องหลัง`, {
            icon: "check",
            action: isViewing ? undefined : { label: "เล่นวิดีโอ", run: () => router.push(`/jobs/${j.id}`) },
          });
        } else if (p.status !== "failed" && j.status === "failed" && p.status !== "uploading") {
          toast(`ถอดเสียง “${j.name}” ไม่สำเร็จ: ${j.error ?? ""}`, { kind: "err" });
        } else if (p.status === "done" && j.status === "done" && (p.summary_status === "pending" || p.summary_status === "running")) {
          if (j.summary_status === "done") toast(`สรุปการประชุม “${j.name}” ใหม่เสร็จแล้ว`, { icon: "sparkles" });
          if (j.summary_status === "failed") toast(`สรุปการประชุม “${j.name}” ไม่สำเร็จ`, { kind: "err" });
        }
      }
      prev.current = new Map(next.map((j) => [j.id, j]));
    },
    [router, toast],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ jobs: Job[] }>("/api/jobs");
      notify(r.jobs);
      setJobs(r.jobs);
      setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) router.replace("/login");
    }
  }, [notify, router]);

  // Poll quickly while anything is in flight, slowly otherwise.
  const anyActive = jobs.some(isActive) || Object.keys(uploads).length > 0;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch; state is set after the request resolves
    refresh();
    const h = window.setInterval(refresh, anyActive ? 2000 : 15000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(h);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, anyActive]);

  const patchJob = useCallback((p: Partial<Job> & { id: string }) => {
    setJobs((xs) => xs.map((j) => (j.id === p.id ? { ...j, ...p } : j)));
    const old = prev.current.get(p.id);
    if (old) prev.current.set(p.id, { ...old, ...p });
  }, []);

  const addUpload = useCallback(
    async (file: File) => {
      if (!(file.type.startsWith("video/") || file.type.startsWith("audio/") || MEDIA_EXT.test(file.name)) || !MEDIA_EXT.test(file.name)) {
        toast(`“${file.name}” ไม่ใช่ไฟล์วิดีโอ เลือกไฟล์ MP4, MOV, MKV หรือ WEBM`, { kind: "err" });
        return;
      }
      if (file.size > 2 * 1024 ** 3) {
        toast(`“${file.name}” ใหญ่เกิน 2 GB ลองตัดวิดีโอเป็นช่วงสั้นลงแล้วอัปโหลดใหม่`, { kind: "err" });
        return;
      }
      let job: Job;
      try {
        job = await api<Job>("/api/jobs", {
          method: "POST",
          body: { name: file.name, size_bytes: file.size },
        });
      } catch (e) {
        toast((e as Error).message, { kind: "err" });
        return;
      }
      const xhr = new XMLHttpRequest();
      const state: UploadState = { loaded: 0, total: file.size, startedAt: performance.now(), xhr };
      setUploads((u) => ({ ...u, [job.id]: state }));
      prev.current.set(job.id, job);
      setJobs((xs) => [job, ...xs.filter((x) => x.id !== job.id)]);

      readPreview(file).then((p) => {
        if (!p) return;
        setUploads((u) => (u[job.id] ? { ...u, [job.id]: { ...u[job.id], ...p } } : u));
      });

      let lastPaint = 0;
      xhr.upload.onprogress = (e) => {
        const now = performance.now();
        if (now - lastPaint < 150 && e.loaded < e.total) return;
        lastPaint = now;
        setUploads((u) => (u[job.id] ? { ...u, [job.id]: { ...u[job.id], loaded: e.loaded } } : u));
      };
      const finish = () =>
        setUploads((u) => {
          const rest = { ...u };
          delete rest[job.id];
          return rest;
        });
      xhr.onload = () => {
        finish();
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const updated = JSON.parse(xhr.responseText) as Job;
            prev.current.set(updated.id, updated);
            setJobs((xs) => xs.map((x) => (x.id === updated.id ? updated : x)));
          } catch {}
          const isViewing = viewing.current === job.id;
          toast(`อัปโหลด “${job.name}” เสร็จแล้ว ระบบกำลังถอดเสียงอยู่เบื้องหลัง`, {
            icon: "check",
            action: isViewing ? undefined : { label: "เล่นวิดีโอ", run: () => router.push(`/jobs/${job.id}`) },
          });
        } else if (xhr.status !== 404) {
          let msg = "อัปโหลดไม่สำเร็จ ลองอัปโหลดไฟล์ใหม่อีกครั้ง";
          try {
            msg = JSON.parse(xhr.responseText).error ?? msg;
          } catch {}
          toast(`“${job.name}”: ${msg}`, { kind: "err" });
        }
        refresh();
      };
      xhr.onerror = () => {
        finish();
        toast(`อัปโหลด “${job.name}” ไม่สำเร็จ ตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง`, { kind: "err" });
        refresh();
      };
      xhr.onabort = finish;
      xhr.open("PUT", `/api/jobs/${job.id}/file`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.send(file);
    },
    [refresh, router, toast],
  );

  const addLink = useCallback(
    async (url: string) => {
      try {
        const job = await api<Job>("/api/jobs/import", { method: "POST", body: { url } });
        prev.current.set(job.id, job);
        setJobs((xs) => [job, ...xs.filter((x) => x.id !== job.id)]);
        toast("กำลังดาวน์โหลดวิดีโอจากลิงก์ ปิดหน้านี้ได้ ระบบทำต่อเบื้องหลัง", { icon: "link" });
        return true;
      } catch (e) {
        toast((e as Error).message, { kind: "err" });
        return false;
      }
    },
    [toast],
  );

  const remove = useCallback(
    async (id: string) => {
      setJobs((xs) => xs.filter((j) => j.id !== id));
      prev.current.delete(id);
      try {
        await api(`/api/jobs/${id}`, { method: "DELETE" });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) toast((e as Error).message, { kind: "err" });
      }
      refresh();
    },
    [refresh, toast],
  );

  const cancelUpload = useCallback(
    async (id: string) => {
      const job = prev.current.get(id);
      uploadsRef.current[id]?.xhr.abort();
      await remove(id);
      toast(`ยกเลิกการ${job?.downloading ? "ดาวน์โหลด" : "อัปโหลด"} “${job?.name ?? ""}” แล้ว`, { icon: "x" });
    },
    [remove, toast],
  );

  const retry = useCallback(
    async (id: string) => {
      try {
        const j = await api<Job>(`/api/jobs/${id}/retry`, { method: "POST" });
        prev.current.set(id, j);
        setJobs((xs) => xs.map((x) => (x.id === id ? j : x)));
        toast(`เริ่มถอดเสียง “${j.name}” ใหม่แล้ว`, { icon: "refresh" });
      } catch (e) {
        toast((e as Error).message, { kind: "err" });
      }
    },
    [toast],
  );

  const retranscribe = useCallback(
    async (id: string) => {
      const job = prev.current.get(id);
      if (!job) return;
      const confirmed = window.confirm(`ถอดเสียง “${job.name}” ใหม่?\n\nทรานสคริปต์ สรุป และข้อความที่เคยแก้จะถูกแทนที่ด้วยผลใหม่`);
      if (!confirmed) return;
      try {
        const updated = await api<Job>(`/api/jobs/${id}/retranscribe`, { method: "POST" });
        prev.current.set(id, updated);
        setJobs((xs) => xs.map((x) => (x.id === id ? updated : x)));
        toast(`เริ่มถอดเสียง “${updated.name}” ใหม่แล้ว`, { icon: "refresh" });
      } catch (e) {
        toast((e as Error).message, { kind: "err" });
      }
    },
    [toast],
  );

  const value = useMemo(
    () => ({ jobs, uploads, loaded, libraryHref, setLibraryHref, refresh, addUpload, addLink, cancelUpload, retry, retranscribe, remove, patchJob, setViewing, bellRing, celebrateId }),
    [jobs, uploads, loaded, libraryHref, refresh, addUpload, addLink, cancelUpload, retry, retranscribe, remove, patchJob, setViewing, bellRing, celebrateId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Grabs a thumbnail frame and the duration from a local video file, like the prototype did. */
function readPreview(file: File): Promise<{ frame?: string; duration?: number } | null> {
  if (!file.type.startsWith("video/") && !/\.(mp4|m4v|mov|webm)$/i.test(file.name)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    let duration: number | undefined;
    const done = (r: { frame?: string; duration?: number } | null) => {
      clearTimeout(timer);
      v.removeAttribute("src");
      v.load();
      URL.revokeObjectURL(url);
      resolve(r);
    };
    const timer = setTimeout(() => done(duration ? { duration } : null), 8000);
    v.onloadedmetadata = () => {
      if (isFinite(v.duration) && v.duration > 0) {
        duration = v.duration;
        try {
          v.currentTime = Math.min(1.5, v.duration / 3);
        } catch {
          done({ duration });
        }
      } else done(null);
    };
    v.onseeked = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 272;
        c.height = 153;
        const x = c.getContext("2d")!;
        const r = Math.max(272 / v.videoWidth, 153 / v.videoHeight);
        const w = v.videoWidth * r, h = v.videoHeight * r;
        x.drawImage(v, (272 - w) / 2, (153 - h) / 2, w, h);
        done({ duration, frame: c.toDataURL("image/jpeg", 0.8) });
      } catch {
        done({ duration });
      }
    };
    v.onerror = () => done(null);
    v.src = url;
  });
}
