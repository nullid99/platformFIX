import { test, expect } from "@playwright/test";
import { CURATOR_STATE, STUDENT_STATE } from "./auth-state";

/**
 * The platform's core value loop: a curator publishes homework, a student answers it,
 * the curator reviews and accepts it, and the student sees the accepted result.
 * This is the single most important flow to keep green — if this breaks, the product
 * doesn't work, no matter how healthy every individual page looks in isolation.
 */
test("curator publishes an assignment, student submits it, curator accepts it, student sees it accepted", async ({ browser }) => {
  test.setTimeout(60_000);
  const uniqueTitle = `E2E задание ${Date.now()}`;
  const studentAnswer = `E2E ответ ученика ${Date.now()}`;

  const curatorContext = await browser.newContext({ storageState: CURATOR_STATE });
  const studentContext = await browser.newContext({ storageState: STUDENT_STATE });
  const curatorPage = await curatorContext.newPage();
  const studentPage = await studentContext.newPage();
  let createdAssignmentId: string | null = null;

  try {
    // 1. Curator publishes a new assignment.
    await curatorPage.goto("/");
    await curatorPage.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: "Создать задание" }).click();
    await curatorPage.getByPlaceholder("Например, Разметка зон на истории").fill(uniqueTitle);
    await curatorPage.getByPlaceholder("Объясни, что ученик должен сделать и зачем это нужно в системе…").fill("E2E: описание задания для автотеста.");
    await curatorPage.getByPlaceholder("Добавить критерий проверки").first().fill("E2E: критерий проверки");

    const publishButton = curatorPage.getByRole("button", { name: "Опубликовать задание" });
    await expect(publishButton).toBeEnabled({ timeout: 15_000 });
    await publishButton.click();
    await expect(curatorPage.getByRole("heading", { name: "Задание опубликовано" })).toBeVisible();

    // Grabbed now (not deferred to `finally`) since this is the one point in the flow
    // where the assignment is guaranteed to exist and be uniquely identifiable by title —
    // needed so teardown can archive it out of the shared dev database regardless of how
    // the rest of the test finishes.
    const manageResponse = await curatorPage.request.get("/api/assignments/manage");
    const managePayload = await manageResponse.json() as { data?: Array<{ id: string; title: string }> };
    createdAssignmentId = managePayload.data?.find((assignment) => assignment.title === uniqueTitle)?.id ?? null;

    // 2. Student finds the assignment and submits an answer.
    await studentPage.goto("/");
    await studentPage.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: "Задания", exact: true }).click();
    await studentPage.getByRole("button", { name: new RegExp(uniqueTitle) }).click();
    await studentPage.getByLabel("ТВОЙ КОММЕНТАРИЙ").fill(studentAnswer);
    await studentPage.getByRole("button", { name: "Отправить на проверку" }).click();
    await expect(studentPage.getByText("Работа отправлена куратору")).toBeVisible();

    // 3. Curator finds the submission in the review queue, claims it, checks off a
    // review criterion (advisory only — not required to accept), and accepts it.
    await curatorPage.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: "Очередь проверки" }).click();
    await curatorPage.getByRole("button", { name: new RegExp(uniqueTitle) }).click();
    await expect(curatorPage.getByText(studentAnswer)).toBeVisible();
    await curatorPage.getByRole("button", { name: "Взять на проверку" }).click();
    await expect(curatorPage.getByText("Работа закреплена за вами.")).toBeVisible({ timeout: 10_000 });

    // The checkbox is a visually custom-styled control wrapped in its <label> — clicking
    // the label's own text (as a user naturally would) toggles it reliably; clicking the
    // underlying role=checkbox input directly does not register here.
    const criteriaCheckbox = curatorPage.getByRole("checkbox", { name: "E2E: критерий проверки" });
    await curatorPage.getByText("E2E: критерий проверки").click();
    await expect(criteriaCheckbox).toBeChecked();

    const acceptButton = curatorPage.getByRole("button", { name: "Принять работу" });
    await expect(acceptButton).toBeEnabled();
    await acceptButton.click();
    await expect(curatorPage.getByText("Работа уже принята")).toBeVisible({ timeout: 10_000 });

    // 4. Student reloads and sees the accepted status.
    await studentPage.reload();
    await studentPage.getByRole("navigation", { name: "Основная навигация" }).getByRole("button", { name: "Задания", exact: true }).click();
    const acceptedRow = studentPage.getByRole("button", { name: new RegExp(uniqueTitle) });
    await expect(acceptedRow).toBeVisible({ timeout: 15_000 });
    await expect(acceptedRow.getByText("Принято")).toBeVisible();
  } finally {
    // The assignment (and its published, accepted submission) is real data in the shared
    // dev database, visible to whoever browses the course as curator or student — archive
    // it so repeated local test runs don't pile up as "E2E задание …" clutter.
    if (createdAssignmentId) await curatorPage.request.delete(`/api/assignments/${createdAssignmentId}`).catch(() => undefined);
    await curatorContext.close();
    await studentContext.close();
  }
});
