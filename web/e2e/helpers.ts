import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export const SAMPLES = path.resolve(__dirname, "../../samples");
export const DEMO_VIDEO = process.env.E2E_VIDEO ?? path.join(SAMPLES, "demo_meeting_150s.mp4");

/** ADMIN_PASSWORD from the environment, else from the project-root .env / .env.test the API reads too. */
function adminPassword(): string {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  for (const name of [".env", ".env.test"]) {
    const file = path.resolve(__dirname, "../..", name);
    if (!fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, "utf8").match(/^ADMIN_PASSWORD=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("Set ADMIN_PASSWORD (env, .env or .env.test) to the admin account's password");
}

/** The seeded admin account (api/src/auth.rs); the only way in. */
export const ADMIN = { email: "admin@transcripto.app", password: adminPassword() };

export async function login(page: Page) {
  await page.goto("/login");
  // Typing before hydration would be lost; the page's session probe runs once it has hydrated.
  await page.waitForLoadState("networkidle");
  await page.locator("#email").fill(ADMIN.email);
  await page.locator("#password").fill(ADMIN.password);
  await page.getByTestId("btn-login").click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "ถอดเสียงวิดีโอ" })).toBeVisible();
}

/** Collects console errors and uncaught exceptions so tests can assert the page stayed clean. */
export function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Expected: auth probes that return 401 before login, and aborted media range requests.
    if (/401 \(Unauthorized\)|net::ERR_ABORTED/.test(t)) return;
    errors.push(`console: ${t}`);
  });
  return errors;
}

export function row(page: Page, name: string) {
  return page.getByTestId("job-row").filter({ hasText: name }).first();
}

/** Wait until Gemini has finished transcription, correction, and summary without a human gate. */
export async function finishProcessing(page: Page, timeout: number) {
  const status = page.getByTestId("job-status");
  await expect(status).toContainText("ถอดเสียงเสร็จแล้ว", { timeout });
  await expect(page.locator("dialog.clarify-dlg")).toHaveCount(0);
}
