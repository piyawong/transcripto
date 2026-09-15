import { expect, test, type Page } from "@playwright/test";
import { login, watchErrors } from "./helpers";

async function paste(page: Page, text: string) {
  await page.getByTestId("kt-input").evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test("keyterms settings: add, validate, save, keep a draft, and restore", async ({ page }) => {
  const errors = watchErrors(page);
  await login(page);
  // Each user's own list; the test puts it back exactly as it found it.
  const original: { terms: string[]; is_default: boolean } = await (await page.request.get("/api/settings/keyterms")).json();
  const n = original.terms.length;
  try {
    // the library tells how many terms new uploads use, with a link to change them
    await expect(page.getByTestId("kt-lib")).toContainText(n ? `ใช้คำเฉพาะ ${n.toLocaleString()} คำ` : "ยังไม่มีคำเฉพาะ");

    await page.getByRole("button", { name: /บัญชีของ/ }).click();
    await page.getByRole("menuitem", { name: "ตั้งค่า" }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole("heading", { name: "คำเฉพาะสำหรับการถอดเสียง" })).toBeVisible();
    await expect(page.getByRole("note")).toContainText("อย่าใส่ชื่อคน");
    const count = page.getByTestId("kt-count");
    const bar = page.getByTestId("kt-savebar");
    await expect(count).toHaveText(n.toLocaleString());
    await expect(bar).toHaveCount(0);

    const input = page.getByTestId("kt-input");
    const term = `E2E คำทดสอบ ${Date.now() % 100000}`;
    await input.fill(term);
    await input.press("Enter");
    await expect(page.getByTestId("kt-list").getByText(term, { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");

    // a repeat (any letter case) and a term over 50 characters are not added; the long one stays in the box
    await input.fill(term.toLowerCase());
    await input.press("Enter");
    await expect(page.getByTestId("kt-error")).toContainText("มีอยู่แล้ว 1 คำ");
    await input.fill("ก".repeat(51));
    await expect(page.getByTestId("kt-add")).toBeEnabled();
    await input.press("Enter");
    await expect(page.getByTestId("kt-error")).toContainText("ยาวเกิน 50 ตัวอักษร");
    await expect(input).toHaveValue("ก".repeat(51));
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("");

    // pasting several lines adds one term per line; removing a chip updates the count and the save bar
    await paste(page, "E2E-A\nE2E-B\n");
    await expect(count).toHaveText((n + 3).toLocaleString());
    await page.getByRole("button", { name: "ลบ “E2E-B”" }).click();
    await expect(count).toHaveText((n + 2).toLocaleString());
    await expect(bar).toContainText("+2");

    // cancel brings back the saved list
    await bar.getByRole("button", { name: "ยกเลิก" }).click();
    await expect(count).toHaveText(n.toLocaleString());
    await expect(bar).toHaveCount(0);

    // save, and it is still there after a reload
    await input.fill(term);
    await input.press("Enter");
    await page.getByTestId("kt-save").click();
    await expect(page.getByTestId("toast").filter({ hasText: "บันทึกคำเฉพาะ" })).toBeVisible();
    await expect(bar).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("kt-list").getByText(term, { exact: true })).toBeVisible();

    // an unsaved change survives leaving the page
    await page.getByRole("button", { name: `ลบ “${term}”` }).click();
    await page.getByRole("link", { name: "งานถอดเสียง" }).click();
    await expect(page.getByTestId("kt-lib")).toContainText(`ใช้คำเฉพาะ ${(n + 1).toLocaleString()} คำ`);
    await page.getByTestId("kt-lib").getByRole("link").click();
    await expect(page.getByRole("status")).toContainText("ยังไม่ได้บันทึก");
    await expect(count).toHaveText(n.toLocaleString());

    // "clear all" only changes the draft
    await page.getByRole("button", { name: "ลบทั้งหมด" }).click();
    await expect(page.getByTestId("kt-empty")).toBeVisible();
    await bar.getByRole("button", { name: "ยกเลิก" }).click();
    await expect(page.getByTestId("kt-list").getByText(term, { exact: true })).toBeVisible();

    // the API enforces the same rules
    const bad = await page.request.put("/api/settings/keyterms", { data: { terms: ["x".repeat(51)] } });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error).toContain("50 ตัวอักษร");
  } finally {
    if (original.is_default) await page.request.delete("/api/settings/keyterms");
    else await page.request.put("/api/settings/keyterms", { data: { terms: original.terms } });
    await page.evaluate(() => sessionStorage.clear()).catch(() => {});
  }
  expect(errors).toEqual([]);
});
