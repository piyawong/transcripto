"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";
import { api, type KeytermSettings } from "@/lib/api";
import { useSession } from "@/lib/session";

/** Same cleaning as the API (api/src/settings.rs): trimmed, single spaces, compared ignoring letter case. */
const clean = (t: string) => t.split(/\s+/).filter(Boolean).join(" ");
const key = (t: string) => clean(t).toLowerCase();
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

// An unsaved list survives leaving the page inside the app (per user, until the tab is closed).
const draftKey = (userId: string) => `transcripto:keyterms-draft:${userId}`;
function readDraft(userId: string): string[] | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(draftKey(userId)) ?? "null");
    return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : null;
  } catch {
    return null;
  }
}
function writeDraft(userId: string, terms: string[] | null) {
  try {
    if (terms) sessionStorage.setItem(draftKey(userId), JSON.stringify(terms));
    else sessionStorage.removeItem(draftKey(userId));
  } catch {}
}

export default function SettingsPage() {
  const { user } = useSession();
  const toast = useToast();
  const [data, setData] = useState<KeytermSettings | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[]>([]);
  const [restored, setRestored] = useState(false);
  const [entry, setEntry] = useState("");
  const [entryErr, setEntryErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const apply = useCallback(
    (d: KeytermSettings) => {
      setData(d);
      const kept = readDraft(user.id);
      if (kept && !sameList(kept, d.terms)) {
        setDraft(kept);
        setRestored(true);
      } else {
        setDraft(d.terms);
        writeDraft(user.id, null);
      }
    },
    [user.id],
  );

  useEffect(() => {
    let gone = false;
    api<KeytermSettings>("/api/settings/keyterms").then(
      (d) => !gone && apply(d),
      (e: Error) => !gone && setLoadErr(e.message),
    );
    return () => {
      gone = true;
    };
  }, [apply]);

  const reload = () => {
    setLoadErr(null);
    api<KeytermSettings>("/api/settings/keyterms").then(apply, (e: Error) => setLoadErr(e.message));
  };

  const dirty = data !== null && !sameList(draft, data.terms);
  const maxTerms = data?.max_terms ?? 1000;
  const maxChars = data?.max_chars ?? 50;

  useEffect(() => {
    if (!data) return;
    writeDraft(user.id, dirty ? draft : null);
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [data, dirty, draft, user.id]);

  const savedKeys = useMemo(() => new Set((data?.terms ?? []).map(key)), [data]);
  const draftKeys = useMemo(() => new Set(draft.map(key)), [draft]);
  const added = draft.filter((t) => !savedKeys.has(key(t))).length;
  const removed = (data?.terms ?? []).filter((t) => !draftKeys.has(key(t))).length;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? draft.filter((t) => t.toLowerCase().includes(q)) : draft;
  }, [draft, filter]);

  /** Adds one term or many (one per line). Invalid ones are reported and left in the box so they can be fixed. */
  const addTerms = (raw: string) => {
    const parts = raw.split(/\r?\n/).map(clean).filter(Boolean);
    if (!parts.length) return;
    const next = [...draft];
    const seen = new Set(next.map(key));
    const tooLong: string[] = [];
    let dup = 0;
    let over = 0;
    for (const t of parts) {
      if ([...t].length > maxChars) tooLong.push(t);
      else if (seen.has(t.toLowerCase())) dup++;
      else if (next.length >= maxTerms) over++;
      else {
        next.push(t);
        seen.add(t.toLowerCase());
      }
    }
    const n = next.length - draft.length;
    setDraft(next);
    setEntry(tooLong[0] ?? "");
    const problems = [
      tooLong.length ? `ยาวเกิน ${maxChars} ตัวอักษร ${tooLong.length} คำ${tooLong.length === 1 ? "" : " (แสดงคำแรกในช่อง)"}` : "",
      dup ? `มีอยู่แล้ว ${dup} คำ` : "",
      over ? `เกิน ${maxTerms.toLocaleString()} คำ ${over} คำ` : "",
    ].filter(Boolean);
    setEntryErr(problems.length ? `${n ? `เพิ่ม ${n} คำ · ` : "ไม่ได้เพิ่ม · "}${problems.join(" · ")}` : null);
    if (n) setAnnounce(`เพิ่ม ${n} คำ`);
  };

  const remove = (t: string, idx: number) => {
    setDraft((d) => d.filter((x) => x !== t));
    setAnnounce(`ลบ “${t}” แล้ว`);
    // Keep keyboard focus in the list: the chip that moves into this place, or the one before, or the input.
    requestAnimationFrame(() => {
      const btns = listRef.current?.querySelectorAll<HTMLButtonElement>(".kt-x");
      const target = btns?.[Math.min(idx, (btns?.length ?? 1) - 1)];
      (target ?? inputRef.current)?.focus();
    });
  };

  const save = async () => {
    if (!data || saving) return;
    setSaving(true);
    setSaveErr(null);
    try {
      // Saving exactly the default list means "use the defaults", so later changes to them apply too.
      const d = sameList(draft, data.default_terms)
        ? await api<KeytermSettings>("/api/settings/keyterms", { method: "DELETE" })
        : await api<KeytermSettings>("/api/settings/keyterms", { method: "PUT", body: { terms: draft } });
      setData(d);
      setDraft(d.terms);
      setRestored(false);
      writeDraft(user.id, null);
      toast(`บันทึกคำเฉพาะ ${d.terms.length} คำแล้ว ใช้กับงานที่อัปโหลดหลังจากนี้`, { icon: "check" });
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (!data) return;
    setDraft(data.terms);
    setRestored(false);
    setEntryErr(null);
    setSaveErr(null);
    setAnnounce("ยกเลิกการเปลี่ยนแปลงแล้ว");
  };

  return (
    <section className="wrap view-enter set-page" id="view-settings">
      <div className="lib-head">
        <div>
          <h1 tabIndex={-1}>ตั้งค่า</h1>
          <p>
            ตั้งค่าของบัญชี <b>{user.email}</b> มีผลกับงานที่บัญชีนี้อัปโหลดเท่านั้น
          </p>
        </div>
      </div>

      <section className="card set-card" aria-labelledby="kt-h" data-testid="keyterms">
        <div className="set-head">
          <span className="set-ic" aria-hidden="true">
            <Icon name="tag" />
          </span>
          <div>
            <h2 id="kt-h">คำเฉพาะสำหรับการถอดเสียง</h2>
            <p>
              ชื่อบริษัท แบรนด์ สถานที่ และศัพท์ที่ใช้ในที่ประชุม ช่วยให้ถอดเสียงคำเหล่านี้ได้ถูกต้อง และใช้เป็นรายการคำอ้างอิงตอนตรวจแก้ข้อความ
              มีผลกับงานที่อัปโหลดหลังบันทึก งานเดิมไม่เปลี่ยน
            </p>
          </div>
        </div>

        <div className="set-note" role="note">
          <Icon name="alert" />
          <p>
            <b>อย่าใส่ชื่อคน</b> จนกว่าจะตรวจรายชื่อผู้เข้าประชุมแล้ว ชื่อที่สะกดผิดทำให้ระบบเปลี่ยนชื่อคนในทรานสคริปต์ผิดไปด้วย
            <span className="set-note-sub">เมื่อมีคำอย่างน้อย 1 คำ ค่าถอดเสียงเพิ่มขึ้น 20%</span>
          </p>
        </div>

        {loadErr ? (
          <div className="empty lib-empty" role="alert">
            <Icon name="alert" />
            <b>โหลดการตั้งค่าไม่สำเร็จ</b>
            <span>{loadErr}</span>
            <button className="btn btn-secondary" type="button" onClick={reload}>
              <Icon name="refresh" />
              ลองอีกครั้ง
            </button>
          </div>
        ) : !data ? (
          <div className="kt-skel" aria-busy="true" aria-label="กำลังโหลด">
            {[72, 110, 64, 96, 88, 120, 58].map((w, i) => (
              <span key={i} className="skel" style={{ width: w }} />
            ))}
          </div>
        ) : (
          <>
            {restored && (
              <p className="kt-restored" role="status">
                <Icon name="info" />
                มีรายการที่แก้ไว้แต่ยังไม่ได้บันทึก กดบันทึกเพื่อใช้ หรือยกเลิกเพื่อกลับไปใช้รายการเดิม
              </p>
            )}

            <div className="field kt-field">
              <div className="label-row">
                <label className="label" htmlFor="kt-add">
                  เพิ่มคำ
                </label>
                <span className={`kt-len mono${[...clean(entry)].length > maxChars ? " over" : ""}`} aria-hidden="true">
                  {[...clean(entry)].length}/{maxChars}
                </span>
              </div>
              <div className="kt-add">
                <div className="input-wrap">
                  <Icon name="plus" />
                  <input
                    ref={inputRef}
                    id="kt-add"
                    className="input"
                    type="text"
                    autoComplete="off"
                    enterKeyHint="done"
                    placeholder="เช่น Lotus, ประธานอาวุโส"
                    value={entry}
                    aria-describedby={`kt-add-hint${entryErr ? " kt-add-err" : ""}`}
                    aria-invalid={entryErr ? true : undefined}
                    data-testid="kt-input"
                    onChange={(e) => {
                      setEntry(e.target.value);
                      setEntryErr(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        addTerms(entry);
                      }
                    }}
                    onPaste={(e) => {
                      const text = e.clipboardData.getData("text");
                      if (/\r?\n/.test(text.trim())) {
                        e.preventDefault();
                        addTerms(text);
                      }
                    }}
                  />
                </div>
                <button className="btn btn-secondary" type="button" disabled={!clean(entry)} onClick={() => addTerms(entry)} data-testid="kt-add">
                  เพิ่ม
                </button>
              </div>
              <p className="kt-hint" id="kt-add-hint">
                กด Enter เพื่อเพิ่ม วางรายการหลายบรรทัดได้ (บรรทัดละคำ) · คำละไม่เกิน {maxChars} ตัวอักษร
              </p>
              {entryErr && (
                <p className="err-msg" id="kt-add-err" role="alert" data-testid="kt-error">
                  <Icon name="alert" />
                  {entryErr}
                </p>
              )}
            </div>

            <div className="kt-bar">
              <span className="kt-count">
                <b className="mono" data-testid="kt-count">
                  {draft.length.toLocaleString()}
                </b>{" "}
                / {maxTerms.toLocaleString()} คำ
              </span>
              {draft.length > 12 && (
                <label className="search kt-filter">
                  <Icon name="search" />
                  <span className="sr-only">ค้นหาในรายการคำ</span>
                  <input type="search" placeholder="ค้นหาในรายการ" autoComplete="off" value={filter} onChange={(e) => setFilter(e.target.value)} />
                </label>
              )}
              <div className="kt-tools">
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  disabled={sameList(draft, data.default_terms)}
                  onClick={() => {
                    setDraft(data.default_terms);
                    setAnnounce(`ใส่รายการเริ่มต้น ${data.default_terms.length} คำ กดบันทึกเพื่อใช้`);
                  }}
                >
                  <Icon name="refresh" />
                  ใช้รายการเริ่มต้น
                </button>
                <button
                  className="btn btn-ghost btn-sm kt-clear"
                  type="button"
                  disabled={!draft.length}
                  onClick={() => {
                    setDraft([]);
                    setAnnounce("ลบคำทั้งหมดแล้ว กดบันทึกเพื่อใช้ หรือยกเลิกเพื่อกลับไปใช้รายการเดิม");
                  }}
                >
                  <Icon name="trash" />
                  ลบทั้งหมด
                </button>
              </div>
            </div>

            {draft.length === 0 ? (
              <div className="empty lib-empty kt-empty" data-testid="kt-empty">
                <Icon name="tag" />
                <b>ยังไม่มีคำเฉพาะ</b>
                <span>งานใหม่จะถอดเสียงโดยไม่มีรายการคำช่วย และตรวจแก้โดยไม่มีรายการคำอ้างอิง</span>
              </div>
            ) : shown.length === 0 ? (
              <p className="empty">ไม่พบ “{filter.trim()}” ในรายการ</p>
            ) : (
              <ul className="kt-list" ref={listRef} aria-label="คำเฉพาะ" data-testid="kt-list">
                {shown.map((t, i) => {
                  const isNew = !savedKeys.has(key(t));
                  return (
                    <li key={t} className={`kt-chip${isNew ? " new" : ""}`}>
                      <span className="kt-t">{t}</span>
                      {isNew && <span className="sr-only">(ยังไม่บันทึก)</span>}
                      <button className="kt-x" type="button" aria-label={`ลบ “${t}”`} onClick={() => remove(t, i)}>
                        <Icon name="x" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {data.is_default && !dirty && <p className="kt-foot">ยังไม่เคยแก้ ตอนนี้ใช้รายการเริ่มต้นของระบบ</p>}
          </>
        )}
      </section>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      {dirty && (
        <div className="set-save" role="region" aria-label="การเปลี่ยนแปลงที่ยังไม่บันทึก" data-testid="kt-savebar">
          <p>
            <Icon name="info" />
            <span>
              ยังไม่ได้บันทึก
              <span className="mono set-diff">
                {added ? ` +${added}` : ""}
                {removed ? ` −${removed}` : ""}
              </span>
            </span>
          </p>
          {saveErr && (
            <p className="err-msg" role="alert">
              <Icon name="alert" />
              {saveErr}
            </p>
          )}
          <div className="set-save-btns">
            <button className="btn btn-ghost" type="button" onClick={discard} disabled={saving}>
              ยกเลิก
            </button>
            <button className="btn btn-primary" type="button" onClick={save} disabled={saving} data-testid="kt-save">
              {saving ? <Icon name="loader" className="spin" /> : <Icon name="check" />}
              {saving ? "กำลังบันทึก" : "บันทึก"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
