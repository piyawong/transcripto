"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { initials } from "@/lib/format";
import { isActive, useJobs } from "@/lib/jobs";
import { useSession } from "@/lib/session";
import { BrandMark, Icon } from "./Icon";

export function Topbar() {
  const { user, logout } = useSession();
  const { jobs, bellRing } = useJobs();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = jobs.filter(isActive).length;
  const n = active;

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>(".menu-item")?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".me")) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link className="brand" href="/" aria-label="Transcripto หน้าหลัก">
          <BrandMark />
          <span className="brand-word">Transcripto</span>
        </Link>
        <nav className="nav" aria-label="เมนูหลัก">
          <Link href="/" aria-current={pathname === "/" || pathname.startsWith("/jobs") ? "page" : undefined}>
            <Icon name="film" />
            <span>งานถอดเสียง</span>
          </Link>
        </nav>
        <div className="top-right">
          <button
            className={`icon-btn bell${bellRing ? " ring" : ""}`}
            type="button"
            aria-label={active ? `งานที่กำลังประมวลผล ${active} งาน` : "ไม่มีงานที่กำลังประมวลผล"}
            onClick={() => router.push("/?status=active")}
          >
            {/* remounting the icon replays the shake each time a job finishes */}
            <Icon key={bellRing} name="bell" />
            <span className="badge" hidden={n === 0} data-testid="bell-count">
              {n}
            </span>
          </button>
          <div className="me">
            <button className="me-btn" type="button" aria-haspopup="menu" aria-expanded={open} aria-controls="me-menu" onClick={() => setOpen((o) => !o)}>
              <span className="me-av" aria-hidden="true">
                {initials(user.name)}
              </span>
              <span className="sr-only">บัญชีของ {user.name}</span>
              <Icon name="chevron-down" className="nm-arrow" />
            </button>
            <div
              className="menu"
              id="me-menu"
              role="menu"
              hidden={!open}
              ref={menuRef}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
            >
              <div className="menu-who">
                <b>{user.name}</b>
                <span>{user.email}</span>
              </div>
              <div className="menu-sep" />
              <Link className="menu-item" href="/settings" role="menuitem" onClick={() => setOpen(false)} aria-current={pathname === "/settings" ? "page" : undefined}>
                <Icon name="settings" />
                ตั้งค่า
              </Link>
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  logout();
                }}
              >
                <Icon name="log-out" />
                ออกจากระบบ
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
