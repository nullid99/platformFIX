"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import {
  ArrowUpRight,
  ArrowLeft,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileCheck2,
  GraduationCap,
  LayoutDashboard,
  LockKeyhole,
  Maximize2,
  Menu,
  MessageSquareText,
  Play,
  Plus,
  Settings2,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { curatorDashboard, type CuratorNav, type ReviewQueueItem } from "./data/curator-dashboard";
import { practicumModules, studentDashboard, type Assignment, type AssignmentStatus, type DashboardNav, type PracticumSection, type ScheduleEvent, type StreamItem, type StreamKind, type TradeEntry, type TradeOutcome } from "./data/student-dashboard";

type UserRole = "student" | "curator";
type AppNav = DashboardNav | CuratorNav;

type NavItem = {
  label: AppNav;
  icon: typeof LayoutDashboard;
  badge?: string;
};

const navItems: NavItem[] = [
  { label: "Обзор", icon: LayoutDashboard },
  { label: "Мой практикум", icon: GraduationCap },
  { label: "Задания", icon: FileCheck2, badge: studentDashboard.progress.assignmentsOnReview },
  { label: "Торговый журнал", icon: BarChart3 },
  { label: "Расписание", icon: CalendarDays },
  { label: "Стримы", icon: Play },
  { label: "Обсуждение", icon: MessageSquareText },
];

const curatorNavItems: NavItem[] = [
  { label: "Кабинет куратора", icon: LayoutDashboard },
  { label: "Очередь проверки", icon: FileCheck2, badge: curatorDashboard.stats.review },
  { label: "Создать задание", icon: Plus },
  { label: "Ученики", icon: GraduationCap },
  { label: "Расписание", icon: CalendarDays },
  { label: "Медиатека", icon: Play },
];

