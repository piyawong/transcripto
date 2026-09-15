import { expect, test } from "@playwright/test";
import { login, watchErrors } from "./helpers";

test("protected pages redirect to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "เข้าสู่ระบบ" })).toBeVisible();
});

test("login validates input, rejects a wrong password, then signs in and out", async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto("/login");

  // email + password only: no Google, sign-up, password reset or demo account
  await expect(page.getByRole("button", { name: /Google/ })).toHaveCount(0);
  await expect(page.getByText(/สมัคร|ลืมรหัสผ่าน|บัญชีทดลอง/)).toHaveCount(0);

  await page.locator("#email").fill("not-an-email");
  await page.locator("#password").fill("short");
  await page.getByTestId("btn-login").click();
  await expect(page.getByText("รูปแบบอีเมลไม่ถูกต้อง")).toBeVisible();
  await expect(page.getByText("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร")).toBeVisible();

  await page.locator("#email").fill("admin@transcripto.app");
  await page.locator("#password").fill("wrong-password");
  await page.getByTestId("btn-login").click();
  await expect(page.getByText("อีเมลหรือรหัสผ่านไม่ถูกต้อง")).toBeVisible();

  // show / hide password
  await page.getByRole("button", { name: "แสดงรหัสผ่าน" }).click();
  await expect(page.locator("#password")).toHaveAttribute("type", "text");

  // "Powered by Pichvara" links to pichvara.com in a new tab, on the sign-in page and inside the app
  const credit = page.getByTestId("powered-by");
  await expect(credit).toHaveAttribute("href", "https://pichvara.com");
  await expect(credit).toHaveAttribute("target", "_blank");
  await expect(credit.getByRole("img", { name: "Pichvara" })).toBeVisible();

  await login(page);
  await expect(page.getByTestId("powered-by")).toHaveAttribute("href", "https://pichvara.com");
  await expect(page.getByText(/โควตา/)).toHaveCount(0);
  await page.getByRole("button", { name: /บัญชีของ/ }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["ตั้งค่า", "ออกจากระบบ"]);
  await page.getByRole("menuitem", { name: "ออกจากระบบ" }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  // the wrong-password attempt is logged by the browser as a failed 400 request; nothing else may appear
  expect(errors.filter((e) => !e.includes("400 (Bad Request)"))).toEqual([]);
});

test("sign-up and password reset no longer exist", async ({ page, request }) => {
  for (const path of ["/signup", "/reset-password"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
  }
  for (const path of ["/api/auth/signup", "/api/auth/forgot", "/api/auth/reset"]) {
    const res = await request.post(path, { data: {} });
    expect([404, 405], path).toContain(res.status());
  }
});
