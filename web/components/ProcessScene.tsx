"use client";

import gsap from "gsap";
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import "@/app/process-scene.css";
import { Icon } from "./Icon";

/* "How it works" scene for the login stage, ported from animation/a-clay.html (Clay Buddies, Mochi only).
   The prototype scrubbed its timeline with the page scroll; here the same choreography plays by itself and loops.
   Desktop only: at ≤860px the login stage hides it, as it did the old transcript demo. */

const STEPS = [
  { at: 0, label: "อัปโหลดเสียง" },
  { at: 2.5, label: "แยกผู้พูด" },
  { at: 5, label: "ถอดเสียง" },
  { at: 8.5, label: "สรุปประชุม" },
];
// waveform runs: [speaker, bar count] — three speakers take turns
const WAVE_RUNS = [[0, 9], [1, 7], [2, 8], [0, 6], [2, 5], [1, 6], [0, 4]];
const BARS = WAVE_RUNS.flatMap(([s, n]) => Array<number>(n).fill(s)).map((s, i) => ({
  s,
  h: (0.28 + 0.72 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45))).toFixed(2),
}));
const LINES = [
  { ts: "00:00", say: "งบการตลาดไตรมาสนี้ ขอเพิ่มอีก 15% นะคะ" },
  { ts: "00:13", say: "ถ้าเพิ่ม ต้องเลื่อน เปิดตัวสินค้า ไปพฤศจิกา" },
  { ts: "00:21", say: "งั้นขอ ตัวเลขประกอบ ภายในศุกร์นี้" },
];
const TALK = [[5.4, 6.4], [6.5, 7.4], [7.5, 8.2]];
const SHARE = ["38%", "27%", "35%"];
const TODOS = [
  { text: "เตรียมตัวเลขประกอบ", due: "ศุกร์" },
  { text: "ประเมินผลกระทบไทม์ไลน์" },
  { text: "นัดประชุมตัดสินใจรอบถัดไป" },
];
const OLD_NAME = "ผู้พูด 3";
// the summary is complete by HOLD_AT (the still frame for reduced motion); FADE_AT clears the stage for the next loop
const HOLD_AT = 13.4;
const FADE_AT = 15.4;