export default function Home() {
  const [role, setRole] = useState<UserRole>("student");
  const [activeNav, setActiveNav] = useState<AppNav>("Обзор");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const currentNavItems = role === "student" ? navItems : curatorNavItems;
  const currentProfile = role === "student" ? studentDashboard.learner : curatorDashboard.profile;
  const openAssignments = studentDashboard.assignments.filter((assignment) => assignment.status !== "Принято");
  const acceptedAssignments = studentDashboard.assignments.length - openAssignments.length;
  const switchRole = (nextRole: UserRole) => {
    setRole(nextRole);
    setActiveNav(nextRole === "student" ? "Обзор" : "Кабинет куратора");
    setMenuOpen(false);
  };

  return (
    <main className="app-shell">
      <div className="logo-mosaic" aria-hidden="true">
        {Array.from({ length: 180 }, (_, index) => <span key={index} />)}
      </div>
      <aside className={`sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><Image src="/fix-logo.jpg" alt="FIX" width={34} height={34} priority /></div>
          <div>
            <div className="brand-name">FIX</div>
            <div className="brand-caption">TRADING PRACTICUM</div>
          </div>
          <button className="icon-button sidebar-close" aria-label="Закрыть меню" onClick={() => setMenuOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <div className="workspace-switcher">
          <div className="workspace-avatar">{studentDashboard.learner.cohortNumber}</div>
          <div className="workspace-copy">
            <span>Текущий поток</span>
            <strong>{studentDashboard.learner.cohort}</strong>
          </div>
          <ChevronRight size={16} />
        </div>

        <div className="role-preview" aria-label="Режим просмотра интерфейса">
          <span>РЕЖИМ ПРОСМОТРА</span>
          <div className="role-preview-tabs">
            <button className={role === "student" ? "active" : ""} onClick={() => switchRole("student")}>Ученик</button>
            <button className={role === "curator" ? "active" : ""} onClick={() => switchRole("curator")}>Куратор</button>
          </div>
        </div>

        <nav className="main-nav" aria-label="Основная навигация">
          <div className="nav-label">{role === "student" ? "РАБОЧЕЕ ПРОСТРАНСТВО" : "РАБОТА КУРАТОРА"}</div>
          {currentNavItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeNav === item.label;
            return (
              <button
                className={`nav-item ${isActive ? "active" : ""}`}
                key={item.label}
                onClick={() => {
                  setActiveNav(item.label);
                  setMenuOpen(false);
                }}
              >
                <Icon size={18} strokeWidth={isActive ? 2.4 : 1.8} />
                <span>{item.label}</span>
                {item.badge && <span className="nav-badge">{item.badge}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="support-card">
            <div className="support-icon"><CircleHelp size={17} /></div>
            <div>
              <strong>Нужна помощь?</strong>
              <span>Написать куратору</span>
            </div>
            <ArrowUpRight size={15} />
          </div>
          <button className="nav-item muted"><Settings2 size={18} /><span>Настройки</span></button>
          <div className="profile-row">
            <div className="profile-avatar">{currentProfile.initials}</div>
            <div className="profile-copy"><strong>{currentProfile.name}</strong><span>{role === "student" ? "Ученик" : "Куратор"}</span></div>
            <ChevronRight size={16} className="profile-chevron" />
          </div>
        </div>
      </aside>

      <section className="content-area">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Открыть меню" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Практикум 04</span><ChevronRight size={14} /><strong>{activeNav}</strong></div>
          <div className="topbar-actions">
            <div className="notification-wrap">
              <button className="icon-button notification-button" aria-label="Уведомления" onClick={() => setShowNotifications((value) => !value)}>
                <Bell size={18} /><span className="notification-dot" />
              </button>
              {showNotifications && (
                <div className="notification-popover">
                  <div className="popover-heading"><strong>Уведомления</strong><span>2 новых</span></div>
                  <div className="notification-item"><div className="notification-symbol blue"><MessageSquareText size={15} /></div><div><strong>Куратор оставил комментарий</strong><span>Разметка зон · 12 мин назад</span></div></div>
                  <div className="notification-item"><div className="notification-symbol amber"><CalendarDays size={15} /></div><div><strong>Стрим уже завтра</strong><span>Практика на живом рынке · 19:00</span></div></div>
                </div>
              )}
            </div>
            <div className="topbar-user"><div className="profile-avatar small">{currentProfile.initials}</div><ChevronRight size={15} /></div>
          </div>
        </header>

        <div className={`page-content ${activeNav === "Мой практикум" ? "course-page-shell" : ""}`}>
          {role === "student" && activeNav !== "Обзор" && <SectionView activeNav={activeNav as DashboardNav} />}
          {role === "curator" && <CuratorSectionView activeNav={activeNav as CuratorNav} onNavigate={(nextNav) => setActiveNav(nextNav)} />}
          <div className={role === "student" && activeNav === "Обзор" ? "dashboard-view" : "dashboard-view is-hidden"}>
          <div className="welcome-row">
            <div>
              <div className="eyebrow"><Sparkles size={14} /> ЛИЧНЫЙ КАБИНЕТ</div>
              <h1>Добрый вечер, {studentDashboard.learner.name.split(" ")[0]}</h1>
              <p>Вот что важно сделать сегодня, чтобы продолжить практикум без лишних переходов.</p>
            </div>
            <button className="secondary-button" onClick={() => setActiveNav("Мой практикум")}><BookOpen size={16} /> Открыть программу</button>
          </div>

          <div className="hero-grid">
            <section className="focus-panel">
              <div className="panel-topline"><span className="status-marker"><span /> СЛЕДУЮЩИЙ ШАГ</span><button className="quiet-button" aria-label="Открыть задание" onClick={() => setActiveNav("Задания")}><ArrowUpRight size={17} /></button></div>
              <div className="focus-copy"><div className="focus-context"><span>МОДУЛЬ 03</span><span>ПРАКТИКА · EUR/USD</span></div><h2>{studentDashboard.focus.title}</h2><p>{studentDashboard.focus.subtitle}</p><div className="focus-guidance"><strong>Осталось {100 - studentDashboard.focus.progress}%</strong><span>Добавь объяснение сценария и отправь работу куратору.</span></div></div>
              <div className="focus-footer"><div className="progress-label"><span>Готово</span><strong>{studentDashboard.focus.progress}% выполнено</strong></div><div className="progress-track"><span style={{ width: `${studentDashboard.focus.progress}%` }} /></div><button className="primary-button" onClick={() => setActiveNav("Задания")}>Открыть задание <ChevronRight size={17} /></button></div>
            </section>
            <ChartScene />
          </div>

          <div className="stats-grid">
            <StatCard icon={<Target size={18} />} label="Прогресс практикума" value={studentDashboard.progress.practicum} detail={studentDashboard.progress.weeklyChange} accent="cyan" />
            <StatCard icon={<FileCheck2 size={18} />} label="Задания на проверке" value={studentDashboard.progress.assignmentsOnReview} detail={studentDashboard.progress.assignmentsDetail} accent="amber" />
            <StatCard icon={<Clock3 size={18} />} label="До следующего стрима" value={studentDashboard.progress.nextStream} detail={studentDashboard.progress.nextStreamDetail} accent="blue" />
          </div>

          <div className="section-grid">
            <section className="content-panel assignments-panel">
              <div className="section-heading"><div><span className="section-kicker">СЕЙЧАС В РАБОТЕ</span><h2>Задания на сегодня</h2></div><div className="section-heading-actions"><span className="section-count">{openAssignments.length} активных</span><button className="text-button" onClick={() => setActiveNav("Задания")}>Все задания <ChevronRight size={15} /></button></div></div>
              <div className="assignment-list">
                {openAssignments.map((assignment) => <AssignmentRow assignment={assignment} key={assignment.title} onOpen={() => setActiveNav("Задания")} />)}
              </div>
              <div className="queue-footer"><span>{acceptedAssignments} {acceptedAssignments === 1 ? "работа принята" : "работы приняты"}</span><button className="text-button" onClick={() => setActiveNav("Задания")}>Открыть историю <ChevronRight size={15} /></button></div>
            </section>
            <section className="content-panel schedule-panel">
              <div className="section-heading"><div><span className="section-kicker">БЛИЖАЙШЕЕ</span><h2>Расписание</h2></div><div className="section-heading-actions"><span className="section-count">{studentDashboard.events.length} события</span><button className="icon-button compact" aria-label="Открыть расписание" onClick={() => setActiveNav("Расписание")}><CalendarDays size={17} /></button></div></div>
              {studentDashboard.events.map((event) => <EventCard event={event} key={event.title} onOpen={() => setActiveNav("Расписание")} />)}
            </section>
          </div>

          <div className="bottom-strip"><div><span className="section-kicker">ТВОЯ ТОЧКА</span><strong>{studentDashboard.lastActivity}</strong></div><button className="text-button" onClick={() => setActiveNav("Стримы")}>Продолжить просмотр <Play size={14} /></button></div>
          </div>
        </div>
      </section>
    </main>
  );
}

function SectionView({ activeNav }: { activeNav: string }) {
  const viewContent = {
    "Мой практикум": {
      kicker: "ПРОГРАММА ОБУЧЕНИЯ",
      title: "Мой практикум",
      description: "Двигайся по модулям в своём темпе. Все записи и материалы останутся доступны после завершения.",
    },
    "Задания": {
      kicker: "ПРОВЕРКА И ПРОГРЕСС",
      title: "Задания",
      description: "Здесь собраны все отправленные, ожидающие проверки и требующие доработки работы.",
    },
    "Торговый журнал": {
      kicker: "АНАЛИЗ ПРАКТИКИ",
      title: "Торговый журнал",
      description: "Фиксируй решения, сценарии и результат сделки, чтобы видеть закономерности в своей торговле.",
    },
    "Расписание": {
      kicker: "СОБЫТИЯ ПОТОКА",
      title: "Расписание",
      description: "Записывайся на практические части и возвращайся к записям конференций в удобное время.",
    },
    "Стримы": {
      kicker: "БИБЛИОТЕКА ЗАПИСЕЙ",
      title: "Стримы",
      description: "Записи практических эфиров, разборов и дополнительных встреч в одном месте.",
    },
    "Обсуждение": {
      kicker: "РАБОЧЕЕ ОБЩЕНИЕ",
      title: "Обсуждение",
      description: "Задавай вопросы по материалам и находи ответы от куратора и участников потока.",
    },
  }[activeNav as "Мой практикум" | "Задания" | "Торговый журнал" | "Расписание" | "Стримы" | "Обсуждение"];

  return <div className="workspace-view">
    <div className="workspace-view-heading"><div><span className="eyebrow"><Sparkles size={14} /> {viewContent?.kicker}</span><h1>{viewContent?.title}</h1><p>{viewContent?.description}</p></div></div>
    {activeNav === "Мой практикум" && <CourseView />}
    {activeNav === "Задания" && <AssignmentsView />}
    {activeNav === "Торговый журнал" && <JournalView />}
    {activeNav === "Расписание" && <ScheduleView />}
    {activeNav === "Стримы" && <StreamsView />}
    {activeNav === "Обсуждение" && <DiscussionView />}
  </div>;
}

function CuratorSectionView({ activeNav, onNavigate }: { activeNav: CuratorNav; onNavigate: (nextNav: CuratorNav) => void }) {
  const headings: Record<CuratorNav, { kicker: string; title: string; description: string }> = {
    "Кабинет куратора": { kicker: "РАБОЧИЙ ЦЕНТР", title: "Кабинет куратора", description: "Все работы, ученики и обратная связь по потоку собраны в одном рабочем контуре." },
    "Очередь проверки": { kicker: "ПРОВЕРКА ДЗ", title: "Очередь проверки", description: "Начни с работ, которые ученики отправили сегодня, и не теряй контекст предыдущих попыток." },
    "Создать задание": { kicker: "НОВАЯ РАБОТА", title: "Создать задание", description: "Собери понятное ДЗ с критериями, сроком и форматом ответа для всего потока." },
    "Ученики": { kicker: "ПОТОК 04", title: "Ученики", description: "Прогресс, активность и история обратной связи по каждому участнику практикума." },
    "Расписание": { kicker: "СОБЫТИЯ ПОТОКА", title: "Расписание", description: "Стримы, групповые проверки и встречи, которые нужно подготовить для потока." },
    "Медиатека": { kicker: "МАТЕРИАЛЫ", title: "Медиатека", description: "Записи эфиров и видеоразборы, привязанные к урокам и работам учеников." },
  };
  const heading = headings[activeNav];

  return <div className="workspace-view"><div className="workspace-view-heading"><div><span className="eyebrow"><Sparkles size={14} /> {heading.kicker}</span><h1>{heading.title}</h1><p>{heading.description}</p></div>{activeNav === "Кабинет куратора" || activeNav === "Очередь проверки" ? <button className="primary-button" onClick={() => onNavigate("Создать задание")}><Plus size={16} /> Создать задание</button> : null}</div>{activeNav === "Кабинет куратора" && <CuratorReviewWorkspace />} {activeNav === "Очередь проверки" && <CuratorReviewWorkspace compact />} {activeNav === "Создать задание" && <CreateAssignmentView />} {activeNav === "Расписание" && <CuratorScheduleView />} {activeNav !== "Кабинет куратора" && activeNav !== "Очередь проверки" && activeNav !== "Создать задание" && activeNav !== "Расписание" && <CuratorPlaceholder title={heading.title} />}</div>;
}

function CuratorReviewWorkspace({ compact = false }: { compact?: boolean }) {
  const [filter, setFilter] = useState<"all" | AssignmentStatus>("all");
  const [selectedId, setSelectedId] = useState(curatorDashboard.queue[0].id);
  const filteredQueue = filter === "all" ? curatorDashboard.queue : curatorDashboard.queue.filter((item) => item.status === filter);
  const selectedItem = curatorDashboard.queue.find((item) => item.id === selectedId) ?? curatorDashboard.queue[0];
  const filters: Array<{ id: "all" | AssignmentStatus; label: string }> = [
    { id: "all", label: "Все" },
    { id: "На проверке", label: "На проверке" },
    { id: "Нужна доработка", label: "Доработка" },
  ];

  return <>{!compact && <div className="stats-grid"><StatCard icon={<FileCheck2 size={18} />} label="Работы на проверке" value={curatorDashboard.stats.review} detail={curatorDashboard.stats.reviewDetail} accent="blue" /><StatCard icon={<ArrowUpRight size={18} />} label="Нужна доработка" value={curatorDashboard.stats.revision} detail={curatorDashboard.stats.revisionDetail} accent="amber" /><StatCard icon={<Target size={18} />} label="Средний прогресс потока" value={curatorDashboard.stats.progress} detail={curatorDashboard.stats.progressDetail} accent="cyan" /></div>}<div className="curator-workspace"><section className="content-panel review-queue"><div className="section-heading"><div><span className="section-kicker">{curatorDashboard.cohort.name.toUpperCase()}</span><h2>Работы на сегодня</h2></div><span className="progress-inline">{curatorDashboard.cohort.students}</span></div><div className="assignment-filter curator-filter">{filters.map((item) => { const count = item.id === "all" ? curatorDashboard.queue.length : curatorDashboard.queue.filter((queueItem) => queueItem.status === item.id).length; return <button className={`filter-chip ${filter === item.id ? "active" : ""}`} key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{count}</span></button>; })}</div><div className="review-queue-list">{filteredQueue.length > 0 ? filteredQueue.map((item) => <CuratorQueueRow item={item} selected={item.id === selectedItem.id} key={item.id} onOpen={() => setSelectedId(item.id)} />) : <div className="empty-state"><FileCheck2 size={22} /><strong>Очередь пуста</strong><span>Новые отправки появятся здесь после отправки задания учеником.</span></div>}</div></section><CuratorReviewPanel item={selectedItem} key={selectedItem.id} /></div></>;
}

function CuratorQueueRow({ item, selected, onOpen }: { item: ReviewQueueItem; selected: boolean; onOpen: () => void }) {
  return <button className={`review-queue-row ${selected ? "selected" : ""}`} onClick={onOpen} aria-pressed={selected}><div className="profile-avatar">{item.studentInitials}</div><div className="review-queue-copy"><strong>{item.studentName}</strong><span>{item.assignmentTitle} · {item.module}</span><small>{item.submittedAt} · {item.attempt}</small></div><div className={`assignment-badge ${item.tone}`}>{item.status}</div><ChevronRight size={16} /></button>;
}

function CuratorReviewPanel({ item }: { item: ReviewQueueItem }) {
  const [feedback, setFeedback] = useState("");
  const [videoName, setVideoName] = useState("");
  const [decision, setDecision] = useState<"accepted" | "revision" | null>(null);
  const isRevision = item.status === "Нужна доработка";

  return <section className="content-panel curator-review"><div className="curator-review-header"><div className="curator-student"><div className="profile-avatar">{item.studentInitials}</div><div><span className="section-kicker">{item.module}</span><strong>{item.studentName}</strong><small>Прогресс потока · {item.progress}</small></div></div><div className={`assignment-badge ${item.tone}`}>{decision === "accepted" ? "Принято" : decision === "revision" ? "Возвращено" : item.status}</div></div><div className="submission-meta"><span><Clock3 size={14} /> Отправлено {item.submittedAt}</span><span><FileCheck2 size={14} /> {item.attempt}</span></div><div className="curator-review-body"><div className="submission-section"><span className="detail-label">ОТВЕТ УЧЕНИКА</span><p className="submission-answer">{item.answer}</p><p className="student-note"><MessageSquareText size={14} /> {item.studentNote}</p></div><div className="submission-section"><span className="detail-label">ВЛОЖЕНИЯ</span><div className="submission-files">{item.attachments.map((attachment) => <button className="submission-file" key={attachment}><FileCheck2 size={16} /><span>{attachment}</span><ArrowUpRight size={14} /></button>)}</div></div><div className="submission-section"><span className="detail-label">ИСТОРИЯ ПОПЫТОК</span><div className="attempt-history"><div><span className="attempt-dot done" /><div><strong>Попытка 1</strong><small>{item.submittedAt} · Отправлено на проверку</small></div></div><div><span className={`attempt-dot ${isRevision ? "current" : "muted"}`} /><div><strong>{item.attempt}</strong><small>{isRevision ? "Текущая работа требует внимания" : "Работа ожидает решения куратора"}</small></div></div></div></div><div className="curator-feedback"><label className="detail-label" htmlFor="curator-feedback">ОБРАТНАЯ СВЯЗЬ</label><textarea id="curator-feedback" value={feedback} onChange={(event) => { setFeedback(event.target.value); setDecision(null); }} placeholder="Напиши, что получилось и что нужно поправить..." rows={4} /><label className={`video-feedback ${videoName ? "has-file" : ""}`} htmlFor="curator-video"><Play size={17} /><span>{videoName || "Добавить видеоразбор"}</span><small>MP4 или WebM · до 500 МБ</small><input id="curator-video" type="file" accept="video/mp4,video/webm" onChange={(event) => setVideoName(event.target.files?.[0]?.name ?? "")} /></label>{decision && <div className="detail-feedback curator-decision"><Target size={17} /><div><strong>{decision === "accepted" ? "Работа принята" : "Работа возвращена на доработку"}</strong><p>В предпросмотре статус обновлён. В API это станет транзакцией с историей проверки и уведомлением ученика.</p></div></div>}<div className="curator-actions"><button className="secondary-button" disabled={!feedback.trim()} onClick={() => setDecision("revision")}>Вернуть на доработку</button><button className="primary-button" onClick={() => setDecision("accepted")}>Принять работу <ChevronRight size={16} /></button></div></div></div></section>;
}

function CuratorPlaceholder({ title }: { title: string }) {
  return <section className="content-panel curator-placeholder"><div className="empty-state"><Target size={24} /><strong>{title} будет следующим рабочим разделом</strong><span>Каркас роли уже отделён от ученического интерфейса. После проверки основного сценария здесь появятся реальные списки и действия куратора.</span></div></section>;
}

function CuratorScheduleView() {
  const [events, setEvents] = useState<ScheduleEvent[]>([...studentDashboard.events]);
  const [selectedId, setSelectedId] = useState(events[0]?.id ?? "");
  const [showForm, setShowForm] = useState(false);

  const selectedEvent = events.find((event) => event.id === selectedId) ?? events[0];

  return <div className="curator-schedule"><div className="curator-schedule-toolbar"><div><span className="section-kicker">РАСПИСАНИЕ ПОТОКА</span><strong>{events.length} события опубликовано</strong><span>События видят ученики этого потока после публикации.</span></div><button className="primary-button" onClick={() => setShowForm((current) => !current)}><Plus size={16} /> {showForm ? "Закрыть форму" : "Создать событие"}</button></div>{showForm && <ScheduleEventForm onCancel={() => setShowForm(false)} onCreate={(event) => { setEvents((current) => [...current, event]); setSelectedId(event.id); setShowForm(false); }} />}{selectedEvent && <div className="calendar-layout"><section className="content-panel calendar-panel"><CalendarGrid events={events} selectedId={selectedEvent.id} onSelect={setSelectedId} /></section><section className="content-panel calendar-events"><div className="section-heading"><div><span className="section-kicker">ПЛАН ПОТОКА</span><h2>События и записи</h2></div><CalendarDays size={18} className="heading-icon" /></div>{events.map((event) => <ScheduleEventCard event={event} selected={event.id === selectedEvent.id} joined={false} mode="curator" onOpen={() => setSelectedId(event.id)} onJoin={() => undefined} key={event.id} />)}</section></div>}</div>;
}

function ScheduleEventForm({ onCreate, onCancel }: { onCreate: (event: ScheduleEvent) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<ScheduleEvent["type"]>("Практическая часть");
  const [date, setDate] = useState("2026-07-29");
  const [time, setTime] = useState("19:00 — 20:30");
  const [description, setDescription] = useState("");
  const canCreate = title.trim().length > 3 && description.trim().length > 10 && date.length > 0 && time.trim().length > 0;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    const parsedDate = new Date(`${date}T12:00:00`);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(parsedDate);
    onCreate({ id: `event-${Date.now()}`, day: date.slice(-2), month: "ИЮЛ", weekday, type, title: title.trim(), time: time.trim(), live: type === "Практическая часть", description: description.trim(), joined: false, recordingAvailable: false });
  };

  return <form className="content-panel schedule-form" onSubmit={submit}><div className="section-heading"><div><span className="section-kicker">НОВОЕ СОБЫТИЕ</span><h2>Добавить встречу в поток</h2></div><button type="button" className="icon-button compact" aria-label="Закрыть форму" onClick={onCancel}><X size={16} /></button></div><div className="form-body"><div className="form-grid"><label className="form-field form-field-wide"><span>Название</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Разбор рынка в прямом эфире" /></label><label className="form-field"><span>Тип события</span><select value={type} onChange={(event) => setType(event.target.value as ScheduleEvent["type"])}><option>Практическая часть</option><option>Q&A</option><option>Разбор ДЗ</option></select></label><label className="form-field"><span>Дата</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="form-field"><span>Время</span><input value={time} onChange={(event) => setTime(event.target.value)} placeholder="19:00 — 20:30" /></label><label className="form-field form-field-wide"><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Что будет происходить на встрече и что подготовить ученикам?" /></label></div><div className="create-actions"><button type="button" className="secondary-button" onClick={onCancel}>Отмена</button><button type="submit" className="primary-button" disabled={!canCreate}>Опубликовать событие <ChevronRight size={16} /></button></div></div></form>;
}

type SubmissionFormat = "comment" | "image" | "video";

function CreateAssignmentView() {
  const [title, setTitle] = useState("");
  const [moduleId, setModuleId] = useState("zones");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState("2026-07-21");
  const [attempts, setAttempts] = useState("2");
  const [requirements, setRequirements] = useState(["", ""]);
  const [formats, setFormats] = useState<SubmissionFormat[]>(["comment", "image"]);
  const [published, setPublished] = useState(false);
  const selectedModule = studentDashboard.modules.find((module) => module.id === moduleId) ?? studentDashboard.modules[0];
  const canPublish = title.trim().length > 3 && description.trim().length > 10 && requirements.some((requirement) => requirement.trim().length > 0) && formats.length > 0;

  const updateRequirement = (index: number, value: string) => {
    setRequirements((current) => current.map((requirement, requirementIndex) => requirementIndex === index ? value : requirement));
    setPublished(false);
  };

  const toggleFormat = (format: SubmissionFormat) => {
    setFormats((current) => current.includes(format) ? current.filter((item) => item !== format) : [...current, format]);
    setPublished(false);
  };

  return <form className="create-assignment-layout" onSubmit={(event) => { event.preventDefault(); if (canPublish) setPublished(true); }}><section className="content-panel create-assignment-form"><div className="section-heading"><div><span className="section-kicker">НОВЫЙ МАТЕРИАЛ</span><h2>Параметры задания</h2></div><span className="draft-status">{published ? "Опубликовано в предпросмотре" : "Черновик"}</span></div><div className="form-body"><label className="form-field form-field-wide"><span>Название задания</span><input value={title} onChange={(event) => { setTitle(event.target.value); setPublished(false); }} placeholder="Например, Разметка зон на истории" /></label><div className="form-grid"><label className="form-field"><span>Модуль</span><select value={moduleId} onChange={(event) => { setModuleId(event.target.value); setPublished(false); }}>{studentDashboard.modules.map((module) => <option value={module.id} key={module.id}>{module.number} · {module.title}</option>)}</select></label><label className="form-field"><span>Поток</span><select defaultValue="practicum-04"><option value="practicum-04">Практикум 04 · 18 учеников</option></select></label></div><label className="form-field form-field-wide"><span>Описание и контекст</span><textarea value={description} onChange={(event) => { setDescription(event.target.value); setPublished(false); }} placeholder="Объясни, что ученик должен сделать и зачем это нужно в системе..." rows={5} /></label><div className="form-section"><div className="form-section-heading"><div><span>Критерии выполнения</span><small>По ним куратор будет проверять работу.</small></div><button type="button" className="quiet-button" aria-label="Добавить критерий" onClick={() => setRequirements((current) => [...current, ""])}><Plus size={16} /></button></div><div className="requirement-editor">{requirements.map((requirement, index) => <div className="requirement-input" key={index}><span>{String(index + 1).padStart(2, "0")}</span><input value={requirement} onChange={(event) => updateRequirement(index, event.target.value)} placeholder="Добавить критерий проверки" />{requirements.length > 1 && <button type="button" className="icon-button compact" aria-label={`Удалить критерий ${index + 1}`} onClick={() => setRequirements((current) => current.filter((_, requirementIndex) => requirementIndex !== index))}><X size={14} /></button>}</div>)}</div></div><div className="form-grid"><label className="form-field"><span>Срок сдачи</span><input type="date" value={deadline} onChange={(event) => { setDeadline(event.target.value); setPublished(false); }} /></label><label className="form-field"><span>Попытки</span><input type="number" min="1" max="5" value={attempts} onChange={(event) => { setAttempts(event.target.value); setPublished(false); }} /></label></div><div className="form-section"><div className="form-section-heading"><div><span>Формат ответа</span><small>Что ученик сможет приложить к работе.</small></div></div><div className="format-options"><label className={`format-option ${formats.includes("comment") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("comment")} onChange={() => toggleFormat("comment")} /><MessageSquareText size={16} /><span>Комментарий</span></label><label className={`format-option ${formats.includes("image") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("image")} onChange={() => toggleFormat("image")} /><FileCheck2 size={16} /><span>Изображение</span></label><label className={`format-option ${formats.includes("video") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("video")} onChange={() => toggleFormat("video")} /><Play size={16} /><span>Видео</span></label></div></div><div className="create-actions"><button type="button" className="secondary-button" onClick={() => { setTitle(""); setDescription(""); setRequirements(["", ""]); setFormats(["comment", "image"]); setPublished(false); }}>Очистить</button><button type="submit" className="primary-button" disabled={!canPublish}>{published ? "Задание опубликовано" : "Опубликовать задание"} <ChevronRight size={16} /></button></div>{published && <div className="detail-feedback curator-decision"><Target size={17} /><div><strong>Задание готово для потока</strong><p>В предпросмотре оно появится у учеников модуля {selectedModule.number}. После подключения API публикация создаст запись и уведомит поток.</p></div></div>}</div></section><aside className="content-panel assignment-preview"><div className="section-heading"><div><span className="section-kicker">ПРЕДПРОСМОТР</span><h2>Так увидит ученик</h2></div><EyeIcon /></div><div className="preview-body"><div className="preview-module">{selectedModule.number} · {selectedModule.title}</div><h3>{title || "Название нового задания"}</h3><p>{description || "Здесь появится описание задания и контекст, который увидит ученик перед началом работы."}</p><div className="preview-meta"><span><Clock3 size={14} /> {deadline || "Срок не выбран"}</span><span><FileCheck2 size={14} /> До {attempts || "0"} попыток</span></div><div className="preview-requirements"><span className="detail-label">ЧТО НУЖНО СДЕЛАТЬ</span>{requirements.filter((requirement) => requirement.trim()).length > 0 ? requirements.filter((requirement) => requirement.trim()).map((requirement) => <div key={requirement}><span />{requirement}</div>) : <div className="preview-empty">Критерии появятся после заполнения формы.</div>}</div></div></aside></form>;
}

function EyeIcon() {
  return <span className="preview-eye" aria-hidden="true"><Target size={18} /></span>;
}

type ModuleContentItem = { id: string; kind: "Урок" | "Стрим" | "Задание"; tone: "lesson" | "stream" | "task"; title: string; meta: string };

function moduleContentFor(module: (typeof practicumModules)[number]): ModuleContentItem[] {
  return [
    { id: `${module.id}-lesson`, kind: "Урок", tone: "lesson", title: module.id === "week-1" ? "Market Logic: базовые принципы" : `Введение в блок «${module.title}»`, meta: "Видео · 18 мин" },
    { id: `${module.id}-stream`, kind: "Стрим", tone: "stream", title: "Практика с куратором", meta: "Запись · 42 мин" },
    { id: `${module.id}-task`, kind: "Задание", tone: "task", title: "Закрепить материал", meta: "Отправка работы" },
  ];
}

function CourseView() {
  const [selectedId, setSelectedId] = useState("week-1");
  const [continued, setContinued] = useState(false);
  const [selectedContentId, setSelectedContentId] = useState("week-1-lesson");
  const [openedModuleId, setOpenedModuleId] = useState<string | null>(null);
  const selectedModule = practicumModules.find((module) => module.id === selectedId) ?? practicumModules[0];
  const openedModule = practicumModules.find((module) => module.id === openedModuleId);
  const completedModules = practicumModules.filter((module) => module.progress === 100).length;
  const practicumProgress = Math.round(practicumModules.reduce((total, module) => total + module.progress, 0) / practicumModules.length);
  const sectionOrder: PracticumSection[] = ["Welcome", "Education", "Q&A", "Practice"];
  const moduleContents = moduleContentFor(selectedModule);
  const selectedContent = moduleContents.find((item) => item.id === selectedContentId) ?? moduleContents[0];

  if (openedModule) return <ModuleOverviewPage module={openedModule} onBack={() => setOpenedModuleId(null)} />;
  const moduleSteps = [
    { label: "Уроки и материалы", description: `${selectedModule.lessons} уроков в модуле`, icon: <BookOpen size={16} />, complete: selectedModule.progress > 0 },
    { label: "Практическое задание", description: selectedModule.locked ? "Откроется после модуля 03" : "Закрепи материал в своей работе", icon: <Target size={16} />, complete: selectedModule.progress === 100 },
    { label: "Проверка куратора", description: selectedModule.progress === 100 ? "Модуль завершён" : "После отправки задания", icon: <FileCheck2 size={16} />, complete: selectedModule.progress === 100 },
  ];

  return <div className="course-page">
    <section className="course-progress-panel content-panel">
      <div className="course-progress-copy"><span className="section-kicker">ПРОГРЕСС ПРАКТИКУМА</span><strong>{practicumProgress}%</strong><span>Завершён {completedModules} из {practicumModules.length} блоков. Двигайся дальше в своём темпе.</span></div>
      <div className="course-progress-track"><div><span>Общий прогресс</span><strong>{practicumProgress}% выполнено</strong></div><i><b style={{ width: `${practicumProgress}%` }} /></i></div>
      <div className="course-progress-fact"><span>ДОСТУП</span><strong>Материалы останутся после завершения</strong><small>Записи, уроки и проверенные работы будут сохранены в профиле.</small></div>
    </section>

    <div className="course-workspace"><section className="content-panel course-map"><div className="section-heading"><div><span className="section-kicker">ПРАКТИКУМ 04</span><h2>Структура курса</h2></div><span className="progress-inline">{practicumProgress}% пройдено</span></div><div className="module-sections">{sectionOrder.map((section) => { const sectionModules = practicumModules.filter((module) => module.section === section); return <section className="module-section" key={section}><div className="module-section-heading"><strong>{section}</strong><span>{sectionModules.length} {sectionModules.length === 1 ? "блок" : "блока"}</span></div><div className="module-list">{sectionModules.map((module) => <button className={`module-row ${selectedModule.id === module.id ? "selected" : ""} ${module.locked ? "locked" : ""}`} key={module.id} onClick={() => { if (!module.locked) { setSelectedId(module.id); setSelectedContentId(`${module.id}-lesson`); setOpenedModuleId(module.id); } }} aria-pressed={selectedModule.id === module.id} disabled={module.locked}><span className="module-number">{module.number}</span><div className="module-copy"><strong>{module.title}</strong><span>{module.status} · {module.lessons} {module.lessons === 1 ? "урок" : "урока"}</span></div><div className="module-progress"><span>{module.progress}%</span><i><b style={{ width: `${module.progress}%` }} /></i></div>{module.locked ? <LockKeyhole size={15} /> : <ChevronRight size={16} />}</button>)}</div></section>; })}</div><div className="course-map-footer"><span>Закрытые блоки откроются после завершения предыдущего этапа и проверки задания.</span><button className="text-button" onClick={() => { setSelectedId("week-1"); setSelectedContentId("week-1-lesson"); }}>Вернуться к текущему <ChevronRight size={15} /></button></div></section><section className="content-panel module-detail"><div className="module-detail-head"><div><span className="section-kicker">МОДУЛЬ {selectedModule.number}</span><h2>{selectedModule.title}</h2></div>{selectedModule.locked ? <LockKeyhole size={19} className="heading-icon" /> : <Target size={19} className="heading-icon" />}</div><div className="module-detail-body"><div className="module-detail-summary"><div className="module-progress-large"><strong>{selectedModule.progress}%</strong><span>пройдено</span></div><p>{selectedModule.description}</p></div><div className="module-detail-meta"><span><BookOpen size={14} /> {selectedModule.lessons} {selectedModule.lessons === 1 ? "урок" : "урока"}</span><span><FileCheck2 size={14} /> {selectedModule.locked ? "Доступ ограничен" : "Материалы доступны"}</span></div><div className="module-content-block"><div className="module-content-heading"><span>СОДЕРЖАНИЕ МОДУЛЯ</span><small>{moduleContents.length} элемента</small></div><div className="module-content-list">{moduleContents.map((item) => <button className={`module-content-item ${item.tone} ${selectedContent.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedContentId(item.id)} disabled={selectedModule.locked}><span className="module-content-kind">{item.kind}</span><span className="module-content-copy"><strong>{item.title}</strong><small>{item.meta}</small></span><ChevronRight size={16} /></button>)}</div><div className="module-content-preview"><span>ВЫБРАНО</span><strong>{selectedContent.title}</strong><small>{selectedContent.kind} · {selectedContent.meta} · Откроется внутри платформы</small></div></div><div className="module-steps"><span className="detail-label">КАК ПРОХОДИТ МОДУЛЬ</span>{moduleSteps.map((step, index) => <div className={`module-step ${step.complete ? "complete" : ""} ${selectedModule.locked ? "locked" : ""}`} key={step.label}><div className="module-step-icon">{selectedModule.locked ? <LockKeyhole size={15} /> : step.icon}</div><div><strong>{String(index + 1).padStart(2, "0")} · {step.label}</strong><span>{step.description}</span></div><small>{selectedModule.locked ? "Закрыто" : step.complete ? "Готово" : "Дальше"}</small></div>)}</div>{selectedModule.locked ? <div className="locked-note"><LockKeyhole size={17} /><div><strong>Модуль пока закрыт</strong><span>Заверши текущий модуль и отправь задание на проверку, чтобы продолжить программу.</span></div></div> : <><div className="next-lesson"><span className="section-kicker">СЛЕДУЮЩИЙ ШАГ</span><strong>{selectedModule.progress === 100 ? "Повторить ключевые уроки" : "Продолжить с последнего урока"}</strong><span>{continued ? "Шаг отмечен для продолжения" : "Материалы и прогресс сохранятся в профиле"}</span></div><button className="primary-button" onClick={() => setContinued(true)}>{continued ? "Продолжение открыто" : selectedModule.progress === 100 ? "Открыть модуль" : "Продолжить обучение"} <ChevronRight size={17} /></button></>}</div></section></div>
  </div>;
}

function modulePageContentFor(module: (typeof practicumModules)[number]) {
  if (module.id === "week-1") return {
    streamTitle: "Market Logic 02.06",
    streamMeta: "Запись стрима · 1:21:16",
    homework: [
      "Опиши, что такое классический аукцион и что такое двойной ринковый аукцион.",
      "Что такое закон спроса и предложения?",
      "Взаимодействие покупателей и продавцов. Что происходит по завышенной или заниженной цене?",
      "Каковы минимальные условия процесса? Что такое расширение / коррекция / флэт?",
    ],
    questions: ["Разбор механики рынка на графике", "Как определить расширение", "Как определить боковик / флэт", "Разбор примеров на истории", "Другие вопросы из чата"],
  };

  return {
    streamTitle: `${module.title} · практика`,
    streamMeta: "Запись стрима · доступно после открытия блока",
    homework: ["Посмотри материалы блока и выпиши ключевые наблюдения.", "Разбери один пример на истории.", "Подготовь короткое объяснение своего сценария."],
    questions: ["Вопросы по материалу", "Разбор примера на истории", "Комментарий куратора"],
  };
}

function ModuleOverviewPage({ module, onBack }: { module: (typeof practicumModules)[number]; onBack: () => void }) {
  const content = modulePageContentFor(module);
  const videoRef = useRef<HTMLVideoElement>(null);
  const modalVideoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [homeworkOpened, setHomeworkOpened] = useState(false);
  const [discussionOpened, setDiscussionOpened] = useState(false);
  const openPlayer = () => {
    videoRef.current?.pause();
    setPlayerOpen(true);
  };
  const closePlayer = () => {
    modalVideoRef.current?.pause();
    setPlayerOpen(false);
    setPlaying(false);
  };
  useEffect(() => {
    if (!playerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePlayer();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playerOpen]);

  return <div className="module-page"><div className="module-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к структуре</button><span className="module-page-breadcrumb">{module.section} / {module.title}</span></div><header className="module-page-header"><div><span className="eyebrow"><BookOpen size={14} /> МОДУЛЬ {module.number}</span><h2>{module.title}</h2><p>{module.description}</p></div><div className="module-page-progress"><strong>{module.progress}%</strong><span>пройдено</span><i><b style={{ width: `${module.progress}%` }} /></i></div></header><div className="module-resource-grid"><section className="module-resource-card module-description-card"><div className="module-resource-heading"><BookOpen size={17} /><h3>Описание</h3></div><p>{module.description} Здесь собраны основные идеи, которые нужно понять перед практикой.</p></section><section className="module-resource-card module-stream-card"><div className="module-resource-heading"><Play size={17} /><h3>Запись стрима</h3><span>Демо-плеер</span></div><div className="module-video-stage"><video ref={videoRef} src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" poster="/market-logic-cover.png" preload="metadata" controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /><span className="module-video-label">{content.streamTitle}</span><button className={`play-button ${playing ? "is-playing" : ""}`} aria-label="Открыть плеер" onClick={openPlayer}><Play size={18} fill="currentColor" /></button><span className="stream-duration">{playing ? "ВОСПРОИЗВЕДЕНИЕ" : content.streamMeta.replace("Запись стрима · ", "")}</span></div></section><section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{content.homework.length} пункта</span></div><ol>{content.homework.map((item) => <li key={item}>{item}</li>)}</ol><p className="module-resource-note">К каждому вопросу требуется как текстовое описание, так и схема с графическим описанием вопроса.</p><button className="primary-button" onClick={() => setHomeworkOpened((current) => !current)}>{homeworkOpened ? "Задание открыто" : "Открыть задание"} <ChevronRight size={16} /></button>{homeworkOpened && <div className="module-action-feedback">Черновик задания готов к заполнению внутри платформы.</div>}</section><section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>Разобрано на стриме</span></div><ul>{content.questions.map((question) => <li key={question}>{question}</li>)}</ul><button className="secondary-button" onClick={() => setDiscussionOpened((current) => !current)}>{discussionOpened ? "Обсуждение открыто" : "Открыть обсуждение"} <ChevronRight size={16} /></button>{discussionOpened && <div className="module-action-feedback">Здесь появится ветка вопросов и ответов по модулю.</div>}</section></div>{playerOpen && <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Плеер: ${content.streamTitle}`} onMouseDown={(event) => { if (event.currentTarget === event.target) closePlayer(); }}><div className="video-modal"><div className="video-modal-head"><div><span className="section-kicker">ЗАПИСЬ СТРИМА</span><strong>{content.streamTitle}</strong></div><button className="icon-button" aria-label="Закрыть плеер" onClick={closePlayer}><X size={18} /></button></div><video ref={modalVideoRef} src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" poster="/market-logic-cover.png" controls autoPlay playsInline onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /><div className="video-modal-foot"><span>Демо-видео · будущая запись будет открываться здесь</span><button className="secondary-button" onClick={() => { const video = modalVideoRef.current; if (!video) return; if (document.fullscreenElement) void document.exitFullscreen(); else void video.requestFullscreen(); }}><Maximize2 size={15} /> На весь экран</button></div></div></div>}</div>;
}

function AssignmentsView() {
  const [filter, setFilter] = useState<"all" | AssignmentStatus>("all");
  const [selectedId, setSelectedId] = useState(studentDashboard.assignments[0].id);
  const allAssignments: Assignment[] = [...studentDashboard.assignments];
  const selectedAssignment = allAssignments.find((assignment) => assignment.id === selectedId) ?? allAssignments[0];
  const filters: Array<{ id: "all" | AssignmentStatus; label: string }> = [
    { id: "all", label: "Все" },
    { id: "На проверке", label: "На проверке" },
    { id: "Нужна доработка", label: "Нужна доработка" },
    { id: "Принято", label: "Принято" },
  ];
  const filteredAssignments = filter === "all" ? allAssignments : allAssignments.filter((assignment) => assignment.status === filter);

  return <div className="assignment-workspace"><section className="content-panel assignment-inbox"><div className="section-heading"><div><span className="section-kicker">СТАТУСЫ РАБОТ</span><h2>Мои задания</h2><p className="section-heading-note">Следи за отправками и комментариями куратора в одном месте.</p></div></div><div className="assignment-filter">{filters.map((item) => { const count = item.id === "all" ? allAssignments.length : allAssignments.filter((assignment) => assignment.status === item.id).length; return <button className={`filter-chip ${filter === item.id ? "active" : ""}`} key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{count}</span></button>; })}</div><div className="assignment-list">{filteredAssignments.length > 0 ? filteredAssignments.map((assignment) => <AssignmentRow assignment={assignment} key={assignment.id} selected={assignment.id === selectedAssignment.id} onOpen={() => setSelectedId(assignment.id)} />) : <div className="empty-state"><FileCheck2 size={22} /><strong>В этом фильтре пока пусто</strong><span>Новые статусы появятся после отправки работы или проверки куратором.</span></div>}</div></section><AssignmentDetail assignment={selectedAssignment} key={selectedAssignment.id} /></div>;
}

function JournalView() {
  const [entries, setEntries] = useState<TradeEntry[]>([...studentDashboard.journal]);
  const [filter, setFilter] = useState<"all" | TradeOutcome>("all");
  const [showForm, setShowForm] = useState(false);
  const filteredEntries = filter === "all" ? entries : entries.filter((entry) => entry.outcome === filter);
  const totalResult = entries.reduce((sum, entry) => sum + entry.result, 0);
  const averageResult = entries.length > 0 ? totalResult / entries.length : 0;
  const resultLabel = `${averageResult >= 0 ? "+" : ""}${averageResult.toFixed(1)}R`;

  return <><div className="stats-grid"><StatCard icon={<Target size={18} />} label="Всего сделок" value={String(entries.length)} detail="За текущий практикум" accent="blue" /><StatCard icon={<BarChart3 size={18} />} label="Средний результат" value={resultLabel} detail={`${totalResult >= 0 ? "+" : ""}${totalResult.toFixed(1)}R суммарно`} accent="cyan" /><StatCard icon={<Clock3 size={18} />} label="Заполнено журнала" value="91%" detail="Последняя запись сегодня" accent="amber" /></div>{showForm && <TradeForm onCreate={(entry) => { setEntries((current) => [{ ...entry, id: `trade-${Date.now()}`, date: "Сегодня" }, ...current]); setShowForm(false); setFilter("all"); }} onCancel={() => setShowForm(false)} />}<div className="section-grid"><section className="content-panel journal-chart-panel"><div className="section-heading"><div><span className="section-kicker">ДИНАМИКА</span><h2>Результат по неделям</h2></div><span className="positive-number">{totalResult >= 0 ? "+" : ""}{totalResult.toFixed(1)}R</span></div><div className="journal-chart"><div className="chart-gridlines"><i /><i /><i /><i /></div><svg viewBox="0 0 600 220" preserveAspectRatio="none"><path d="M0 185 C40 190 68 151 104 164 S156 123 196 145 S246 106 288 118 S332 73 370 91 S418 110 458 62 S524 71 600 28" /></svg><div className="chart-axis"><span>Неделя 1</span><span>Неделя 2</span><span>Неделя 3</span><span>Сейчас</span></div></div></section><section className="content-panel journal-trades"><div className="section-heading"><div><span className="section-kicker">ПОСЛЕДНИЕ ЗАПИСИ</span><h2>Сделки</h2></div><button className="primary-button compact-button" onClick={() => setShowForm((current) => !current)}><Plus size={15} /> {showForm ? "Закрыть" : "Новая запись"}</button></div><div className="assignment-filter journal-filter"><button className={`filter-chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>Все <span>{entries.length}</span></button><button className={`filter-chip ${filter === "WIN" ? "active" : ""}`} onClick={() => setFilter("WIN")}>Плюс <span>{entries.filter((entry) => entry.outcome === "WIN").length}</span></button><button className={`filter-chip ${filter === "LOSS" ? "active" : ""}`} onClick={() => setFilter("LOSS")}>Минус <span>{entries.filter((entry) => entry.outcome === "LOSS").length}</span></button></div><div className="trade-list">{filteredEntries.length > 0 ? filteredEntries.map((entry) => <TradeRow entry={entry} key={entry.id} />) : <div className="empty-state"><BarChart3 size={22} /><strong>В этом фильтре нет сделок</strong><span>Добавь запись или выбери другой результат.</span></div>}</div></section></div></>;
}

function TradeForm({ onCreate, onCancel }: { onCreate: (entry: Omit<TradeEntry, "id" | "date">) => void; onCancel: () => void }) {
  const [symbol, setSymbol] = useState("EUR");
  const [title, setTitle] = useState("");
  const [result, setResult] = useState("1.0");
  const [outcome, setOutcome] = useState<TradeOutcome>("WIN");
  const canCreate = title.trim().length > 2 && Number.isFinite(Number(result));

  return <form className="content-panel journal-entry-form" onSubmit={(event) => { event.preventDefault(); if (canCreate) onCreate({ symbol, title: title.trim(), result: Number(result), outcome }); }}><div className="section-heading"><div><span className="section-kicker">НОВАЯ ЗАПИСЬ</span><h2>Зафиксировать сделку</h2></div><button type="button" className="icon-button compact" aria-label="Закрыть форму" onClick={onCancel}><X size={15} /></button></div><div className="journal-entry-fields"><label className="form-field"><span>Инструмент</span><select value={symbol} onChange={(event) => setSymbol(event.target.value)}><option value="EUR">EUR/USD</option><option value="GBP">GBP/USD</option><option value="XAU">XAU/USD</option></select></label><label className="form-field"><span>Результат в R</span><input type="number" step="0.1" value={result} onChange={(event) => setResult(event.target.value)} /></label><label className="form-field journal-entry-title"><span>Сетап или причина сделки</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, возврат в зону" /></label><label className="form-field"><span>Итог</span><select value={outcome} onChange={(event) => setOutcome(event.target.value as TradeOutcome)}><option value="WIN">Плюс</option><option value="LOSS">Минус</option></select></label></div><div className="create-actions"><button type="button" className="secondary-button" onClick={onCancel}>Отмена</button><button type="submit" className="primary-button" disabled={!canCreate}>Сохранить запись <ChevronRight size={16} /></button></div></form>;
}

function TradeRow({ entry }: { entry: TradeEntry }) {
  return <div className="trade-row"><span className="trade-symbol">{entry.symbol}</span><div><strong>{entry.title}</strong><small>{entry.date} · {entry.result >= 0 ? "+" : ""}{entry.result.toFixed(1)}R</small></div><b className={entry.outcome === "WIN" ? "trade-positive" : "trade-negative"}>{entry.outcome}</b></div>;
}

function ScheduleView() {
  const [selectedId, setSelectedId] = useState(studentDashboard.events[0].id);
  const [joinedIds, setJoinedIds] = useState(studentDashboard.events.filter((event) => event.joined).map((event) => event.id));
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const selectedEvent = studentDashboard.events.find((event) => event.id === selectedId) ?? studentDashboard.events[0];
  const detailsEvent = studentDashboard.events.find((event) => event.id === detailsId);
  const toggleJoin = (eventId: string) => setJoinedIds((current) => current.includes(eventId) ? current.filter((id) => id !== eventId) : [...current, eventId]);
  const openEvent = (eventId: string) => { setSelectedId(eventId); setDetailsId(eventId); };

  return <>{<div className="calendar-layout"><section className="content-panel calendar-panel"><CalendarGrid events={studentDashboard.events} selectedId={selectedId} onSelect={openEvent} /></section><section className="content-panel calendar-events"><div className="section-heading"><div><span className="section-kicker">СОБЫТИЯ</span><h2>Участие</h2></div><CalendarDays size={18} className="heading-icon" /></div>{studentDashboard.events.map((event) => <ScheduleEventCard event={event} selected={event.id === selectedEvent.id} joined={joinedIds.includes(event.id)} onOpen={() => openEvent(event.id)} onJoin={() => toggleJoin(event.id)} key={event.id} />)}</section></div>}{detailsEvent && <ScheduleEventDetails event={detailsEvent} joined={joinedIds.includes(detailsEvent.id)} onJoin={() => toggleJoin(detailsEvent.id)} onClose={() => setDetailsId(null)} />}</>;
}

function CalendarGrid({ events, selectedId, onSelect }: { events: readonly ScheduleEvent[]; selectedId: string; onSelect: (eventId: string) => void }) {
  const days = ["29", "30", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "1", "2"];
  return <><div className="calendar-toolbar"><div><span className="section-kicker">РАСПИСАНИЕ ПОТОКА</span><h2>Июль 2026</h2></div><div className="calendar-controls"><button className="icon-button compact" aria-label="Предыдущий месяц"><ChevronRight size={16} className="rotate-left" /></button><button className="today-button">Сегодня</button><button className="icon-button compact" aria-label="Следующий месяц"><ChevronRight size={16} /></button></div></div><div className="calendar-weekdays"><span>ПН</span><span>ВТ</span><span>СР</span><span>ЧТ</span><span>ПТ</span><span>СБ</span><span>ВС</span></div><div className="calendar-grid">{days.map((day, index) => { const isOutside = index < 2 || index > 32; const event = !isOutside ? events.find((item) => item.day === day) : undefined; const isToday = index === 18; return <div className={`calendar-day ${isToday ? "today" : ""} ${isOutside ? "outside" : ""}`} key={`${day}-${index}`}><span>{day}</span>{event && <button className={`calendar-event ${eventTone(event)} ${event.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(event.id)}>{event.type}</button>}</div>; })}</div></>;
}

function ScheduleEventDetails({ event, joined, onJoin, onClose }: { event: ScheduleEvent; joined: boolean; onJoin: () => void; onClose: () => void }) {
  return <div className="event-details-overlay" role="presentation" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}><section className="event-details-modal" role="dialog" aria-modal="true" aria-labelledby="schedule-event-title"><div className="event-details-head"><div className={`event-date ${eventTone(event)}`}><strong>{event.day}</strong><span>{event.month}</span></div><div><span className="event-type">{event.live && <span className="live-dot" />} {event.type.toUpperCase()}</span><small>{event.weekday}</small></div><button className="icon-button compact" aria-label="Закрыть детали события" onClick={onClose}><X size={16} /></button></div><div className="event-details-body"><h2 id="schedule-event-title">{event.title}</h2><p className="event-details-description">{event.description}</p><div className="event-details-meta"><span><Clock3 size={15} /> {event.time}</span><span>{event.live ? "Прямой эфир" : "Онлайн-встреча"}</span></div>{event.recordingAvailable && <div className="event-recording-note"><Play size={16} /><div><strong>Запись будет доступна после встречи</strong><span>Открыть её можно будет в разделе «Стримы».</span></div></div>}</div><div className="event-details-footer"><button className="secondary-button" onClick={onClose}>Закрыть</button>{event.recordingAvailable ? <button className="primary-button" onClick={onClose}>Открыть запись <Play size={15} /></button> : <button className={`primary-button ${joined ? "is-joined" : ""}`} onClick={onJoin}>{joined ? "Вы записаны" : "Присоединиться"} {!joined && <ChevronRight size={16} />}</button>}</div></section></div>;
}

function ScheduleEventCard({ event, selected, joined, mode = "student", onOpen, onJoin }: { event: ScheduleEvent; selected: boolean; joined: boolean; mode?: "student" | "curator"; onOpen: () => void; onJoin: () => void }) {
  return <div className={`event-card schedule-event-card ${selected ? "selected" : ""}`}><button className="event-card-main" onClick={onOpen}><div className={`event-date ${eventTone(event)}`}><strong>{event.day}</strong><span>{event.month}</span></div><div className="event-info"><div className="event-type">{event.live && <span className="live-dot" />} {event.type.toUpperCase()}</div><h3>{event.title}</h3><p><Clock3 size={14} /> {event.weekday} · {event.time}</p></div></button>{mode === "curator" ? <button className="event-action" aria-label={`Открыть событие: ${event.title}`} onClick={onOpen}><ArrowUpRight size={17} /></button> : event.recordingAvailable ? <button className="event-register joined" onClick={onOpen}>Смотреть запись</button> : <button className={`event-register ${joined ? "joined" : ""}`} onClick={onJoin}>{joined ? "Вы записаны" : "Записаться"}</button>}</div>;
}

function eventTone(event: ScheduleEvent) {
  return event.type === "Практическая часть" ? "blue" : event.type === "Q&A" ? "cyan" : "amber";
}

function StreamsView() {
  const [filter, setFilter] = useState<"all" | StreamKind>("all");
  const [selectedId, setSelectedId] = useState(studentDashboard.streams[0].id);
  const [playing, setPlaying] = useState(false);
  const streams = filter === "all" ? studentDashboard.streams : studentDashboard.streams.filter((stream) => stream.kind === filter);
  const selectedStream = studentDashboard.streams.find((stream) => stream.id === selectedId) ?? studentDashboard.streams[0];

  return <div className="stream-library"><div className="stream-library-toolbar"><div className="assignment-filter"><button className={`filter-chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>Все <span>{studentDashboard.streams.length}</span></button><button className={`filter-chip ${filter === "Разбор" ? "active" : ""}`} onClick={() => setFilter("Разбор")}>Разборы <span>{studentDashboard.streams.filter((stream) => stream.kind === "Разбор").length}</span></button><button className={`filter-chip ${filter === "Стрим" ? "active" : ""}`} onClick={() => setFilter("Стрим")}>Стримы <span>{studentDashboard.streams.filter((stream) => stream.kind === "Стрим").length}</span></button></div><span className="stream-count">{streams.length} записи</span></div><div className="stream-library-grid"><section className="stream-grid">{streams.map((stream) => <StreamCard stream={stream} selected={stream.id === selectedStream.id} key={stream.id} onOpen={() => { setSelectedId(stream.id); setPlaying(false); }} />)}</section><StreamPlayer stream={selectedStream} playing={playing} onToggle={() => setPlaying((current) => !current)} /></div></div>;
}

function StreamCard({ stream, selected, onOpen }: { stream: StreamItem; selected: boolean; onOpen: () => void }) {
  return <article className={`stream-card ${selected ? "selected" : ""}`}><button className="stream-card-button" onClick={onOpen} aria-pressed={selected}><div className={`stream-preview ${stream.cover ? "has-cover" : ""}`}>{stream.cover ? <Image src={stream.cover} alt={`Обложка: ${stream.title}`} fill sizes="(max-width: 700px) 100vw, 50vw" className="stream-cover" /> : <div className="mini-candles"><i /><i /><i /><i /><i /></div>}<div className="stream-preview-label">{stream.isNew ? "НОВАЯ ЗАПИСЬ" : stream.kind.toUpperCase()}</div><span className="play-button" aria-hidden="true"><Play size={17} fill="currentColor" /></span><span className="stream-duration">{stream.duration}</span></div><div className="stream-card-copy"><span>{stream.module} · {stream.date}</span><h3>{stream.title}</h3><p>{stream.description}</p><div className="stream-progress"><i><b style={{ width: `${stream.progress}%` }} /></i><small>{stream.progress > 0 ? `${stream.progress}% просмотрено` : "Не начато"}</small></div></div></button></article>;
}

function StreamPlayer({ stream, playing, onToggle }: { stream: StreamItem; playing: boolean; onToggle: () => void }) {
  return <section className="content-panel stream-player-panel"><div className="stream-player-stage">{stream.cover && <Image src={stream.cover} alt="" fill sizes="(max-width: 950px) 100vw, 40vw" className="stream-player-cover" />}{!stream.cover && <div className="mini-candles player-candles"><i /><i /><i /><i /><i /></div>}<div className="stream-player-overlay" /><span className="stream-player-badge">{playing ? "ВОСПРОИЗВЕДЕНИЕ" : "ПРЕДПРОСМОТР"}</span><button className={`play-button large ${playing ? "is-playing" : ""}`} onClick={onToggle} aria-label={playing ? `Поставить на паузу: ${stream.title}` : `Воспроизвести: ${stream.title}`}><Play size={21} fill="currentColor" /></button><span className="stream-duration player-duration">{stream.duration}</span></div><div className="stream-player-copy"><div className="section-kicker">{stream.kind.toUpperCase()} · {stream.module}</div><h2>{stream.title}</h2><p>{stream.description}</p><div className="stream-player-progress"><div><span>Прогресс просмотра</span><strong>{stream.progress}%</strong></div><i><b style={{ width: `${stream.progress}%` }} /></i></div><div className="stream-player-actions"><button className="primary-button" onClick={onToggle}>{playing ? "Пауза" : stream.progress > 0 ? "Продолжить просмотр" : "Начать просмотр"} <Play size={15} fill="currentColor" /></button><span><LockKeyhole size={14} /> Доступно участникам практикума</span></div></div></section>;
}

function DiscussionView() {
  return <div className="section-grid"><section className="content-panel"><div className="section-heading"><div><span className="section-kicker">ПОТОК 04</span><h2>Последние обсуждения</h2></div><button className="primary-button compact-button"><Plus size={15} /> Новая тема</button></div><div className="discussion-list"><div className="discussion-row"><div className="profile-avatar">АК</div><div><strong>Как отличить возврат в зону от ложного пробоя?</strong><span>Алексей К. · 4 ответа · 18 минут назад</span></div><ChevronRight size={16} /></div><div className="discussion-row"><div className="profile-avatar curator">МК</div><div><strong>Дополнительное ДЗ по модулю 03</strong><span>Мария, куратор · 9 ответов · вчера</span></div><ChevronRight size={16} /></div><div className="discussion-row"><div className="profile-avatar">ЕС</div><div><strong>Поделитесь разметкой перед завтрашним стримом</strong><span>Елена С. · 6 ответов · вчера</span></div><ChevronRight size={16} /></div></div></section><section className="content-panel discussion-note"><div className="section-heading"><div><span className="section-kicker">ПРАВИЛА ОБЩЕНИЯ</span><h2>Рабочее пространство</h2></div><MessageSquareText size={18} className="heading-icon" /></div><p>Здесь удобно задавать вопросы по урокам и ДЗ. Для быстрых обсуждений и стримов пока используется Discord.</p><button className="secondary-button">Открыть Discord <ArrowUpRight size={15} /></button></section></div>;
}

function ChartScene() {
  const candles = [
    { x: 6, h: 82, top: 110, positive: true }, { x: 15, h: 44, top: 138, positive: false }, { x: 25, h: 100, top: 84, positive: true },
    { x: 35, h: 60, top: 124, positive: false }, { x: 45, h: 128, top: 52, positive: true }, { x: 55, h: 72, top: 104, positive: false },
    { x: 65, h: 91, top: 96, positive: true }, { x: 75, h: 54, top: 146, positive: false }, { x: 85, h: 138, top: 33, positive: true },
  ];
  return <section className="chart-panel" aria-label="Учебный график EUR/USD с уровнями поддержки и сопротивления"><div className="chart-topline"><span>EUR / USD</span><span className="chart-timeframe">1H <ChevronRight size={13} /></span></div><div className="chart-gridlines"><i /><i /><i /><i /></div><div className="resistance-line"><span>Сопротивление</span></div><div className="support-line"><span>Поддержка</span></div><div className="candles">{candles.map((candle) => <div className={`candle ${candle.positive ? "positive" : "negative"}`} key={candle.x} style={{ left: `${candle.x}%`, height: `${candle.h}px`, top: `${candle.top}px` }}><i /></div>)}</div><svg className="chart-path" viewBox="0 0 500 260" preserveAspectRatio="none" aria-hidden="true"><path d="M0 218 C44 215 44 170 85 177 S118 222 154 181 S195 103 225 131 S273 192 311 137 S346 66 372 111 S421 160 442 98 S475 35 500 18" /></svg><div className="chart-label chart-label-top">КЛЮЧЕВОЙ УРОВЕНЬ</div><div className="chart-label chart-label-bottom">Учебный пример · смотри на реакцию цены</div><div className="chart-axis"><span>09:00</span><span>12:00</span><span>15:00</span><span>18:00</span></div><div className="chart-scanline" /></section>;
}

function StatCard({ icon, label, value, detail, accent }: { icon: React.ReactNode; label: string; value: string; detail: string; accent: string }) {
  return <div className="stat-card"><div className={`stat-icon ${accent}`}>{icon}</div><div className="stat-copy"><span>{label}</span><strong className={`stat-value ${accent}`}>{value}</strong><small>{detail}</small></div></div>;
}

function AssignmentRow({ assignment, onOpen, selected = false }: { assignment: Assignment; onOpen?: () => void; selected?: boolean }) {
  return <button className={`assignment-row ${selected ? "selected" : ""}`} onClick={onOpen} aria-pressed={selected}><div className={`assignment-status ${assignment.tone}`}>{assignment.tone === "blue" ? <Clock3 size={16} /> : assignment.tone === "amber" ? <ArrowUpRight size={17} /> : <LockKeyhole size={15} />}</div><div className="assignment-copy"><strong>{assignment.title}</strong><span>{assignment.module}</span><small className="assignment-hint">{assignmentHint(assignment.status)}</small></div><div className={`assignment-badge ${assignment.tone}`}>{assignment.status}</div><span className="assignment-date">{assignment.date}</span><ChevronRight size={16} className="assignment-chevron" /></button>;
}

function assignmentHint(status: AssignmentStatus) {
  return status === "На проверке" ? "Отправлено сегодня" : status === "Нужна доработка" ? "Есть комментарий куратора" : status === "Не начато" ? "Откроется после модуля 03" : "Работа принята";
}

function AssignmentDetail({ assignment }: { assignment: Assignment }) {
  const [draft, setDraft] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const isAccepted = assignment.status === "Принято";
  const fileName = selectedFile?.name ?? "";
  const fileType = selectedFile?.type ?? "";
  useEffect(() => () => {
    if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl);
  }, [filePreviewUrl]);
  const handleFileChange = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setSelectedFile(null);
      setFilePreviewUrl("");
      setFileError("Файл слишком большой. Максимальный размер — 10 МБ.");
      return;
    }
    setFileError("");
    setSelectedFile(file);
    setFilePreviewUrl(URL.createObjectURL(file));
    setSaved(false);
    setSubmitted(false);
  };

  return <section className="content-panel assignment-detail"><div className="detail-header"><div><span className="section-kicker">{assignment.module}</span><h2>{assignment.title}</h2></div><div className={`assignment-badge ${assignment.tone}`}>{submitted ? "На проверке" : assignment.status}</div></div><div className="detail-meta"><span><Clock3 size={14} /> {assignment.deadline}</span><span><FileCheck2 size={14} /> {isAccepted ? "Проверено куратором" : "Одна попытка"}</span></div><div className="detail-body"><p className="detail-description">{assignment.description}</p><div className="detail-section"><span className="detail-label">ЧТО НУЖНО СДЕЛАТЬ</span><ul className="detail-checklist">{assignment.requirements.map((requirement) => <li key={requirement}><span />{requirement}</li>)}</ul></div>{isAccepted ? <div className="detail-feedback accepted"><Target size={17} /><div><strong>Задание принято</strong><p>Куратор подтвердил работу. Материал сохранён в истории практикума.</p></div></div> : <><div className="detail-section"><label className="detail-label" htmlFor="assignment-answer">ТВОЙ КОММЕНТАРИЙ</label><textarea id="assignment-answer" value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); setSubmitted(false); }} placeholder="Опиши логику решения или добавь контекст к файлу..." rows={5} /></div><label className={`file-dropzone ${fileName ? "has-file" : ""}`} htmlFor="assignment-file"><FileCheck2 size={19} /><span>{fileName || "Прикрепить разметку, PDF или видео"}</span><small>PNG, JPG, PDF, MP4 или WebM · до 10 МБ</small><input id="assignment-file" type="file" accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => handleFileChange(event.target.files?.[0])} /></label>{fileError && <div className="file-error" role="alert">{fileError}</div>}{filePreviewUrl && <div className="assignment-preview"><div className="assignment-preview-heading"><span>ПРЕДПРОСМОТР</span><strong>{fileName}</strong></div>{fileType.startsWith("image/") && <div className="assignment-preview-image-wrap"><Image src={filePreviewUrl} alt={`Предпросмотр файла ${fileName}`} fill sizes="(max-width: 700px) 100vw, 420px" unoptimized className="assignment-preview-image" /></div>}{fileType === "application/pdf" && <iframe src={filePreviewUrl} title={`Предпросмотр PDF ${fileName}`} />}{fileType.startsWith("video/") && <video src={filePreviewUrl} controls preload="metadata" />}</div>}{(saved || submitted) && <div className="detail-feedback"><Target size={17} /><div><strong>{submitted ? "Работа подготовлена к отправке" : "Черновик сохранён в этой сессии"}</strong><p>{submitted ? "После подключения API отправка будет доступна куратору и появится в истории попыток." : "Можно вернуться к заданию и продолжить подготовку ответа."}</p></div></div>}<div className="detail-actions"><button className="secondary-button" onClick={() => setSaved(true)} disabled={!draft.trim() && !fileName}>Сохранить черновик</button><button className="primary-button" onClick={() => setSubmitted(true)} disabled={!draft.trim() && !fileName}>Отправить на проверку <ChevronRight size={16} /></button></div></>}</div></section>;
}

function EventCard({ event, onOpen }: { event: (typeof studentDashboard.events)[number]; onOpen?: () => void }) {
  return <div className={`event-card ${event.live ? "" : "muted-event"}`}><div className="event-date"><strong>{event.day}</strong><span>{event.month}</span></div><div className="event-info"><div className="event-type">{event.live && <span className="live-dot" />} {event.type}</div><h3>{event.title}</h3><p><Clock3 size={14} /> {event.time}</p></div><button className="event-action" aria-label={`Открыть событие: ${event.title}`} onClick={onOpen}><ArrowUpRight size={17} /></button></div>;
}
