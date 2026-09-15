import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { DEMO_VIDEO, login, row, SAMPLES, watchErrors } from "./helpers";

test.describe.configure({ mode: "serial" });

test("upload a video, watch it process, then use player, transcript, summary and downloads", async ({ page }, info) => {
  const errors = watchErrors(page);
  await login(page);
  const name = path.basename(DEMO_VIDEO);
  const before = await page.getByTestId("job-row").filter({ hasText: name }).count();

  // ---- the upload area has no options: clicking anywhere in it opens the file picker
  await expect(page.getByTestId("drop").locator("select")).toHaveCount(0);
  await expect(page.getByTestId("drop").getByRole("button")).toHaveText(["เลือกไฟล์วิดีโอ"]);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByTestId("drop").locator(".drop-title").click()]);
  await chooser.setFiles(DEMO_VIDEO);
  const r = page.getByTestId("job-row").filter({ hasText: name }).first();
  await expect(page.getByTestId("job-row").filter({ hasText: name })).toHaveCount(before + 1);
  await expect(page.getByTestId("toast").filter({ hasText: "อัปโหลด" })).toBeVisible({ timeout: 60_000 });
  await expect(r.locator(".pill")).toContainText(/กำลังถอดเสียง|เสร็จแล้ว/);
  await expect(page.getByTestId("bell-count")).toBeVisible();

  // ---- open the job while it is still processing: player is usable, steps are shown
  await r.locator(".job-title").click();
  await expect(page).toHaveURL(/\/jobs\//);
  const jobUrl = page.url();
  await expect(page.getByTestId("job-title")).toHaveText(name);
  const video = page.getByTestId("video");
  await expect(video).toBeVisible();
  await expect(page.getByTestId("proc")).toBeVisible();
  await expect(page.getByTestId("summary-waiting")).toBeVisible();
  await page.screenshot({ path: info.outputPath("job-processing.png") });

  // ---- wait for transcript + summary (real ElevenLabs + Gemini: minutes; fixture mode: seconds)
  const started = Date.now();
  await expect(page.getByTestId("job-status")).toContainText("ถอดเสียงเสร็จแล้ว", { timeout: info.timeout - 60_000 });
  info.annotations.push({ type: "processing-seconds", description: String(Math.round((Date.now() - started) / 1000)) });

  const lines = page.getByTestId("transcript").locator(".seg");
  const n = await lines.count();
  expect(n).toBeGreaterThan(2);
  // The transcript arrived while this page was open and the video sits at 0:00: a line starting at exactly 0 s is active.
  // (ElevenLabs lines start at the first word, e.g. 0.04 s, which still reads "00:00" but is not active yet at 0 s.)
  const detail = await (await page.request.get(`/api/jobs/${jobUrl.split("/").pop()}`)).json();
  if (detail.segments[0]?.start === 0) {
    await expect(lines.first()).toHaveClass(/\bon\b/);
    await expect(page.getByTestId("ov-chip")).not.toContainText("ไม่มีเสียงพูด");
  }
  const speakers = page.getByTestId("speakers").locator(".spk");
  expect(await speakers.count()).toBeGreaterThan(0);
  await expect(page.getByTestId("lanes").locator(".lane-track i").first()).toBeAttached();
  for (let i = 1; i < n; i++) {
    // segments are chronological
    const [a, b] = await Promise.all([lines.nth(i - 1).locator(".seg-time").innerText(), lines.nth(i).locator(".seg-time").innerText()]);
    expect(a <= b || a.length < b.length).toBeTruthy();
  }

  // ---- the media is real and seekable: click a later line, playback moves there
  const target = lines.nth(Math.min(3, n - 1));
  const targetTime = await target.locator(".seg-time").innerText();
  await target.click();
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(0);
  await expect(target).toHaveClass(/\bon\b/, { timeout: 20_000 });
  await expect(page.getByTestId("caption")).toBeVisible();
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  // follow-along: one word is marked as being said, in the caption and in the transcript, and it moves on
  const caption = page.getByTestId("caption");
  await expect(caption.locator(".kw-now")).toBeVisible();
  await expect(page.getByTestId("transcript").locator(".seg.on .kw-now")).toBeVisible();
  const saidBefore = await caption.locator(".kw-said").count();
  await expect.poll(() => caption.locator(".kw-said").count(), { timeout: 10_000 }).toBeGreaterThan(saidBefore);
  await page.screenshot({ path: info.outputPath("follow-along.png") });
  await page.getByTestId("c-play").click();
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
  info.annotations.push({ type: "seeked-to", description: targetTime });

  // keyboard: arrow right skips 5 s
  const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await page.locator("body").press("ArrowRight");
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(t0 + 4);

  // ---- search highlights matches
  const firstText = (await lines.first().locator(".seg-text").innerText()).trim();
  const word = firstText.split(/\s+/).find((w) => w.length >= 3) ?? firstText.slice(0, 3);
  await page.getByTestId("tx-search").fill(word);
  await expect(page.getByTestId("tx-found")).toContainText("พบ");
  await expect(page.getByTestId("transcript").locator("mark").first()).toHaveText(word);
  await page.getByTestId("tx-search").fill("");

  // ---- rename a speaker; it sticks after reload
  const newName = `คุณทดสอบ ${Date.now() % 1000}`;
  await page.locator('[data-rename="0"]').click();
  await page.locator("#rn-0").fill(newName);
  await page.locator("#rn-0").press("Enter");
  await expect(page.getByTestId("toast").filter({ hasText: newName })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("speakers").locator(".spk").first()).toContainText(newName);
  await expect(page.getByTestId("transcript")).toContainText(newName);

  // ---- transcript download (.txt and .csv)
  await page.getByTestId("btn-download").click();
  const dlg = page.locator("dialog.dlg");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator("#dlg-prev")).toHaveValue(new RegExp(newName));
  const [txt] = await Promise.all([page.waitForEvent("download"), page.getByTestId("dlg-go").click()]);
  const txtPath = info.outputPath("transcript.txt");
  await txt.saveAs(txtPath);
  const txtBody = fs.readFileSync(txtPath, "utf8");
  expect(txt.suggestedFilename()).toMatch(/\.txt$/);
  expect(txtBody).toContain(newName);
  expect(txtBody.split("\n\n").length).toBeGreaterThan(3);

  await page.getByTestId("btn-download").click();
  await dlg.getByText(".csv").click();
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByTestId("dlg-go").click()]);
  const csvPath = info.outputPath("transcript.csv");
  await csv.saveAs(csvPath);
  expect(fs.readFileSync(csvPath, "utf8").split("\r\n")[0]).toContain("ผู้พูด");

  // ---- meeting summary sits under the transcript (no tabs) and scrolls inside its own box
  const summary = page.getByTestId("summary");
  await expect(summary).toBeVisible();
  await expect(page.getByTestId("transcript")).toBeVisible();
  const box = await page.getByTestId("summary-scroll").evaluate((el) => ({
    scrolls: el.scrollHeight > el.clientHeight + 20,
    height: el.closest(".sum-card")!.getBoundingClientRect().height,
    viewport: window.innerHeight,
  }));
  expect(box.scrolls).toBe(true);
  expect(box.height).toBeLessThan(box.viewport / 2);
  await page.screenshot({ path: info.outputPath("job-done.png") });
  await expect(summary.locator(".sum-title")).not.toBeEmpty();
  await expect(summary.getByText("ลำดับการประชุม")).toBeVisible();
  await expect(summary.getByText("ข้อสั่งการ / สิ่งที่ต้องดำเนินการ")).toBeVisible();
  const [sumDl] = await Promise.all([page.waitForEvent("download"), summary.getByRole("button", { name: "ดาวน์โหลด .txt" }).click()]);
  const sumPath = info.outputPath("summary.txt");
  await sumDl.saveAs(sumPath);
  const sumBody = fs.readFileSync(sumPath, "utf8");
  expect(sumBody).toContain("ลำดับการประชุม");
  expect(sumBody).not.toMatch(/\*\*|^#/m); // plain text, not Markdown
  // the same file from the page header button
  const [headDl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("btn-download-summary").click()]);
  expect(headDl.suggestedFilename()).toMatch(/สรุปการประชุม\.txt$/);
  const headPath = info.outputPath("summary-header.txt");
  await headDl.saveAs(headPath);
  expect(fs.readFileSync(headPath, "utf8")).toBe(sumBody);
  // the correction log (edits applied by the script, names waiting for confirmation) downloads as plain text
  const [chg] = await Promise.all([page.waitForEvent("download"), page.getByTestId("dl-changes").click()]);
  expect(chg.suggestedFilename()).toMatch(/บันทึกการตรวจแก้\.txt$/);
  const chgPath = info.outputPath("changes.txt");
  await chg.saveAs(chgPath);
  expect(fs.readFileSync(chgPath, "utf8")).toMatch(/^ผลตรวจแก้ข้อความ .+ ด้วย \S+\nแก้แล้ว \d+ จุด/);
  // clicking a timestamp in the summary seeks the video
  await summary.locator(".stamp").first().click();
  await expect.poll(async () => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  await page.getByTestId("c-play").click();

  // ---- back to the library: row is done and offers download
  await page.getByRole("link", { name: "งานถอดเสียงทั้งหมด" }).click();
  const doneRow = page.locator(`#row-${jobUrl.split("/").pop()}`);
  await expect(doneRow.locator(".pill")).toContainText("เสร็จแล้ว");
  await expect(doneRow.getByRole("button", { name: /ดาวน์โหลดทรานสคริปต์/ })).toBeEnabled();
  await page.getByRole("button", { name: /เสร็จแล้ว/ }).click();
  await expect(row(page, name)).toBeVisible();

  await page.screenshot({ path: info.outputPath("library-done.png"), fullPage: true });

  // ---- library search: a word said in the video finds the job and shows where it was said
  const jobId = jobUrl.split("/").pop()!;
  const thisRow = page.locator(`#row-${jobId}`);
  await page.getByRole("button", { name: /^ทั้งหมด/ }).click();
  await page.getByTestId("lib-search").fill(word);
  await expect(page).toHaveURL(/[?&]q=/);
  const hit = thisRow.getByTestId("job-hit");
  await expect(hit).toBeVisible();
  await expect(hit.locator("mark").first()).toHaveText(word);
  await expect(page.getByTestId("lib-result")).toContainText("พบ");
  await page.screenshot({ path: info.outputPath("library-search.png") });

  // nothing matches: a helpful empty state with one click to clear
  await page.getByTestId("lib-search").fill("ไม่มีคำนี้ในงานใดเลย xyz");
  await expect(page.getByTestId("lib-empty")).toContainText("ไม่พบงาน");
  await page.getByTestId("lib-empty").getByRole("button", { name: "ล้างตัวกรอง" }).click();
  await expect(page.getByTestId("lib-search")).toHaveValue("");
  await expect(thisRow).toBeVisible();

  // date range: today keeps it, a range in the past hides everything
  await page.getByTestId("lib-range").selectOption("today");
  await expect(thisRow).toBeVisible();
  await page.getByTestId("lib-range").selectOption("custom");
  await page.getByTestId("lib-from").fill("2020-01-01");
  await page.getByTestId("lib-to").fill("2020-01-31");
  await expect(page.getByTestId("lib-empty")).toContainText("ไม่มีงานในช่วงเวลานี้");
  await page.getByRole("button", { name: "ล้างตัวกรองทั้งหมด" }).click();
  await expect(thisRow).toBeVisible();

  // sort by file name
  await page.getByTestId("lib-sort").selectOption("name");
  await expect(page).toHaveURL(/sort=name/);
  const names = await page.getByTestId("job-row").locator(".job-title").allInnerTexts();
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "th")));

  // a hit opens the job at that line with the word highlighted; going back restores the search
  await page.getByTestId("lib-search").fill(word);
  await thisRow.getByTestId("job-hit").click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${jobId}\\?q=`));
  await expect(page.getByTestId("tx-search")).toHaveValue(word);
  await expect(page.getByTestId("transcript").locator(".seg.on mark").first()).toHaveText(word);
  await page.getByRole("link", { name: "งานถอดเสียงทั้งหมด" }).click();
  await expect(page.getByTestId("lib-search")).toHaveValue(word);
  await expect(thisRow.getByTestId("job-hit")).toBeVisible();

  expect(errors).toEqual([]);
});

test("rejects non-video files and reports videos without audio", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);

  await page.locator("#file-in").setInputFiles(path.join(SAMPLES, "e2e_not_video.txt"));
  await expect(page.getByTestId("toast").filter({ hasText: "ไม่ใช่ไฟล์วิดีโอ" })).toBeVisible();

  // drag and drop onto the upload area
  const bytes = fs.readFileSync(path.join(SAMPLES, "e2e_no_audio.mp4")).toString("base64");
  await page.getByTestId("drop").evaluate((zone, b64) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([data], "e2e_no_audio.mp4", { type: "video/mp4" }));
    for (const type of ["dragenter", "dragover", "drop"]) zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, bytes);
  const r = row(page, "e2e_no_audio.mp4");
  await expect(r.locator(".pill")).toContainText("ไม่สำเร็จ", { timeout: 60_000 });
  await expect(r).toContainText("ไม่พบเสียงพูดในไฟล์");
  await page.getByRole("button", { name: /^ไม่สำเร็จ/ }).click();
  await expect(r).toBeVisible();

  // retry runs the pipeline again and fails the same way
  await r.getByRole("button", { name: "ลองอีกครั้ง" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "เริ่มถอดเสียง" })).toBeVisible();
  await expect(r.locator(".pill")).toContainText("ไม่สำเร็จ", { timeout: 60_000 });

  // failed jobs can be removed
  await r.getByRole("button", { name: /ลบงาน/ }).click();
  await expect(row(page, "e2e_no_audio.mp4")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("cancel an upload in progress", async ({ page }) => {
  await login(page);
  // Slow the upload down so there is time to cancel it.
  await page.route("**/api/jobs/*/file", async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue();
  });
  await page.locator("#file-in").setInputFiles(DEMO_VIDEO);
  const r = page.locator('[data-testid="job-row"][data-status="uploading"]').first();
  await expect(r).toBeVisible();
  const id = (await r.getAttribute("id"))!.replace("row-", "");
  await r.getByRole("button", { name: "ยกเลิก" }).click();
  await expect(page.getByTestId("toast").filter({ hasText: "ยกเลิกการอัปโหลด" })).toBeVisible();
  await expect(page.locator(`#row-${id}`)).toHaveCount(0);
  await page.reload();
  await expect(page.locator(`#row-${id}`)).toHaveCount(0);
});

