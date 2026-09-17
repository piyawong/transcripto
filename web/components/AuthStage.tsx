"use client";

import Link from "next/link";
import { BrandMark, Icon } from "./Icon";
import { ProcessScene } from "./ProcessScene";

/** Left half of the login screen: pitch + a looping scene of how a recording becomes a transcript and a summary. */
export function AuthStage() {
  return (
    <div className="login-stage">
      <Link className="brand" href="/login">
        <BrandMark />
        Transcripto
      </Link>
      <div>
        <p className="pitch">
          ถอดเสียงวิดีโอเป็นข้อความ <em>รู้ทันทีว่าใครพูด</em> พูดตอนไหน
        </p>
        <p className="pitch-sub">อัปโหลดคลิปประชุม งานสัมมนา หรือบทสัมภาษณ์ ระบบจะแยกผู้พูด จับเวลาให้ทุกประโยค และสรุปการประชุมให้อัตโนมัติ</p>
      </div>
      <ProcessScene />
      <ul className="facts">
        <li>
          <Icon name="check" />
          ภาษาไทยและอังกฤษ
        </li>
        <li>
          <Icon name="check" />
          แยกผู้พูดและสรุปการประชุม
        </li>
        <li>
          <Icon name="check" />
          ส่งออก TXT · CSV · MD
        </li>
      </ul>
    </div>
  );
}

export function useShake() {
  return (el: HTMLElement | null) => {
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
  };
}
