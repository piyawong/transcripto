"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, ApiError, type User } from "./api";

interface Session {
  user: User;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionGate");
  return s;
}

/** Loads the signed-in user; sends visitors without a session to /login. */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ user: User }>("/api/auth/me")
      .then((r) => alive && setUser(r.user))
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) {
          router.replace(pathname && pathname !== "/" ? `/login?next=${encodeURIComponent(pathname)}` : "/login");
        } else {
          // Server unreachable: retry shortly rather than bouncing to login.
          setTimeout(() => alive && router.refresh(), 3000);
        }
      });
    return () => {
      alive = false;
    };
  }, [router, pathname]);

  const logout = useCallback(async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } catch {}
    router.replace("/login?loggedOut=1");
  }, [router]);

  if (!user) return null;
  return <Ctx.Provider value={{ user, logout }}>{children}</Ctx.Provider>;
}
