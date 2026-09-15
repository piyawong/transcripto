import { defineConfig } from "@playwright/test";

// Expects the stack to be running: `docker compose -p transcripto up -d db minio`, the API on :8010 and `npm run dev` on :3010.
// Real ElevenLabs + Gemini runs take minutes, so the timeout is generous; fixture mode (AI_FIXTURE_DIR) finishes in seconds.
export default defineConfig({
  testDir: "./e2e",
  timeout: Number(process.env.E2E_TIMEOUT_MS ?? 15 * 60_000),
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  outputDir: "e2e-results",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3010",
    // Google Chrome (not bundled Chromium) so H.264/AAC videos play like they do for users.
    channel: process.env.PW_CHANNEL ?? "chrome",
    viewport: { width: 1440, height: 960 },
    locale: "th-TH",
    acceptDownloads: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
