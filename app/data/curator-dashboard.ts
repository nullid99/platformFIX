import type { AssignmentFeedback, AssignmentStatus, AssignmentTone } from "./student-dashboard";

export type CuratorNav = "Кабинет куратора" | "Очередь проверки" | "Создать задание" | "Ученики" | "Прогресс" | "Программа" | "Приглашения" | "Расписание" | "Стримы" | "Медиатека" | "Обсуждения" | "Команда";

export type ReviewQueueItem = {
  id: string;
  studentName: string;
  studentInitials: string;
  studentAvatarUrl?: string | null;
  studentIsAdvanced?: boolean;
  assignmentTitle: string;
  module: string;
  coverPath?: string | null;
  status: AssignmentStatus;
  tone: AssignmentTone;
  submittedAt: string;
  attempt: string;
  studentNote: string;
  answer: string;
  requirements?: readonly string[];
  attachments: readonly string[];
  attachmentFiles?: readonly { id: string; name: string; type: string; size: number; url: string }[];
  /** All submissions for this assignment/student pair, oldest first — each carries its own
   * answer/files/feedback so a resubmission's review can show what happened last round. */
  attemptHistory?: readonly {
    attempt: number;
    status: AssignmentStatus;
    submittedAt: string;
    answerText: string | null;
    files: readonly { id: string; name: string; type: string; size: number; url: string }[];
    feedback: readonly AssignmentFeedback[];
  }[];
  progress: string;
  reviewerId?: string | null;
  reviewerName?: string | null;
  /** False when reviewerId belongs to a different curator — disables deciding on this submission. */
  isReviewerSelf?: boolean;
  /** Accepted by this curator personally — what "Проверено вами" counts. */
  reviewedByMe?: boolean;
  /** A "ДЗ без проверки" the student marked done themselves — no curator involved. */
  selfCompleted?: boolean;
  claimedAt?: string | null;
  /** Requirement texts the curator had checked at decision time. Advisory only — not all need be checked to accept. */
  checkedRequirements?: readonly string[] | null;
};

export const curatorDashboard = {
  profile: {
    name: "Мария К.",
    initials: "МК",
    role: "Куратор",
  },
  cohort: {
    name: "Практикум 04",
    students: "18 учеников",
  },
  stats: {
    review: "4",
    reviewDetail: "2 пришли сегодня",
    revision: "3",
    revisionDetail: "Ждут учеников",
    progress: "76%",
    progressDetail: "Средний по потоку",
  },
  queue: [
    {
      id: "review-alexey-zones",
      studentName: "Алексей К.",
      studentInitials: "АК",
      assignmentTitle: "Разметка зон",
      module: "Урок 03",
      status: "На проверке",
      tone: "blue",
      submittedAt: "Сегодня, 10:42",
      attempt: "Попытка 1 из 2",
      studentNote: "Отметил две зоны на EUR/USD и добавил сценарий реакции цены.",
      answer: "В первой зоне дождался возврата к границе и подтверждения на младшем таймфрейме. Вторую зону оставил как альтернативный сценарий, если цена закрепится выше уровня.",
      attachments: ["eur-usd-markup.png", "scenario-note.pdf"],
      progress: "68%",
    },
    {
      id: "review-elena-trades",
      studentName: "Елена С.",
      studentInitials: "ЕС",
      assignmentTitle: "Разбор двух сделок",
      module: "Урок 02",
      status: "На проверке",
      tone: "blue",
      submittedAt: "Сегодня, 09:18",
      attempt: "Попытка 2 из 2",
      studentNote: "Переписала выводы после комментария по первой попытке.",
      answer: "Сравнила план с фактическим исполнением и отдельно вынесла ошибку раннего входа в первой сделке.",
      attachments: ["trade-review.pdf"],
      progress: "54%",
    },
    {
      id: "revision-ivan-plan",
      studentName: "Иван Р.",
      studentInitials: "ИР",
      assignmentTitle: "Торговый план на неделю",
      module: "Урок 04",
      status: "Нужна доработка",
      tone: "amber",
      submittedAt: "Вчера, 18:06",
      attempt: "Попытка 1 из 2",
      studentNote: "Жду уточнения по лимиту риска на день.",
      answer: "Выбрал три инструмента и составил основной сценарий на неделю. Альтернативный сценарий пока не добавил.",
      attachments: ["weekly-plan.pdf"],
      progress: "41%",
    },
  ] satisfies ReviewQueueItem[],
} as const;