const graphemes = (text: string) => {
  try {
    return Array.from(new Intl.Segmenter("th", { granularity: "grapheme" }).segment(text), (s) => s.segment);
  } catch {
    return [text];
  }
};
const NEW_NAME = graphemes("คุณมาลี");
const NOTE_TITLE = graphemes("วางแผนงบการตลาดไตรมาส 4");
const progress = (t: number, a: number, b: number) => (t - a) / (b - a);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function ProcessScene() {
  const rootRef = useRef<HTMLDivElement>(null);
  const tlRef = useRef<gsap.core.Timeline | null>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    tlRef.current?.paused(paused);
  }, [paused]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mm = gsap.matchMedia();
    mm.add(
      { desktop: "(width > 860px)", reduce: "(prefers-reduced-motion: reduce)" },
      (ctx) => {
        if (!ctx.conditions?.desktop) return;
        const O = (n: string) => root.querySelector<HTMLElement>(`[data-o="${n}"]`)!;
        const OO = (names: string[]) => names.map(O);
        const chips = Array.from(root.querySelectorAll<HTMLElement>("[data-step]"));
        const bars = Array.from(root.querySelectorAll<HTMLElement>(".ps-wave i"));
        const says = [0, 1, 2].map((i) => Array.from(O(`say${i}`).querySelectorAll<HTMLElement>(".ps-w")));
        const balls = OO(["ball0", "ball1", "ball2"]);
        const buddies = OO(["buddy0", "buddy1", "buddy2"]);
        const bubbles = OO(["bubble0", "bubble1", "bubble2"]);
        const renamed = OO(["name2", "bubbleName2"]);
        const title = O("noteTitle");
        const css = getComputedStyle(root);
        const speakerColor = [1, 2, 3].map((n) => css.getPropertyValue(`--spk-${n}`).trim());

        // [left %, top %, scale]
        const at = (p: number[], extra?: gsap.TweenVars): gsap.TweenVars => ({ left: `${p[0]}%`, top: `${p[1]}%`, scale: p[2] ?? 1, ...extra });
        const P = {
          machine: [[35, 27], [1, 1, 0.6]],
          file: [[38, -2], [38, 18]],
          wave: [6, 36],
          head: [6, 80],
          buddies: [
            [[14, 56], [44, 56], [74, 56]],
            [[2, 6, 0.78], [2, 30, 0.78], [2, 54, 0.78]],
            [[3, 76, 0.62], [13, 76, 0.62], [23, 76, 0.62]],
          ],
          bubbles: [[19, 7], [19, 31], [19, 55]],
          waveLow: [6, 88, 0.92],
          note: [37, 5],
        };
        const tl = gsap.timeline({ paused: true, repeat: -1, defaults: { ease: "power2.inOut", duration: 1 } });
        balls.forEach(buddyInit);

        /* 01 · upload — a clay file drops into the Transcripto machine */
        gsap.set(O("ring"), { strokeDashoffset: 1 });
        gsap.set(O("status"), { autoAlpha: 0, scale: 0.6 });
        tl.fromTo(O("machine"), at(P.machine[0], { autoAlpha: 0, scale: 0.7 }), at(P.machine[0], { autoAlpha: 1, duration: 0.4, ease: "back.out(1.8)", immediateRender: true }), 0);
        tl.fromTo(O("file"), at(P.file[0], { rotate: -24, autoAlpha: 0 }), at(P.file[1], { rotate: 6, autoAlpha: 1, duration: 0.9, ease: "power2.in", immediateRender: true }), 0.1);
        tl.to(O("file"), { rotate: 0, scaleY: 0.8, scaleX: 1.08, duration: 0.18, ease: "power1.out" }, 1);
        tl.to(O("file"), { y: 60, scale: 0.35, autoAlpha: 0, duration: 0.35, ease: "power2.in" }, 1.18);
        tl.to(O("machine"), { scaleY: 0.92, scaleX: 1.04, duration: 0.15, yoyo: true, repeat: 1, ease: "sine.inOut" }, 1.25);
        tl.to(O("ring"), { strokeDashoffset: 0, duration: 0.9, ease: "none" }, 1.3);
        tl.to(O("status"), { autoAlpha: 1, scale: 1, duration: 0.3, ease: "back.out(2.5)" }, 2.1);

        /* 02 · speakers — the waveform unrolls and three buddies claim their parts */
        tl.to(O("machine"), at(P.machine[1], { duration: 0.6, ease: "power3.inOut" }), 2.5);
        tl.fromTo(O("wave"), at(P.wave, { scaleX: 0, autoAlpha: 0 }), at(P.wave, { scaleX: 1, autoAlpha: 1, duration: 0.5, ease: "power3.out", immediateRender: true }), 2.7);
        tl.fromTo(bars, { scaleY: 0.1 }, { scaleY: 1, stagger: 0.012, duration: 0.3, ease: "back.out(2)", immediateRender: true }, 2.9);
        buddies.forEach((b, i) => {
          tl.fromTo(b, at(P.buddies[0][i], { y: 60, autoAlpha: 0 }), at(P.buddies[0][i], { y: 0, autoAlpha: 1, duration: 0.3, ease: "power3.out", immediateRender: true }), 3.2 + i * 0.12);
          buddyPop(tl, balls[i], 3.22 + i * 0.12);
        });
        speakerColor.forEach((color, s) => {
          const colourAt = 3.8 + s * 0.35;
          tl.to(bars.filter((b) => Number(b.dataset.s) === s), { backgroundColor: color, stagger: 0.015, duration: 0.2, ease: "none" }, colourAt);
          buddyHop(tl, balls[s], colourAt);
          tl.fromTo(O(`share${s}`), { autoAlpha: 0, scale: 0.4 }, { autoAlpha: 1, scale: 1, duration: 0.25, ease: "back.out(2.4)", immediateRender: true }, colourAt + 0.2);
        });

        /* 03 · transcript — buddies line up, each speech bubble is read word by word */
        tl.to(O("machine"), { autoAlpha: 0, scale: 0.2, duration: 0.45, ease: "back.in(1.6)" }, 5);
        tl.to(O("wave"), at(P.waveLow, { duration: 0.6, ease: "power2.inOut" }), 5);
        buddies.forEach((b, i) => tl.to(b, at(P.buddies[1][i], { duration: 0.6, ease: "power3.inOut" }), 5 + i * 0.05));
        gsap.set(O("head"), at(P.head));
        tl.to(O("head"), { autoAlpha: 1, duration: 0.2 }, 5.5);
        tl.to(O("head"), { left: "92%", duration: 2.9, ease: "none" }, 5.5);
        bubbles.forEach((b, i) => {
          tl.fromTo(b, at(P.bubbles[i], { x: -40, scale: 0.6, autoAlpha: 0 }), at(P.bubbles[i], { x: 0, scale: 1, autoAlpha: 1, duration: 0.35, ease: "back.out(1.8)", immediateRender: true }), TALK[i][0] - 0.15);
          buddyTalk(tl, balls[i], TALK[i][0], TALK[i][1] - TALK[i][0]);
        });
        gsap.set(O("pencil"), { autoAlpha: 0, scale: 0.3 });
        tl.to(O("pencil"), { autoAlpha: 1, scale: 1.3, rotate: -20, duration: 0.2, ease: "back.out(2)" }, 8);
        buddyReact(tl, balls[2], 8.1);
        tl.to(O("pencil"), { scale: 1, rotate: 0, duration: 0.2 }, 8.35);

        /* 04 · summary — bubbles squish into a clay notebook that flips open */
        bubbles.forEach((b, i) => {
          tl.to(b, { left: "50%", top: "34%", scale: 0.25, rotate: (i - 1) * 25, autoAlpha: 0, duration: 0.5, ease: "power2.in" }, 8.5 + i * 0.08);
        });
        tl.to([O("wave"), O("head")], { autoAlpha: 0, y: 20, duration: 0.4, ease: "power2.in" }, 8.5);
        buddies.forEach((b, i) => tl.to(b, at(P.buddies[2][i], { duration: 0.6, ease: "power3.inOut" }), 8.6 + i * 0.05));
        gsap.set(O("note"), { transformPerspective: 1400 });
        tl.fromTo(O("note"), at(P.note, { rotateY: -75, autoAlpha: 0, x: -30 }), at(P.note, { rotateY: 0, autoAlpha: 1, x: 0, duration: 0.8, ease: "back.out(1.2)", immediateRender: true }), 8.85);
        tl.fromTo(OO(["pt0", "pt1", "sub", "td0", "td1", "td2"]), { autoAlpha: 0, x: -14 }, { autoAlpha: 1, x: 0, stagger: 0.18, duration: 0.3, ease: "power3.out", immediateRender: true }, 9.9);
        [0, 1, 2].forEach((n) => {
          const cb = O(`cb${n}`);
          const tick = cb.querySelector("path");
          gsap.set(tick, { strokeDashoffset: 1 });
          tl.to(cb, { backgroundColor: "#1fb574", boxShadow: "inset 0 -3px 0 rgba(0,0,0,0.15)", scale: 1.2, duration: 0.15, ease: "power2.out" }, 10.9 + n * 0.3);
          tl.to(tick, { strokeDashoffset: 0, duration: 0.2, ease: "power2.out" }, 10.95 + n * 0.3);
          tl.to(cb, { scale: 1, duration: 0.15 }, 11.1 + n * 0.3);
        });
        tl.fromTo(OO(["dl0", "dl1"]), { autoAlpha: 0, y: 20, scale: 0.6 }, { autoAlpha: 1, y: 0, scale: 1, stagger: 0.15, duration: 0.35, ease: "back.out(2.4)", immediateRender: true }, 11.9);
        balls.forEach((ball, i) => buddyCheer(tl, ball, 12.2 + i * 0.12));

        /* hold the finished summary, then clear the stage before the loop restarts */
        tl.to([O("note"), ...buddies], { autoAlpha: 0, y: 16, stagger: 0.05, duration: 0.5, ease: "power2.in" }, FADE_AT);
        tl.to({}, { duration: 0.4 }, FADE_AT + 0.8);

        // text and highlights come from the playhead and constants, never read back from the DOM,
        // so a rebuilt timeline (StrictMode, crossing the breakpoint) starts clean
        const apply = () => {
          const t = tl.time();
          chips.forEach((el, i) => {
            const next = STEPS[i + 1];
            const on = t >= STEPS[i].at && (!next || t < next.at);
            el.classList.toggle("is-on", on);
            el.classList.toggle("is-done", !!next && t >= next.at);
            if (on !== el.hasAttribute("aria-current")) {
              if (on) el.setAttribute("aria-current", "step");
              else el.removeAttribute("aria-current");
            }
          });
          says.forEach((words, i) => {
            const p = progress(t, TALK[i][0], TALK[i][1]);
            const hot = Math.min(Math.floor(p * words.length), words.length - 1);
            words.forEach((w, j) => w.classList.toggle("hot", p > 0 && p < 1 && j === hot));
          });
          // the host renames "ผู้พูด 3" → "คุณมาลี"; the transcript follows
          const r = progress(t, 8.1, 8.45);
          const name = r <= 0 ? OLD_NAME : NEW_NAME.slice(0, Math.max(1, Math.ceil(clamp01(r) * NEW_NAME.length))).join("");
          renamed.forEach((el) => {
            if (el.textContent !== name) el.textContent = name;
          });
          const typed = NOTE_TITLE.slice(0, Math.floor(clamp01(progress(t, 9.3, 9.9)) * NOTE_TITLE.length)).join("");
          if (title.textContent !== typed) title.textContent = typed;
        };
        tl.eventCallback("onUpdate", apply);
        root.dataset.live = "";

        if (ctx.conditions?.reduce) {
          tl.seek(HOLD_AT);
          apply();
        } else {
          // rebuilt while the viewer has it paused (crossing the breakpoint): hold the finished summary, not an empty stage
          if (root.dataset.paused === "true") tl.seek(HOLD_AT);
          else tl.play();
          apply();
          tlRef.current = tl;
        }
        return () => {
          tlRef.current = null;
          delete root.dataset.live;
        };
      },
      root,
    );
    return () => mm.revert();
  }, []);

  return (
    <div className="ps" ref={rootRef} data-paused={paused}>
      <div className="ps-bar">
        <ol className="ps-steps" aria-label="ขั้นตอนการทำงาน">
          {STEPS.map((s, i) => (
            <li key={s.label} data-step={i}>
              <b>{String(i + 1).padStart(2, "0")}</b>
              {s.label}
            </li>
          ))}
        </ol>
        <button
          className="icon-btn ps-toggle"
          type="button"
          aria-label={paused ? "เล่นภาพเคลื่อนไหว" : "หยุดภาพเคลื่อนไหว"}
          title={paused ? "เล่นภาพเคลื่อนไหว" : "หยุดภาพเคลื่อนไหว"}
          onClick={() => setPaused((p) => !p)}
        >
          <Icon name={paused ? "play" : "pause"} />
        </button>
      </div>

      <div className="ps-frame">
        <div className="ps-art" aria-hidden="true">
          <span className="ps-blob" style={{ left: "78%", top: "4%" }} />
          <span className="ps-blob ps-blob-2" style={{ left: "4%", top: "78%" }} />

          <div className="ps-machine" data-o="machine">
            <span className="ps-slot" />
            <p className="ps-brand">
              Transcrip<span>to</span>
            </p>
            <div className="ps-dome">
              <svg className="ps-ring" viewBox="0 0 100 100">
                <circle className="ps-track" cx="50" cy="50" r="44" />
                <circle className="ps-fill" data-o="ring" cx="50" cy="50" r="44" pathLength="1" />
              </svg>
              <span className="ps-mic">
                <Icon name="mic" />
              </span>
            </div>
            <p className="ps-status" data-o="status">
              <Icon name="check" />
              ถอดเสียงเสร็จแล้ว
            </p>
          </div>

          <div className="ps-file ps-clay" data-o="file">
            <span className="ps-file-ic">
              <Icon name="music" />
            </span>
            <b>ประชุมทีม_Q4.m4a</b>
            <small>12 MB · 45:12</small>
          </div>

          <div className="ps-wave ps-clay" data-o="wave">
            {BARS.map((b, i) => (
              <i key={i} data-s={b.s} style={{ "--h": b.h } as CSSProperties} />
            ))}
          </div>
          <span className="ps-head" data-o="head" />

          {[0, 1, 2].map((i) => (
            <div key={i} className={`ps-buddy c${i + 1}`} data-o={`buddy${i}`}>
              <span className="ps-ball" data-o={`ball${i}`}>
                <Buddy n={i} />
                <b className="ps-num">{i + 1}</b>
              </span>
              <span className="ps-tag ps-clay">
                {i === 2 ? (
                  <>
                    <span data-o="name2">{OLD_NAME}</span>
                    <span className="ps-pencil" data-o="pencil">
                      <Icon name="pencil" />
                    </span>
                  </>
                ) : (
                  `ผู้พูด ${i + 1}`
                )}
                <em data-o={`share${i}`}>{SHARE[i]}</em>
              </span>
            </div>
          ))}

          {LINES.map((line, i) => (
            <div key={i} className={`ps-bubble ps-clay c${i + 1}`} data-o={`bubble${i}`}>
              <p className="ps-ts">
                <b>{line.ts}</b>
                {i === 2 ? <span data-o="bubbleName2">{OLD_NAME}</span> : <span>ผู้พูด {i + 1}</span>}
              </p>
              <p className="ps-say" data-o={`say${i}`}>
                {line.say.split(" ").map((word, j) => (
                  <Fragment key={j}>
                    {j > 0 && " "}
                    <span className="ps-w">{word}</span>
                  </Fragment>
                ))}
              </p>
            </div>
          ))}

          <div className="ps-note ps-clay" data-o="note">
            <p className="ps-note-head">
              <span>
                <Icon name="sparkles" />
                สรุปการประชุม
              </span>
              3 ผู้พูด · 45 นาที
            </p>
            <h3 data-o="noteTitle" />
            <ul className="ps-points">
              <li data-o="pt0">พิจารณาเพิ่มงบการตลาด 15%</li>
              <li data-o="pt1">อาจเลื่อนเปิดตัวสินค้าเป็น พ.ย.</li>
            </ul>
            <p className="ps-sub" data-o="sub">
              สิ่งที่ต้องทำต่อ
            </p>
            <ul className="ps-todos">
              {TODOS.map((todo, n) => (
                <li key={n} data-o={`td${n}`}>
                  <span className="ps-cb" data-o={`cb${n}`}>
                    <svg viewBox="0 0 24 24">
                      <path pathLength="1" d="M5 12.5l4.5 4.5L19 7" />
                    </svg>
                  </span>
                  {todo.text}
                  {todo.due && <em>{todo.due}</em>}
                </li>
              ))}
            </ul>
            <div className="ps-dls">
              <span className="ps-dl ps-dl-primary" data-o="dl0">
                <Icon name="download" />
                ดาวน์โหลดสรุป
              </span>
              <span className="ps-dl ps-dl-ghost" data-o="dl1">
                <Icon name="file-text" />
                ทรานสคริปต์ .txt
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Mochi, the speaker buddy (animation/buddies.js) ----------
   Layers: .bd-act (GSAP: pop / jump) > .bd-idle (CSS: breathe) > .bd-body (GSAP: talk squash) */

function Buddy({ n }: { n: number }) {
  return (
    <svg className="bd" style={{ "--n": n } as CSSProperties} viewBox="0 0 100 100">
      <ellipse className="bd-ground" cx="50" cy="94" rx="27" ry="4.5" />
      <g className="bd-act">
        <g className="bd-idle">
          <g className="bd-body">
            <path className="bd-fill" d="M50 24C73 24 88 41 88 63C88 82 72 91 50 91S12 82 12 63C12 41 27 24 50 24Z" />
            <path className="bd-shade" d="M13 68C17 83 31 91 50 91S83 83 87 68C81 79 67 85 50 85S19 79 13 68Z" />
            <ellipse className="bd-light" cx="33" cy="38" rx="11" ry="6" transform="rotate(-28 33 38)" />
            <circle className="bd-light" cx="46.5" cy="31" r="2.6" />
            <g className="bd-eyes">
              <g className="bd-blink">
                <ellipse className="bd-eye" cx="39" cy="58" rx="4.6" ry="5.8" />
                <ellipse className="bd-eye" cx="61" cy="58" rx="4.6" ry="5.8" />
                <circle className="bd-glint" cx="40.8" cy="55.6" r="1.8" />
                <circle className="bd-glint" cx="62.8" cy="55.6" r="1.8" />
              </g>
            </g>
            <ellipse className="bd-blush" cx="28.5" cy="67" rx="5.6" ry="3.3" />
            <ellipse className="bd-blush" cx="71.5" cy="67" rx="5.6" ry="3.3" />
            <path className="bd-mouth" d="M45 66.5 Q47.5 69.5 50 66.8 Q52.5 69.5 55 66.5" />
            <g className="bd-mouth-o">
              <ellipse cx="50" cy="69" rx="4.6" ry="5" />
              <ellipse className="bd-tongue" cx="50" cy="71.6" rx="2.8" ry="1.8" />
            </g>
          </g>
        </g>
      </g>
      <path className="bd-spark" d="M14 26l2.2 5 5 2.2-5 2.2-2.2 5-2.2-5-5-2.2 5-2.2Z" />
      <path className="bd-spark" d="M86 22l1.8 4 4 1.8-4 1.8-1.8 4-1.8-4-4-1.8 4-1.8Z" />
      <path className="bd-spark" d="M80 78l1.4 3.2 3.2 1.4-3.2 1.4-1.4 3.2-1.4-3.2-3.2-1.4 3.2-1.4Z" />
      <g className="bd-bang">
        <circle cx="84" cy="18" r="9" fill="#fff" stroke="#0a1133" strokeWidth="1.6" />
        <path d="M84 12.5v6.5" stroke="#0a1133" strokeWidth="3" strokeLinecap="round" />
        <circle cx="84" cy="23.2" r="1.8" fill="#0a1133" />
      </g>
    </svg>
  );
}

type Timeline = gsap.core.Timeline;

const buddyParts = (root: Element) => ({
  act: root.querySelector(".bd-act"),
  body: root.querySelector(".bd-body"),
  eyes: root.querySelector(".bd-eyes"),
  mouth: root.querySelector(".bd-mouth"),
  mouthO: root.querySelector(".bd-mouth-o"),
  sparks: Array.from(root.querySelectorAll(".bd-spark")),
  bang: root.querySelector(".bd-bang"),
});

function buddyInit(root: Element) {
  const p = buddyParts(root);
  gsap.set([p.act, p.body], { transformOrigin: "50% 100%" });
  gsap.set(p.eyes, { transformOrigin: "50% 50%" });
  gsap.set(p.mouthO, { scale: 0, transformOrigin: "50% 30%" });
  gsap.set([...p.sparks, p.bang], { autoAlpha: 0, transformOrigin: "50% 50%" });
}

/** springs in from nothing and lands with a squish */
function buddyPop(tl: Timeline, root: Element, at: number) {
  const p = buddyParts(root);
  tl.fromTo(p.act, { scale: 0, y: 26, rotate: -12 }, { scale: 1, y: 0, rotate: 0, duration: 0.45, ease: "back.out(2.6)", immediateRender: true }, at);
  tl.to(p.body, { scaleX: 1.16, scaleY: 0.84, duration: 0.09, yoyo: true, repeat: 1, ease: "sine.inOut" }, at + 0.36);
}

/** talks for `dur`: the mouth opens and closes while the body bounces */
function buddyTalk(tl: Timeline, root: Element, at: number, dur: number) {
  const p = buddyParts(root);
  const syll = Math.max(1, Math.round(dur / 0.2));
  const half = dur / (syll * 2);
  tl.set(p.mouth, { autoAlpha: 0 }, at);
  tl.set(p.mouth, { autoAlpha: 1 }, at + dur);
  tl.to(p.mouthO, { scale: 1, duration: half, yoyo: true, repeat: syll * 2 - 1, ease: "sine.inOut" }, at);
  tl.to(p.body, { scaleY: 1.08, scaleX: 0.94, duration: half, yoyo: true, repeat: syll * 2 - 1, ease: "sine.inOut" }, at);
}

/** surprised — the host renames this speaker */
function buddyReact(tl: Timeline, root: Element, at: number) {
  const p = buddyParts(root);
  tl.to(p.eyes, { scale: 1.35, duration: 0.14, yoyo: true, repeat: 1, ease: "back.out(3)" }, at);
  tl.to(p.act, { y: -10, duration: 0.14, yoyo: true, repeat: 1, ease: "power2.out" }, at);
  tl.fromTo(p.bang, { autoAlpha: 0, scale: 0.3, rotate: -20 }, { autoAlpha: 1, scale: 1, rotate: 0, duration: 0.2, ease: "back.out(3)", immediateRender: false }, at);
  tl.to(p.bang, { autoAlpha: 0, scale: 0.6, duration: 0.15 }, at + 0.55);
}

/** happy jump with sparkles */
function buddyCheer(tl: Timeline, root: Element, at: number) {
  const p = buddyParts(root);
  tl.to(p.body, { scaleX: 1.14, scaleY: 0.86, duration: 0.1, ease: "power2.out" }, at);
  tl.to(p.act, { y: -24, duration: 0.24, ease: "power2.out" }, at + 0.1);
  tl.to(p.body, { scaleX: 0.92, scaleY: 1.1, duration: 0.12 }, at + 0.1);
  tl.to(p.act, { y: 0, duration: 0.22, ease: "power2.in" }, at + 0.34);
  tl.to(p.body, { scaleX: 1.14, scaleY: 0.86, duration: 0.08, yoyo: true, repeat: 1, ease: "sine.inOut" }, at + 0.54);
  tl.to(p.body, { scaleX: 1, scaleY: 1, duration: 0.01 }, at + 0.72);
  tl.fromTo(p.sparks, { autoAlpha: 0, scale: 0.2 }, { autoAlpha: 1, scale: 1.3, rotate: 90, stagger: 0.05, duration: 0.25, ease: "back.out(2)", immediateRender: false }, at + 0.15);
  tl.to(p.sparks, { autoAlpha: 0, scale: 0.4, duration: 0.2, stagger: 0.05 }, at + 0.55);
}

/** quick hop when the waveform takes the speaker's colour */
function buddyHop(tl: Timeline, root: Element, at: number) {
  const p = buddyParts(root);
  tl.to(p.act, { y: -9, duration: 0.12, yoyo: true, repeat: 1, ease: "power2.out" }, at);
  tl.to(p.body, { scaleX: 1.1, scaleY: 0.9, duration: 0.06, yoyo: true, repeat: 1 }, at + 0.22);
}