test("uploads larger than 10 MB arrive intact", async ({ page }, info) => {
  // Regression: the /api rewrite truncated request bodies at 10 MB. A silent video fails at the
  // "no audio" check only after the whole file was received and probed, so no ElevenLabs call is made.
  const file = info.outputPath("e2e_large_silent.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
    "-t", "20", "-c:v", "libx264", "-preset", "ultrafast", "-b:v", "10M", "-an", file]);
  const size = fs.statSync(file).size;
  expect(size).toBeGreaterThan(15 * 1024 * 1024);

  const errors = watchErrors(page);
  await login(page);
  await page.locator("#file-in").setInputFiles(file);
  const r = row(page, "e2e_large_silent.mp4");
  await expect(r.locator(".pill")).toContainText("ไม่สำเร็จ", { timeout: 120_000 });
  await expect(r).toContainText("ไม่พบเสียงพูดในไฟล์");

  const { jobs }: { jobs: { name: string; size_bytes: number }[] } = await (await page.request.get("/api/jobs")).json();
  expect(jobs.find((j) => j.name === "e2e_large_silent.mp4")?.size_bytes).toBe(size);

  await r.getByRole("button", { name: /ลบงาน/ }).click();
  await expect(row(page, "e2e_large_silent.mp4")).toHaveCount(0);
  expect(errors).toEqual([]);
});
