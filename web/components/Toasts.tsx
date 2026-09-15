"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

export interface ToastOptions {
  kind?: "err";
  icon?: string;
  action?: { label: string; run: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
  msg: string;
  out?: boolean;
}

const Ctx = createContext<(msg: string, opts?: ToastOptions) => void>(() => {});

export function useToast() {
  return useContext(Ctx);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const close = useCallback((id: number) => {
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, out: true } : x)));
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 180);
  }, []);

  const toast = useCallback(
    (msg: string, opts: ToastOptions = {}) => {
      const id = ++seq.current;
      setItems((xs) => [...xs, { id, msg, ...opts }].slice(-3));
      timers.current.set(id, window.setTimeout(() => close(id), opts.action ? 9000 : 5000));
    },
    [close],
  );

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach((h) => clearTimeout(h));
  }, []);

  return (
    <Ctx.Provider value={toast}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast${t.kind === "err" ? " err" : ""}${t.out ? " out" : ""}`}
            style={{ ["--life" as string]: t.action ? "9s" : "5s" }}
            data-testid="toast"
          >
            <Icon name={t.kind === "err" ? "alert" : t.icon || "check"} />
            <p>{t.msg}</p>
            {t.action && (
              <button
                className="toast-act"
                type="button"
                onClick={() => {
                  t.action!.run();
                  close(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="toast-x" type="button" aria-label="ปิดการแจ้งเตือน" onClick={() => close(t.id)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
