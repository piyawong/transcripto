import { expect, test } from "@playwright/test";
import type { JobDetail, Minutes } from "../lib/api";

const minutes: Minutes = {
  title: "ประชุมทดสอบรูปแบบ", participants: [], overview: "",
  segments: [{
    kind: "report", speaker: "ผู้รายงาน", subject: "ผลการดำเนินงาน", responds_to: null,
    start: "01:00", end: "02:00", details: [], quotes: [],
    report_sections: [{ heading: "แผนพัฒนา", paragraphs: ["รายละเอียดรายงานครบถ้วน"], items: ["แผนที่หนึ่ง", "แผนที่สอง"], numbered: true }],
  }],
  action_items: [
    { task: "งานไม่ระบุผู้รับ", owner: null, requested_by: null, assigned_on: null, due: null, timestamps: [] },
    { task: "งานครั้งก่อน", owner: "คุณทดสอบ", requested_by: "ประธาน", assigned_on: "9 กรกฎาคม", due: null, timestamps: [] },
    { task: "งานครั้งถัดมา", owner: "คุณทดสอบ", requested_by: "ประธาน", assigned_on: "13 สิงหาคม", due: "20 สิงหาคม", timestamps: [] },
  ],
  needs_confirmation: [],
};

test("nested minutes, dated assignments and legacy summaries render without API writes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  const job: JobDetail = {
    id: "summary-format-fixture", name: "ประชุมทดสอบ.mp4", size_bytes: 1000,
    status: "done", stage: 2, stage_pct: 100, eta_sec: null, error: null,
    duration_sec: 120, has_video: false, has_thumb: false, speakers: [], segment_count: 0,
    summary_status: "done", summary_error: null, clarification_count: 0, downloading: false, source_host: null,
    created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z", finished_at: "2026-09-03T00:00:00Z",
    segments: [], has_changes: false, transcript_meta: null, summary: structuredClone(minutes),
    summary_text: "ข้อความดาวน์โหลดทดสอบ", summary_meta: null, summary_stale: false,
  };
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: "fixture", email: "fixture@example.test", name: "ทดสอบ" } } });
    if (path === "/api/jobs") return route.fulfill({ json: { jobs: [job] } });
    if (path === `/api/jobs/${job.id}`) return route.fulfill({ json: job });
    return route.fulfill({ status: 404, body: "fixture: no external requests" });
  });
  await page.goto(`/jobs/${job.id}`);
  const summary = page.getByTestId("summary");
  await expect(summary.getByRole("heading", { name: "วาระ: ผลการดำเนินงาน" })).toBeVisible();
  await expect(summary.locator(".sum-report-section h5")).toHaveText("แผนพัฒนา");
  await expect(summary.locator(".sum-report-section ol li")).toHaveText(["แผนที่หนึ่ง", "แผนที่สอง"]);
  await expect(summary.locator(".sum-actions > div")).toHaveCount(3);
  await expect(summary.getByText("งานที่ต้องดำเนินการ", { exact: true })).toBeVisible();
  await expect(summary.getByText("ฝากคุณทดสอบ เมื่อวันที่ 9 กรกฎาคม", { exact: true })).toBeVisible();
  await expect(summary.getByText("ฝากคุณทดสอบ เมื่อวันที่ 13 สิงหาคม", { exact: true })).toBeVisible();
  await expect(summary.getByRole("heading", { name: "สรุปงานที่ได้รับมอบหมาย" })).toBeVisible();
  await expect(summary.locator(".sum-title + .sum-overview")).toHaveCount(0);

  delete job.summary!.segments[0].report_sections;
  job.summary!.segments[0].details = ["ย่อหน้าจากสรุปรูปแบบเก่า"];
  await page.reload();
  await expect(summary.getByText("ย่อหน้าจากสรุปรูปแบบเก่า", { exact: true })).toBeVisible();
  await expect(summary.locator(".sum-report-section")).toHaveCount(0);
  expect(errors).toEqual([]);
});
