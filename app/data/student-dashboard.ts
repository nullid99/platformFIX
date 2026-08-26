import { calculatePracticumProgress } from "../domain/progress";

export type DashboardNav =
  | "Обзор"
  | "Мой практикум"
  | "Задания"
  | "Расписание"
  | "Стрим"
  | "Записи"
  | "Обсуждение";

export type AssignmentTone = "blue" | "amber" | "gray";
export type AssignmentStatus = "На проверке" | "Нужна доработка" | "Не начато" | "Принято";

export type Assignment = {
  id: string;
  title: string;
  module: string;
  lessonTitle?: string | null;
  coverPath?: string | null;
  status: AssignmentStatus;
  tone: AssignmentTone;
  date: string;
  deadline: string;
  description: string;
  /** Title of the previous module the student must finish first, or null if this assignment is open. Set by CourseService.markModuleCompletedForStudent. */
  blockedByModuleTitle?: string | null;
  requirements: readonly string[];
  materials?: readonly { id: string; kind: "LINK" | "FILE"; title: string; url?: string; mimeType?: string | null; byteSize?: number | null }[];
  submission?: {
    attempt: number;
    answerText: string | null;
    submittedAt: string | null;
    feedback: readonly { id: string; text: string; createdAt: string }[];
    files: readonly { id: string; originalName: string; mimeType: string; byteSize: number }[];
  };
  /** Every submitted attempt for this assignment, oldest first — includes revision rounds, not just the latest. */
  submissionHistory?: readonly {
    attempt: number;
    status: AssignmentStatus;
    answerText: string | null;
    submittedAt: string | null;
    feedback: readonly { id: string; text: string; createdAt: string }[];
    files: readonly { id: string; originalName: string; mimeType: string; byteSize: number }[];
  }[];
};

export type CourseModule = {
  id: string;
  number: string;
  title: string;
  status: string;
  progress: number;
  lessons: number;
  description: string;
  locked: boolean;
  coverPath?: string | null;
};

export type PracticumSection = "Welcome" | "Education" | "Q&A" | "Practice";
export type PracticumModule = CourseModule & { section: PracticumSection };

export const practicumModules = [
  { id: "welcome", section: "Welcome", number: "00", title: "Знакомство", status: "Завершён", progress: 100, lessons: 1, description: "Посмотри вводное видео, познакомься с форматом практикума и подготовь рабочее пространство.", locked: false },
  { id: "week-1", section: "Education", number: "01", title: "Market Logic", status: "В процессе", progress: 56, lessons: 4, description: "Разбираем логику движения рынка, контекст и последовательность наблюдений перед разметкой.", locked: false },
  { id: "week-2", section: "Education", number: "02", title: "Eq Point & Narrative. Storyline & Reversal", status: "Откроется после Week 1", progress: 0, lessons: 5, description: "Учимся собирать рыночный нарратив и замечать момент, когда сценарий теряет силу.", locked: true },
  { id: "week-3", section: "Education", number: "03", title: "Delivery A.B. Part 1&2", status: "Откроется после Week 2", progress: 0, lessons: 5, description: "Последовательно разбираем delivery и практикуем чтение движения цены по этапам.", locked: true },
  { id: "week-4", section: "Education", number: "04", title: "Delivery A.B. Part 3", status: "Откроется после Week 3", progress: 0, lessons: 4, description: "Закрепляем модель delivery на истории и готовим переход к самостоятельной практике.", locked: true },
  { id: "week-5", section: "Education", number: "05", title: "Entry Models. Q/A Session", status: "Откроется после Week 4", progress: 0, lessons: 5, description: "Собираем варианты входа и разбираем вопросы, которые возникают во время практики.", locked: true },
  { id: "qa", section: "Q&A", number: "06", title: "Ответы на вопросы", status: "Доступно", progress: 0, lessons: 1, description: "Сюда будут собираться ответы куратора на вопросы по урокам и торговой системе.", locked: false },
  { id: "pre-session", section: "Practice", number: "07", title: "Pre session", status: "Доступно", progress: 0, lessons: 1, description: "Подготовь наблюдения и рабочий план перед практической сессией.", locked: false },
  { id: "backtest", section: "Practice", number: "08", title: "Backtest", status: "Откроется после Education", progress: 0, lessons: 3, description: "Проверяем торговую систему на истории и фиксируем повторяющиеся сценарии.", locked: true },
  { id: "weekly-review", section: "Practice", number: "09", title: "Weekly performance review", status: "Откроется после Backtest", progress: 0, lessons: 1, description: "Подводим итоги недели, смотрим на решения и формируем следующий фокус практики.", locked: true },
] satisfies readonly PracticumModule[];

const practicumProgress = calculatePracticumProgress(practicumModules);

export type StreamKind = "Разбор" | "Стрим" | "Talks";

export type StreamItem = {
  id: string;
  title: string;
  kind: StreamKind;
  module: string;
  lesson: string;
  date: string;
  duration: string;
  progress: number;
  description: string;
  cover: string | null;
  isNew: boolean;
  embedUrl?: string | null;
};

export type ScheduleEventKind = "Практическая часть" | "Q&A" | "Разбор ДЗ" | "Бэктест";

export type ScheduleEvent = {
  id: string;
  date: string;
  day: string;
  month: string;
  weekday: string;
  type: ScheduleEventKind;
  title: string;
  time: string;
  live: boolean;
  description: string;
  recordingAvailable: boolean;
  recordingIds?: readonly string[];
  coverPath?: string;
  /** Only meaningful for type "Бэктест" — an individual slot claimed by at most one student. */
  bookedByStudentId?: string | null;
  bookedByStudentName?: string | null;
  isBookedByActor?: boolean;
};

