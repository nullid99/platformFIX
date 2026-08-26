import { test, expect, type Page } from "@playwright/test";
import { CURATOR_STATE, STUDENT_STATE } from "./auth-state";

const CURATOR_NAV_ITEMS = [
  "Кабинет куратора",
  "Очередь проверки",
  "Создать задание",
  "Ученики",
  "Программа",
  "Приглашения",
  "Расписание",
  "Стримы",
  "Медиатека",
  "Обсуждения",
];

const STUDENT_NAV_ITEMS = [
  "Мой практикум",
  "Задания",
  "Расписание",
  "Стрим",
  "Записи",
  "Обсуждение",
];

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

test.describe("curator navigation smoke test", () => {
  test.use({ storageState: CURATOR_STATE });

  for (const label of CURATOR_NAV_ITEMS) {
    test(`«${label}» loads without errors`, async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.goto("/");
      // Scoped to the sidebar: the main content also has its own buttons/headings that
      // can repeat a nav label (e.g. a "Создать задание" quick-action on the dashboard),
      // and a nav item's accessible name includes its unread-count badge, if any.
      await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: label }).click();
      await expect(page.getByRole("heading", { name: label, exact: true, level: 1 })).toBeVisible();
      expect(errors, `console/page errors on «${label}»:\n${errors.join("\n")}`).toEqual([]);
    });
  }
});

test.describe("student navigation smoke test", () => {
  test.use({ storageState: STUDENT_STATE });

  for (const label of STUDENT_NAV_ITEMS) {
    test(`«${label}» loads without errors`, async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.goto("/");
      // Scoped to the sidebar: the main content also has its own buttons/headings that
      // can repeat a nav label (e.g. a "Создать задание" quick-action on the dashboard),
      // and a nav item's accessible name includes its unread-count badge, if any.
      await page.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: label }).click();
      await expect(page.getByRole("heading", { name: label, exact: true, level: 1 })).toBeVisible();
      expect(errors, `console/page errors on «${label}»:\n${errors.join("\n")}`).toEqual([]);
    });
  }
});
