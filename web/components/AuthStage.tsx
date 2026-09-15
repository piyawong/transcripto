"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BrandMark, Icon } from "./Icon";

const DEMO_RANGES = [
  [0.01, 0.25],
  [0.27, 0.49],
  [0.51, 0.7],
  [0.72, 0.98],
];

/** Left half of the login screen: pitch + a looping example of the transcript view. */
export function AuthStage() {
  const phRef = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(-1);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (phRef.current) phRef.current.style.transform = "translateX(30%)";
      return;
    }
    let raf = 0;
    let last = -1;
    const t0 = performance.now();
    const loop = (t: number) => {
      const p = ((t - t0) % 14000) / 14000;
      if (phRef.current) phRef.current.style.transform = `translateX(${(p * 100).toFixed(2)}%)`;
      const i = DEMO_RANGES.findIndex(([a, b]) => p >= a && p < b);
      if (i >= 0 && i !== last) {
        last = i;
        setIdx(i);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const lines: [string, string, string, string][] = [
    ["c1", "00:01", "คุณอรทัย", "เริ่มกันเลยนะคะ วันนี้เราจะสรุปผลแคมเปญไตรมาสสาม"],
    ["c2", "00:09", "คุณภาคิน", "ยอดเข้าชมเว็บไซต์เพิ่มขึ้นสิบแปดเปอร์เซ็นต์ครับ"],
    ["c1", "00:15", "คุณอรทัย", "ส่วนไหนโตมากที่สุดคะ"],
    ["c3", "00:19", "ผู้พูด 3", "ขอเสริมนิดนึงครับ อัตราการซื้อยังทรงตัวอยู่"],
  ];

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
      <div className="demo" aria-hidden="true">
        <div className="demo-head">
          <span>ประชุมทีมการตลาด ไตรมาส 3.mp4</span>
          <span className="demo-live">
            <i />
            ตัวอย่างการทำงาน
          </span>
        </div>
        <ol className="demo-lines">
          {lines.map(([c, t, who, text], k) => (
            <li key={k} className={`${c}${k === idx ? " on" : ""}`}>
              <time>{t}</time>
              <div>
                <b>
                  {who}{" "}
                  <span className="eq">
                    <i />
                    <i />
                    <i />
                    <i />
                  </span>
                </b>
                <span>{text}</span>
              </div>
            </li>
          ))}
        </ol>
        <div className="mini-lanes">
          <div className="mini-lane c1">
            <i style={{ left: "1%", width: "23%" }} />
            <i style={{ left: "51%", width: "18%" }} />
          </div>
          <div className="mini-lane c2">
            <i style={{ left: "27%", width: "21%" }} />
          </div>
          <div className="mini-lane c3">
            <i style={{ left: "72%", width: "26%" }} />
          </div>
          <div className="mini-ph" ref={phRef} />
        </div>
      </div>
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
