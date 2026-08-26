import { test as setup, expect } from "@playwright/test";
import { CURATOR_STATE, STUDENT_STATE } from "./auth-state";

setup("authenticate as curator", async ({ page }) => {
  const response = await page.request.post("/api/auth/dev-login", {
    data: { role: "CURATOR" },
    headers: { "X-Device-Name": "Playwright curator" },
  });
  expect(response.ok(), `Dev login failed for curator (${response.status()}) — is DEV_AUTH_ENABLED=true and are local test users bootstrapped?`).toBeTruthy();
  await page.context().storageState({ path: CURATOR_STATE });
});

setup("authenticate as student", async ({ page }) => {
  const response = await page.request.post("/api/auth/dev-login", {
    data: { role: "STUDENT" },
    headers: { "X-Device-Name": "Playwright student" },
  });
  expect(response.ok(), `Dev login failed for student (${response.status()}) — is DEV_AUTH_ENABLED=true and are local test users bootstrapped?`).toBeTruthy();
  await page.context().storageState({ path: STUDENT_STATE });
});
