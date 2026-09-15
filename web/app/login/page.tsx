"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthStage, useShake } from "@/components/AuthStage";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toasts";
import { api } from "@/lib/api";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const shake = useShake();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [remember, setRemember] = useState(true);
  const [showPw, setShowPw] = useState(false);
  const [emailErr, setEmailErr] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Already signed in? Skip the form.
    api("/api/auth/me")
      .then(() => router.replace("/"))
      .catch(() => {});
    if (params.get("loggedOut")) toast("ออกจากระบบแล้ว", { icon: "log-out" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkEmail = (v = email) => {
    const t = v.trim();
    const msg = !t ? "กรอกอีเมลที่ใช้เข้าสู่ระบบ" : !EMAIL_RE.test(t) ? "รูปแบบอีเมลไม่ถูกต้อง ตัวอย่าง: name@company.com" : "";
    setEmailErr(msg);
    return !msg;
  };
  const checkPw = (v = pw) => {
    const msg = !v ? "กรอกรหัสผ่าน" : v.length < 8 ? "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" : "";
    setPwErr(msg);
    return !msg;
  };

  const next = () => {
    const n = params.get("next");
    return n && n.startsWith("/") && !n.startsWith("//") ? n : "/";
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const okE = checkEmail(), okP = checkPw();
    if (!okE || !okP) {
      const bad = !okE ? emailRef.current : pwRef.current;
      shake(bad?.closest(".input-wrap") as HTMLElement);
      bad?.focus();
      return;
    }
    setBusy(true);
    try {
      await api("/api/auth/login", { method: "POST", body: { email, password: pw, remember } });
      setOk(true);
      setTimeout(() => router.replace(next()), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 520);
    } catch (err) {
      setBusy(false);
      setPwErr((err as Error).message);
      shake(pwRef.current?.closest(".input-wrap") as HTMLElement);
    }
  };

  return (
    <section className="login" aria-label="เข้าสู่ระบบ Transcripto">
      <AuthStage />
      <div className="login-pane" id="main">
        <div className="login-card">
          <div className="login-title">
            <h1 tabIndex={-1}>เข้าสู่ระบบ</h1>
            <p>ใช้อีเมลและรหัสผ่านที่ผู้ดูแลระบบให้ไว้</p>
          </div>
          <form className="form" noValidate onSubmit={submit}>
            <div className="field">
              <label className="label" htmlFor="email">
                อีเมล
              </label>
              <div className="input-wrap">
                <Icon name="mail" />
                <input
                  ref={emailRef}
                  className="input"
                  id="email"
                  name="email"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  value={email}
                  aria-invalid={!!emailErr}
                  aria-describedby="email-err"
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={(e) => e.target.value && checkEmail(e.target.value)}
                />
              </div>
              {emailErr && (
                <p className="err-msg" id="email-err" role="alert">
                  <Icon name="alert" />
                  {emailErr}
                </p>
              )}
            </div>
            <div className="field">
              <label className="label" htmlFor="password">
                รหัสผ่าน
              </label>
              <div className="input-wrap">
                <Icon name="lock" />
                <input
                  ref={pwRef}
                  className="input has-action"
                  id="password"
                  name="password"
                  type={showPw ? "text" : "password"}
                  autoComplete="current-password"
                  value={pw}
                  aria-invalid={!!pwErr}
                  aria-describedby="pw-err"
                  onChange={(e) => setPw(e.target.value)}
                  onBlur={(e) => e.target.value && pwErr && checkPw(e.target.value)}
                />
                <button className="input-action" type="button" aria-label={showPw ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"} aria-pressed={showPw} onClick={() => setShowPw((s) => !s)}>
                  <Icon name={showPw ? "eye-off" : "eye"} />
                </button>
              </div>
              {pwErr && (
                <p className="err-msg" id="pw-err" role="alert">
                  <Icon name="alert" />
                  {pwErr}
                </p>
              )}
            </div>
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> จดจำการเข้าสู่ระบบบนอุปกรณ์นี้
            </label>
            <button className={`btn btn-primary btn-block btn-lg${ok ? " is-ok" : ""}`} type="submit" disabled={busy} data-testid="btn-login">
              {ok ? (
                <>
                  <Icon name="check" className="draw" />
                  เข้าสู่ระบบสำเร็จ
                </>
              ) : busy ? (
                <>
                  <Icon name="loader" className="spin" />
                  กำลังเข้าสู่ระบบ…
                </>
              ) : (
                "เข้าสู่ระบบ"
              )}
            </button>
          </form>
        </div>
      </div>
    </section>
  );
}