export const studentDashboard = {
  learner: {
    name: "Алексей К.",
    initials: "АК",
    cohort: "Практикум 04",
    cohortNumber: "04",
  },
  focus: {
    title: "Разметка зон поддержки и сопротивления",
    subtitle: "Модуль 03 · Практика на истории",
    progress: 72,
  },
  modules: [
    { id: "context", number: "01", title: "Контекст и структура рынка", status: "Завершён", progress: 100, lessons: 6, description: "Базовая карта рынка, структура движения и рабочий контекст перед разметкой.", locked: false },
    { id: "scenarios", number: "02", title: "Сценарии движения цены", status: "Завершён", progress: 100, lessons: 5, description: "Как заранее описывать сценарий и не менять правила после появления позиции.", locked: false },
    { id: "zones", number: "03", title: "Зоны поддержки и сопротивления", status: "В процессе", progress: 72, lessons: 7, description: "Находим рабочие зоны, проверяем реакцию цены и готовим разметку к проверке.", locked: false },
    { id: "execution", number: "04", title: "Торговый план и исполнение", status: "Откроется после модуля 03", progress: 0, lessons: 6, description: "Соберём торговый план и переведём наблюдения в понятные правила исполнения.", locked: true },
  ] satisfies CourseModule[],
  progress: {
    practicum: `${practicumProgress}%`,
    weeklyChange: "+12% за неделю",
    assignmentsOnReview: "1",
    assignmentsDetail: "1 требует внимания",
    nextStream: "18 ч 42 мин",
    nextStreamDetail: "Практика · завтра в 19:00",
  },
  assignments: [
    {
      id: "zones-markup",
      title: "Разметка зон",
      module: "Модуль 03",
      status: "На проверке",
      tone: "blue",
      date: "Сегодня",
      deadline: "Сегодня, 23:59",
      description: "Покажи на истории, как ты находишь рабочие зоны и подтверждаешь сценарий до входа.",
      requirements: ["Выбрать два участка на EUR/USD", "Отметить границы зоны и реакцию цены", "Добавить короткое объяснение сценария"],
    },
    {
      id: "trade-review",
      title: "Разбор двух сделок",
      module: "Модуль 02",
      status: "Нужна доработка",
      tone: "amber",
      date: "Вчера",
      deadline: "Просрочено на 1 день",
      description: "Разбери две сделки по структуре: контекст, причина входа, управление и итог.",
      requirements: ["Добавить скриншот до входа", "Описать риск и точку отмены", "Сравнить план и фактическое исполнение"],
    },
    {
      id: "weekly-plan",
      title: "Торговый план на неделю",
      module: "Модуль 04",
      status: "Не начато",
      tone: "gray",
      date: "До 21 июля",
      deadline: "21 июля, 18:00",
      description: "Собери план наблюдения на неделю: инструменты, сценарии и условия, при которых ты не входишь в рынок.",
      requirements: ["Выбрать не более трёх инструментов", "Описать основной и альтернативный сценарий", "Зафиксировать лимит риска на день"],
    },
    {
      id: "entry-logic",
      title: "Логика входа в сделку",
      module: "Модуль 01",
      status: "Принято",
      tone: "blue",
      date: "18 июля",
      deadline: "Работа принята",
      description: "Закрепи базовый алгоритм входа и покажи, какие условия должны совпасть перед сделкой.",
      requirements: ["Сформулировать условия входа", "Привести один исторический пример", "Указать, где сценарий становится неактуальным"],
    },
  ] satisfies Assignment[],
  streams: [
    { id: "eur-zones", title: "Разбор зоны на EUR/USD", kind: "Разбор", module: "Модуль 03", lesson: "Разметка зон", date: "Сегодня", duration: "18:42", progress: 32, description: "Разбираем реакцию цены на зоне и последовательность подтверждений перед входом.", cover: "/fix-logo.jpg", isNew: true },
    { id: "live-practice", title: "Практика на живом рынке", kind: "Стрим", module: "Модуль 03", lesson: "Практика с куратором", date: "21 июля", duration: "1:24:08", progress: 0, description: "Запись практической части с разбором сценариев и вопросов участников потока.", cover: null, isNew: false },
    { id: "two-trades", title: "Разбор двух сделок", kind: "Разбор", module: "Модуль 02", lesson: "Разбор сделок", date: "19 июля", duration: "26:15", progress: 76, description: "Сравниваем план сделки с исполнением и отмечаем точку, где сценарий потерял силу.", cover: null, isNew: false },
    { id: "weekly-plan", title: "Как собрать торговый план", kind: "Разбор", module: "Модуль 04", lesson: "Торговый план на неделю", date: "17 июля", duration: "31:04", progress: 0, description: "Пошагово собираем план наблюдения на неделю и условия отмены сценария.", cover: null, isNew: false },
  ] satisfies StreamItem[],
  // Real events come from GET /api/schedule (ScheduleView / CuratorScheduleView fetch
  // them). This stays empty rather than seeded with demo rows — a demo event here used
  // to render as if it were a real, bookable event before the API response landed.
  events: [] as ScheduleEvent[],
  lastActivity: "Последняя активность: просмотрен разбор «Ложный пробой»",
} as const;
