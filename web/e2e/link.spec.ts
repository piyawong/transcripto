import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DEMO_VIDEO, finishProcessing, login, row, SAMPLES, watchErrors } from "./helpers";

// Jobs created from a link: the API downloads the video with yt-dlp. The videos come from a server on 127.0.0.1 started
// here, so the API must allow private hosts (scripts/dev.sh --fixture sets URL_IMPORT_ALLOW_PRIVATE=1) and have yt-dlp.

test.describe.configure({ mode: "serial" });

let server: http.Server;
let base = "";
/** When connections to /slow/… closed before the whole file was sent (yt-dlp -J closes one on purpose, a cancel another). */
const cutShort: number[] = [];

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const slow = url.pathname.startsWith("/slow/");
    const file = path.join(SAMPLES, path.basename(url.pathname));
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    const type = file.endsWith(".mp4") ? "video/mp4" : "text/plain";
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Number(m[2]) : size - 1;
    res.writeHead(m ? 206 : 200, {
      "content-type": type,
      "content-length": end - start + 1,
      "accept-ranges": "bytes",
      ...(m ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    if (!slow) {
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    // 16 KB every 250 ms: a 1.4 MB video takes about 20 s.
    const fd = fs.openSync(file, "r");
    let at = start;
    const timer = setInterval(() => {
      const n = Math.min(16 * 1024, end + 1 - at);
      if (n <= 0) {
        clearInterval(timer);
        fs.closeSync(fd);
        res.end();
        return;
      }
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, at);
      at += n;
      res.write(buf);
    }, 250);
    res.on("close", () => {
      if (at <= end) {
        clearInterval(timer);
        fs.closeSync(fd);
        cutShort.push(Date.now());
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  server.closeAllConnections();
  server.close();
});

test("import a video from a link: the server downloads it, then it plays and is transcribed like an upload", async ({ page }, info) => {
  const errors = watchErrors(page);
  await login(page);
  const name = path.basename(DEMO_VIDEO);

  // the link field lives inside the upload area, but clicking it must not open the file picker
  const chooser = page.waitForEvent("filechooser", { timeout: 1500 }).then(
    () => true,
    () => false,
  );
  await page.getByTestId("link-input").click();
  expect(await chooser).toBe(false);
  await expect(page.getByTestId("link-submit")).toBeDisabled();

  // not a link: rejected before a job exists
  await page.getByTestId("link-input").fill("youtube.com/watch?v=abc");
  await page.getByTestId("link-submit").click();
  await expect(page.getByTestId("toast").filter({ hasText: "ลิงก์ไม่ถูกต้อง" })).toBeVisible();

  const before = await page.getByTestId("job-row").count();
  await page.getByTestId("link-input").fill(`${base}/${name}?token=secret`);
  await page.getByTestId("link-input").press("Enter");
  await expect(page.getByTestId("toast").filter({ hasText: "กำลังดาวน์โหลดวิดีโอจากลิงก์" })).toBeVisible();
  await expect(page.getByTestId("link-input")).toHaveValue("");
  await expect(page.getByTestId("job-row")).toHaveCount(before + 1);
  const r = row(page, name);
  await expect(r).toContainText("127.0.0.1");
  // the job only becomes playable once the download is stored
  await expect(page.getByTestId("toast").filter({ hasText: "จากลิงก์เสร็จแล้ว" })).toBeVisible({ timeout: 60_000 });
  await expect(r.locator(".pill")).toContainText(/กำลังถอดเสียง|เสร็จแล้ว/);
  await expect(r.locator(".job-meta")).toContainText("MB");

  const id = (await r.getAttribute("id"))!.replace("row-", "");
  const job = await (await page.request.get(`/api/jobs/${id}`)).json();
  expect(job.downloading).toBe(false);
  expect(job.source_host).toBe("127.0.0.1");
  expect(job.name).toBe(name);
  expect(job.size_bytes).toBe(fs.statSync(DEMO_VIDEO).size);
  // the full link (with its token) is never sent back
  expect(JSON.stringify(job)).not.toContain("secret");
  const media = await page.request.get(`/api/jobs/${id}/media`, { headers: { range: "bytes=0-99" } });
  expect(media.status()).toBe(206);
  expect((await media.body()).length).toBe(100);

  await r.locator(".job-title").click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${id}`));
  const video = page.getByTestId("video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.duration), { timeout: 20_000 }).toBeGreaterThan(100);
  await finishProcessing(page, info.timeout - 60_000);
  expect(await page.getByTestId("transcript").locator(".seg").count()).toBeGreaterThan(2);
  await page.screenshot({ path: info.outputPath("link-job.png") });

  await page.request.delete(`/api/jobs/${id}`);
  // the rejected link above is the only failed request
  expect(errors.filter((e) => !e.includes("400 (Bad Request)"))).toEqual([]);
});

test("a link without a video fails with a clear message; dropping a link onto the upload area works too", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  const link = `${base}/e2e_not_video.txt`;
  await page.getByTestId("drop").evaluate((zone, text) => {
    const dt = new DataTransfer();
    dt.setData("text/uri-list", text);
    for (const type of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, link);
  // named after the file in the link, then after what the page calls itself
  const r = row(page, "e2e_not_video");
  await expect(r.locator(".pill")).toContainText("ไม่สำเร็จ", { timeout: 60_000 });
  await expect(r).toContainText("ไม่พบวิดีโอในลิงก์นี้");
  await expect(r.getByRole("button", { name: "ลองอีกครั้ง" })).toBeVisible();
  await expect(r.locator(".thumb-play")).toHaveCount(0);

  // retry downloads again (and fails the same way)
  await r.getByRole("button", { name: "ลองอีกครั้ง" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "เริ่มถอดเสียง" })).toBeVisible();
  await expect(r.locator(".pill")).toContainText("ไม่สำเร็จ", { timeout: 60_000 });
  await r.getByRole("button", { name: /ลบงาน/ }).click();
  await expect(row(page, "e2e_not_video")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("cancel a download in progress: the server stops downloading", async ({ page }) => {
  await login(page);
  await page.getByTestId("link-input").fill(`${base}/slow/${path.basename(DEMO_VIDEO)}`);
  await page.getByTestId("link-submit").click();
  const r = page.locator('[data-testid="job-row"]').filter({ hasText: "กำลังดาวน์โหลด" }).first();
  await expect(r).toBeVisible();
  // real progress from the server before cancelling
  await expect(r.locator(".pipe-label")).toContainText("%", { timeout: 20_000 });
  const id = (await r.getAttribute("id"))!.replace("row-", "");
  // not openable while downloading
  await expect(r.locator(".thumb-play")).toHaveCount(0);
  await page.goto(`/jobs/${id}`);
  await expect(page.getByTestId("toast").filter({ hasText: "รอให้ดาวน์โหลดวิดีโอจากลิงก์เสร็จก่อน" }).first()).toBeVisible();
  await expect(page).toHaveURL(/\/$/);

  const cancelledAt = Date.now();
  await page.locator(`#row-${id}`).getByRole("button", { name: "ยกเลิก" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "ยกเลิกการดาวน์โหลด" })).toBeVisible();
  await expect(page.locator(`#row-${id}`)).toHaveCount(0);
  // the worker notices within a heartbeat and kills yt-dlp, which closes the connection mid-file
  await expect.poll(() => cutShort.filter((t) => t >= cancelledAt).length, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator(`#row-${id}`)).toHaveCount(0);
});
