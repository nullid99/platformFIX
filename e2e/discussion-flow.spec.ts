import { exec } from "node:child_process";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { CURATOR_STATE, STUDENT_STATE } from "./auth-state";

const execAsync = promisify(exec);

/**
 * The platform's second core loop: a student asks a question from inside a lesson,
 * the curator answers it in the inbox, and the student sees the reply.
 */
test("student asks a question, curator replies, student sees the reply", async ({ browser }) => {
  test.setTimeout(60_000);
  const uniqueTitle = `E2E вопрос ${Date.now()}`;
  const questionBody = `E2E текст вопроса ${Date.now()}`;
  const replyBody = `E2E ответ куратора ${Date.now()}`;

  const curatorContext = await browser.newContext({ storageState: CURATOR_STATE });
  const studentContext = await browser.newContext({ storageState: STUDENT_STATE });
  const curatorPage = await curatorContext.newPage();
  const studentPage = await studentContext.newPage();
  let createdThreadId: string | null = null;

  try {
    // 1. Student opens the default module and asks a question from its Q&A card.
    await studentPage.goto("/");
    await studentPage.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: "Мой практикум", exact: true }).click();
    await studentPage.getByRole("button", { name: /Открыть урок|Продолжить обучение/ }).click();
    await studentPage.getByRole("button", { name: "Открыть обсуждение" }).click();

    await studentPage.getByPlaceholder("Например: Как определить точку входа в этом сценарии?").fill(uniqueTitle);
    await studentPage.getByPlaceholder("Опиши, что именно непонятно. Можно добавить уровни, таймфрейм и свои наблюдения…").fill(questionBody);
    await studentPage.getByRole("button", { name: "Задать вопрос" }).click();
    await expect(studentPage.getByRole("heading", { name: "Вопрос отправлен куратору" })).toBeVisible();

    // Grabbed now (not deferred to `finally`) since this is the one point where the
    // thread is guaranteed to exist and be uniquely identifiable by title — needed so
    // teardown can remove it from the shared dev database regardless of how the rest
    // of the test finishes. There's no close/archive that hides a discussion from the
    // curator's inbox (by design — real conversations stay visible as a history), so
    // this reaches into the database directly instead of via the API.
    const listResponse = await studentPage.request.get("/api/discussions");
    const listPayload = await listResponse.json() as { data?: Array<{ id: string; title: string }> };
    createdThreadId = listPayload.data?.find((thread) => thread.title === uniqueTitle)?.id ?? null;

    // 2. Curator finds the new thread in the inbox and replies.
    await curatorPage.goto("/");
    await curatorPage.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: "Обсуждения" }).click();
    await curatorPage.getByRole("button", { name: new RegExp(uniqueTitle) }).click();
    await expect(curatorPage.getByText(questionBody)).toBeVisible();
    await curatorPage.getByPlaceholder("Напишите ответ…").fill(replyBody);
    await curatorPage.getByRole("button", { name: "Отправить ответ" }).click();
    await expect(curatorPage.getByText(replyBody)).toBeVisible();

    // 3. Student sees the curator's reply. The student page is still sitting on the
    // "question submitted" confirmation card from step 1 — "Задать ещё вопрос" is the app's
    // own way of dismissing it and reaching the real (now-refreshed) thread list.
    await studentPage.getByRole("button", { name: "Задать ещё вопрос" }).click();
    await studentPage.getByRole("button", { name: new RegExp(uniqueTitle) }).click();
    await expect(studentPage.getByText(replyBody)).toBeVisible({ timeout: 10_000 });
  } finally {
    // The thread (with its real messages) is visible data in the shared dev database to
    // whoever browses as curator or student — remove it so repeated local test runs
    // don't pile up as "E2E вопрос …" clutter in the Обсуждения inbox. Run as a separate
    // `tsx` process rather than importing prisma here — Playwright's own TS transform
    // can't load the generated Prisma client's ESM output.
    if (createdThreadId && /^[a-z0-9]+$/i.test(createdThreadId)) {
      await execAsync(`npx tsx e2e/support/cleanup-discussion.ts ${createdThreadId}`).catch(() => undefined);
    }
    await curatorContext.close();
    await studentContext.close();
  }
});
