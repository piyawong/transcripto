import { Topbar } from "@/components/Topbar";
import { JobsProvider } from "@/lib/jobs";
import { SessionGate } from "@/lib/session";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionGate>
      <JobsProvider>
        <div id="shell">
          <Topbar />
          <main id="main" tabIndex={-1}>
            {children}
          </main>
        </div>
      </JobsProvider>
    </SessionGate>
  );
}
