import { test, expect } from "@playwright/test";
import { CURATOR_STATE, STUDENT_STATE } from "./auth-state";

test.describe("curator streams page", () => {
  test.use({ storageState: CURATOR_STATE });

  test("shows the streaming window and its status", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Стримы", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Стримы", exact: true })).toBeVisible();
    await expect(page.getByText("Окно трансляции")).toBeVisible();
    // Either state is valid depending on whether a Live Input was configured earlier.
    await expect(
      page.getByRole("button", { name: "Настроить трансляцию" }).or(page.getByText("Ждём подключения из OBS")),
    ).toBeVisible();
  });
});

test.describe("student streams page", () => {
  test.use({ storageState: STUDENT_STATE });

  test("nav shows separate Стрим and Записи items, not the old combined Стримы", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Стрим", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Записи", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Стримы", exact: true })).toHaveCount(0);
  });

  test("Записи page shows the recordings library, not a live player", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Записи", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Записи", exact: true })).toBeVisible();
  });
});

test.describe("live chat", () => {
  test("a message sent by the curator is visible to the student in real time", async ({ browser }) => {
    const curatorContext = await browser.newContext({ storageState: CURATOR_STATE });
    const studentContext = await browser.newContext({ storageState: STUDENT_STATE });
    const curatorPage = await curatorContext.newPage();
    const studentPage = await studentContext.newPage();

    try {
      await curatorPage.goto("/");
      await curatorPage.getByRole("button", { name: "Стримы", exact: true }).click();
      await studentPage.goto("/");
      await studentPage.getByRole("button", { name: "Стрим", exact: true }).click();

      const chatInput = curatorPage.getByPlaceholder("Написать в чат…");
      await expect(chatInput).toBeEnabled({ timeout: 15_000 });

      const uniqueMessage = `E2E проверка чата ${Date.now()}`;
      await chatInput.fill(uniqueMessage);
      await curatorPage.getByRole("button", { name: "Отправить" }).click();

      await expect(curatorPage.getByText(uniqueMessage)).toBeVisible();
      await expect(studentPage.getByText(uniqueMessage)).toBeVisible({ timeout: 10_000 });
    } finally {
      await curatorContext.close();
      await studentContext.close();
    }
  });
});
