"use client";

import { createContext, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { io, type Socket } from "socket.io-client";
import {
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Bell,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  CornerUpLeft,
  Eye,
  EyeOff,
  FileCheck2,
  GraduationCap,
  LayoutDashboard,
  LockKeyhole,
  Maximize2,
  Menu,
  Minimize2,
  MessageSquareText,
  Play,
  Plus,
  Copy,
  Pencil,
  Radio,
  RotateCcw,
  Trash2,
  UserPlus,
  ShieldCheck,
  SmilePlus,
  MonitorSmartphone,
  Settings2,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import { curatorDashboard, type CuratorNav, type ReviewQueueItem } from "./data/curator-dashboard";
import { practicumModules, studentDashboard, type Assignment, type AssignmentStatus, type AssignmentTone, type DashboardNav, type PracticumModule, type PracticumSection, type ScheduleEvent, type StreamItem, type StreamKind } from "./data/student-dashboard";
import { calculatePracticumProgress } from "./domain/progress";
import { isDiscordUserId } from "./domain/discord";
import AuthPage from "./auth/page";

// All browser requests use the same-origin Next.js proxy. This keeps private media
// compatible with Helmet's cross-origin resource policy.
const API_ORIGIN = "";
// Next's dev-mode rewrite proxy can't forward a WebSocket upgrade, so local dev connects
// straight to the API (NEXT_PUBLIC_API_URL is set explicitly in .env for that reason).
// In staging/production this must stay empty — nginx proxies the same-origin /api path
// (including the upgrade headers) straight through to the API container; pointing this at
// an internal Docker hostname would be unreachable from the user's browser.
const SOCKET_ORIGIN = process.env.NEXT_PUBLIC_API_URL?.trim() || "";
const SOCKET_PATH = "/api/socket.io/";
const ASSIGNMENT_TARGET_MODULE_KEY = "curator-assignment-target-module";
const ASSIGNMENT_TARGET_LESSON_KEY = "curator-assignment-target-lesson";
const baseCuratorDashboard = curatorDashboard;
const defaultPracticumModules = practicumModules;
const defaultCourseModules: readonly CourseModule[] = defaultPracticumModules.map((module, position) => ({ ...module, position, coverPath: null }));

function getInitials(name: string, fallback: string): string {
  const initials = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials || fallback;
}

function pluralizeStudents(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ученик`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} ученика`;
  return `${count} учеников`;
}

type UserRole = "student" | "curator";
type AppNav = DashboardNav | CuratorNav | "Профиль";
type DiscussionContext = { module: string; lesson: string; coverPath?: string | null; moduleId?: string; lessonId?: string; assignmentId?: string };

// Identifies the current viewer on the on-screen video watermark (see TrackedVideo below).
const ViewerLabelContext = createContext<string>("");

/**
 * Drop-in replacement for a plain video <iframe>: overlays the viewer's name and a live
 * clock on top of the player (deters casual screen-recording redistribution — a frozen
 * screenshot still carries a real, current timestamp) and logs the open server-side via
 * `mediaId` so a leaked recording can be traced back to who actually opened it and when.
 * Sizing is intentionally generic (fills its container) so it drops into any existing
 * video-stage CSS unchanged.
 */
const TrackedVideo = forwardRef<HTMLDivElement, { mediaId?: string | null; src: string; title: string; className?: string }>(
  function TrackedVideo({ mediaId, src, title, className = "" }, forwardedRef) {
    const viewerLabel = useContext(ViewerLabelContext);
    const [clock, setClock] = useState(() => new Date().toLocaleString("ru-RU"));
    const loggedMediaId = useRef<string | null>(null);

    useEffect(() => {
      const timer = window.setInterval(() => setClock(new Date().toLocaleString("ru-RU")), 5_000);
      return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
      if (!mediaId || loggedMediaId.current === mediaId) return;
      loggedMediaId.current = mediaId;
      void fetch(`${API_ORIGIN}/api/course/media/${mediaId}/access`, { method: "POST", credentials: "include" }).catch(() => undefined);
    }, [mediaId]);

    // Forwards to the wrapper (not the iframe) so requesting fullscreen on this ref
    // still shows the watermark overlay instead of leaving it behind.
    return <div className={`tracked-video ${className}`} ref={forwardedRef}>
      <iframe src={src} title={title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      {viewerLabel && <div className="tracked-video-watermark" aria-hidden="true"><span>{viewerLabel}</span><span>{clock}</span></div>}
    </div>;
  },
);

type AppNotification = {
  id: string;
  type: "NEW_ASSIGNMENT" | "NEW_MEDIA" | "NEW_EVENT" | "DISCUSSION_REPLY" | "REVIEW_DECISION" | "STREAM_LIVE";
  title: string;
  body: string | null;
  entityId: string | null;
  read: boolean;
  createdAt: string;
};

const NOTIFICATION_ICON: Record<AppNotification["type"], { icon: typeof Bell; tone: string }> = {
  NEW_ASSIGNMENT: { icon: FileCheck2, tone: "blue" },
  NEW_MEDIA: { icon: Play, tone: "blue" },
  NEW_EVENT: { icon: CalendarDays, tone: "amber" },
  DISCUSSION_REPLY: { icon: MessageSquareText, tone: "blue" },
  REVIEW_DECISION: { icon: CheckCircle2, tone: "amber" },
  STREAM_LIVE: { icon: Radio, tone: "amber" },
};

function relativeTimeFromNow(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

type SessionProfile = {
  role: "STUDENT" | "CURATOR" | "OWNER";
  profile: {
    email: string | null;
    emailVerifiedAt: string | null;
    displayName: string | null;
    username: string | null;
    identities: Array<{
      provider: "DISCORD" | "LOCAL";
      displayName: string | null;
      username: string | null;
      avatarUrl: string | null;
    }>;
  };
};

const visibleStudentAssignments: Assignment[] = [];

type LessonVideo = {
  title: string;
  source: "vimeo" | "upload";
  url: string;
  duration: string;
};

type CourseLessonMedia = {
  id: string;
  scheduleEventId?: string | null;
  provider: string;
  kind: "LESSON_VIDEO" | "STREAM" | "QA" | "BREAKDOWN" | "TALKS";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  title: string | null;
  description: string | null;
  durationSec: number | null;
  position: number;
  publishedAt: string | null;
  embedUrl: string | null;
  thumbnailUrl: string | null;
};

type CourseLesson = {
  id: string;
  position: number;
  title: string;
  type: "TEXT" | "VIDEO" | "STREAM" | "ASSIGNMENT" | "QA";
  description: string | null;
  media: CourseLessonMedia[];
  assignments: Array<{
    id: string;
    title: string;
    description: string;
    requirements: string[];
    allowedFormats: string[];
    deadline: string | null;
  }>;
};

type CourseApiModule = {
  id: string;
  number: string;
  position: number;
  section: string;
  title: string;
  description: string | null;
  coverPath: string | null;
  locked: boolean;
  progress: number;
  status: string;
  lessons: CourseLesson[];
};

type CourseModule = PracticumModule & { position: number; coverPath: string | null };

type CourseScheduleEvent = { id: string; type: "PRACTICE" | "QA" | "BREAKDOWN" | "BACKTEST"; title: string; date: string; time: string; description: string; live: boolean; coverPath: string | null; recordingAvailable: boolean; recordings: Array<{ id: string; title: string | null; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; embedUrl: string | null; thumbnailUrl: string | null }>; bookedByStudentId: string | null; bookedByStudentName: string | null; isBookedByActor: boolean };
type CourseApiPayload = { data?: { modules?: CourseApiModule[]; media?: CourseLessonMedia[]; scheduleEvents?: CourseScheduleEvent[] } };

type CourseState = {
  modules: readonly CourseModule[];
  lessonsByModule: Readonly<Record<string, CourseLesson[]>>;
  globalMedia: CourseLessonMedia[];
  scheduleEvents: CourseScheduleEvent[];
};

function normalizeCourse(payload: CourseApiPayload): CourseState | null {
  const records = payload.data?.modules;
  if (!Array.isArray(records) || records.length === 0) return null;
  const modules = records.map((module): CourseModule => ({
    id: module.id,
    section: ["Welcome", "Education", "Q&A", "Practice"].includes(module.section) ? module.section as PracticumSection : "Education",
    number: module.number,
    title: module.title,
    status: module.status,
    progress: module.progress,
    lessons: module.lessons.length,
    description: module.description ?? "",
    locked: module.locked,
    position: module.position,
    coverPath: module.coverPath,
  }));
  const lessonsByModule = Object.fromEntries(records.map((module) => [module.id, module.lessons]));
  return { modules, lessonsByModule, globalMedia: payload.data?.media ?? [], scheduleEvents: payload.data?.scheduleEvents ?? [] };
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 1) return "Видео";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${remainingSeconds}` : `${minutes}:${remainingSeconds}`;
}

type MediaLibraryItem = LessonVideo & {
  id: string;
  type: "Запись стрима" | "Видеоразбор" | "Материал урока";
  kind: "stream" | "breakdown" | "file";
  module: string;
  lessonId: string;
  status: "Опубликовано" | "Черновик" | "Привязан к уроку";
  cover: string;
};

type NavItem = {
  label: AppNav;
  icon: typeof LayoutDashboard;
  badge?: string;
};

const navItems: NavItem[] = [
  { label: "Мой практикум", icon: GraduationCap },
  { label: "Задания", icon: FileCheck2 },
  { label: "Расписание", icon: CalendarDays },
  { label: "Стрим", icon: Radio },
  { label: "Записи", icon: Play },
  { label: "Обсуждение", icon: MessageSquareText },
];

const curatorNavItems: NavItem[] = [
  { label: "Кабинет куратора", icon: LayoutDashboard },
  { label: "Очередь проверки", icon: FileCheck2 },
  { label: "Создать задание", icon: Plus },
  { label: "Ученики", icon: GraduationCap },
  { label: "Программа", icon: BookOpen },
  { label: "Приглашения", icon: UserPlus },
  { label: "Расписание", icon: CalendarDays },
  { label: "Стримы", icon: Radio },
  { label: "Медиатека", icon: Play },
  { label: "Обсуждения", icon: MessageSquareText },
];

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessionProfile, setSessionProfile] = useState<SessionProfile | null>(null);
  const [role, setRole] = useState<UserRole>("student");
  const [activeNav, setActiveNav] = useState<AppNav>("Мой практикум");
  const [requestedAssignmentId, setRequestedAssignmentId] = useState("");
  const [requestedDiscussionContext, setRequestedDiscussionContext] = useState<DiscussionContext | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationWrapRef = useRef<HTMLDivElement>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingDiscussionCount, setPendingDiscussionCount] = useState(0);
  const [unlockedModuleIds] = useState(() => new Set(practicumModules.filter((module) => !module.locked).map((module) => module.id)));
  const currentNavItems = (role === "student" ? navItems : curatorNavItems).map((item) =>
    item.label === "Обсуждения" && pendingDiscussionCount > 0 ? { ...item, badge: String(pendingDiscussionCount) } : item);
  // Real logged-in identity (Discord displayName/username) for whoever is viewing — used
  // for both roles now. It used to only replace the student fixture's name; the curator
  // side kept the static "Мария К." fixture regardless of who was actually logged in.
  const liveDisplayName = sessionProfile?.profile.displayName ?? sessionProfile?.profile.username ?? (role === "student" ? "Ученик" : "Куратор");
  const viewerWatermarkLabel = sessionProfile
    ? [liveDisplayName, sessionProfile.profile.email].filter(Boolean).join(" · ")
    : "";
  const currentProfile = role === "student"
    ? { ...studentDashboard.learner, name: liveDisplayName, initials: getInitials(liveDisplayName, studentDashboard.learner.initials) }
    : { ...curatorDashboard.profile, name: liveDisplayName, initials: getInitials(liveDisplayName, curatorDashboard.profile.initials) };
  const currentAvatarUrl = sessionProfile?.profile.identities.find((identity) => identity.provider === "DISCORD")?.avatarUrl
    ?? sessionProfile?.profile.identities[0]?.avatarUrl
    ?? null;
  const openAssignments = visibleStudentAssignments.filter((assignment) => assignment.status !== "Принято");
  const acceptedAssignments = visibleStudentAssignments.length - openAssignments.length;
  useEffect(() => {
    const invitationToken = new URLSearchParams(window.location.search).get("invite");
    if (invitationToken) window.location.replace(`/auth?invite=${encodeURIComponent(invitationToken)}`);
  }, []);
  useEffect(() => {
    const checkSession = window.setTimeout(() => {
      void fetch(`${API_ORIGIN}/api/auth/session`, { credentials: "include", cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) {
            setAuthenticated(false);
            return;
          }
          const payload = await response.json() as { data?: SessionProfile };
          if (payload.data) {
            setSessionProfile(payload.data);
            const nextRole = payload.data.role === "STUDENT" ? "student" : "curator";
            setRole(nextRole);
            setActiveNav(nextRole === "student" ? "Мой практикум" : "Кабинет куратора");
            // Email notification links point at "/" with a query param (see ctaPath
            // comments in email-service.ts — /assignments, /schedule etc. aren't real
            // routes) instead of the in-app notification bell's setActiveNav() calls.
            // Resolve the same way here, once we know which role is looking.
            const linkParams = new URLSearchParams(window.location.search);
            const assignmentId = linkParams.get("assignmentId");
            const eventId = linkParams.get("eventId");
            const mediaId = linkParams.get("mediaId");
            const threadId = linkParams.get("threadId");
            const view = linkParams.get("view");
            if (assignmentId) {
              setRequestedAssignmentId(assignmentId);
              setActiveNav("Задания");
            } else if (eventId) {
              setActiveNav("Расписание");
            } else if (mediaId) {
              setActiveNav("Записи");
            } else if (threadId) {
              setActiveNav(nextRole === "student" ? "Обсуждение" : "Обсуждения");
            } else if (view === "profile") {
              // /verify-email's "Вернуться в платформу" link lands here so the confirmed
              // account screen shows up directly, instead of the generic dashboard.
              setActiveNav("Профиль");
            }
            if (assignmentId || eventId || mediaId || threadId || view) {
              window.history.replaceState(null, "", window.location.pathname);
            }
          }
          setAuthenticated(true);
        })
        .catch(() => setAuthenticated(false));
    }, 0);
    return () => window.clearTimeout(checkSession);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const refresh = () => {
      void fetch(`${API_ORIGIN}/api/notifications`, { credentials: "include", cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ data?: { items: AppNotification[]; unreadCount: number } }> : null)
        .then((payload) => {
          if (cancelled || !payload?.data) return;
          setNotifications(payload.data.items);
          setUnreadCount(payload.data.unreadCount);
        })
        .catch(() => undefined);
    };
    refresh();
    const poll = window.setInterval(refresh, 30_000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [authenticated]);

  useEffect(() => {
    // The sidebar badge means "how many discussion threads are waiting on me right
    // now" — NEW or WAITING. It intentionally doesn't reuse the notification bell's
    // unreadCount (that's every notification type ever left unread, not this).
    if (!authenticated || role !== "curator") return;
    let cancelled = false;
    const refresh = () => {
      void fetch(`${API_ORIGIN}/api/discussions/manage`, { credentials: "include", cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ data?: Array<{ status: string }> }> : null)
        .then((payload) => {
          if (cancelled || !payload?.data) return;
          setPendingDiscussionCount(payload.data.filter((thread) => thread.status === "NEW" || thread.status === "WAITING").length);
        })
        .catch(() => undefined);
    };
    refresh();
    const poll = window.setInterval(refresh, 30_000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [authenticated, role]);

  useEffect(() => {
    if (!showNotifications) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!notificationWrapRef.current?.contains(event.target as Node)) setShowNotifications(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showNotifications]);

  const openNotification = (item: AppNotification) => {
    setShowNotifications(false);
    if (!item.read) {
      void fetch(`${API_ORIGIN}/api/notifications/${item.id}/read`, { method: "POST", credentials: "include" }).catch(() => undefined);
      setNotifications((current) => current.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry));
      setUnreadCount((current) => Math.max(0, current - 1));
    }
    if (item.type === "NEW_ASSIGNMENT" || item.type === "REVIEW_DECISION") {
      if (item.entityId) setRequestedAssignmentId(item.entityId);
      setActiveNav("Задания");
    } else if (item.type === "NEW_MEDIA") {
      setActiveNav("Записи");
    } else if (item.type === "NEW_EVENT") {
      setActiveNav("Расписание");
    } else if (item.type === "DISCUSSION_REPLY") {
      setActiveNav(role === "student" ? "Обсуждение" : "Обсуждения");
    } else if (item.type === "STREAM_LIVE") {
      setActiveNav(role === "student" ? "Стрим" : "Стримы");
    }
  };

  if (authenticated === null) {
    return <div className="auth-loading" aria-busy="true" />;
  }

  if (!authenticated) {
    return <AuthPage />;
  }

  const logout = () => {
    void fetch(`${API_ORIGIN}/api/auth/logout`, { method: "POST", credentials: "include" })
      .finally(() => setAuthenticated(false));
  };

  const switchRole = (nextRole: UserRole) => {
    const sessionRole: UserRole = sessionProfile?.role === "STUDENT" ? "student" : "curator";
    if (nextRole !== sessionRole) {
      void fetch(`${API_ORIGIN}/api/auth/logout`, { method: "POST", credentials: "include" })
        .finally(() => window.location.assign("/auth"));
      return;
    }

    setRole(nextRole);
    setActiveNav(nextRole === "student" ? "Мой практикум" : "Кабинет куратора");
    setMenuOpen(false);
  };

  return (
    <ViewerLabelContext.Provider value={viewerWatermarkLabel}>
    <main className="app-shell">
      <div className="logo-mosaic" aria-hidden="true">
        {Array.from({ length: 180 }, (_, index) => <span key={index} />)}
      </div>
      <aside className={`sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark brand-wordmark"><Image src="/fix-wordmark.png" alt="FIX" width={52} height={24} priority /></div>
          <div className="brand-caption brand-caption-side">PRACTICE PLATFORM</div>
          <button className="icon-button sidebar-close" aria-label="Закрыть меню" onClick={() => setMenuOpen(false)}>
            <X size={18} />
          </button>
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
                  if (role === "student" && item.label === "Обсуждение") setRequestedDiscussionContext(null);
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
          <div className="role-preview" aria-label="Режим просмотра интерфейса">
            <span>РЕЖИМ ПРОСМОТРА</span>
            <div className="role-preview-tabs">
              <button className={role === "student" ? "active" : ""} onClick={() => switchRole("student")}>Ученик</button>
              <button className={role === "curator" ? "active" : ""} onClick={() => switchRole("curator")}>Куратор</button>
            </div>
          </div>
          {role === "student" && <button className="support-card" type="button" onClick={() => { setActiveNav("Обсуждение"); setRequestedDiscussionContext(null); setMenuOpen(false); }}>
            <span className="support-card-label">НАПИСАТЬ КУРАТОРУ</span>
            <span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span>
          </button>}
        </div>
      </aside>

      <section className="content-area">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Открыть меню" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumbs"><span>Практикум 04</span><ChevronRight size={14} /><strong>{activeNav}</strong></div>
          <div className="topbar-actions">
            <div className="notification-wrap" ref={notificationWrapRef}>
              <button className="icon-button notification-button" aria-label="Уведомления" onClick={() => setShowNotifications((value) => !value)}>
                <Bell size={18} />{unreadCount > 0 && <span className="notification-dot" />}
              </button>
              {showNotifications && (
                <div className="notification-popover">
                  <div className="popover-heading"><strong>Уведомления</strong><span>{unreadCount > 0 ? `${unreadCount} новых` : "Всё прочитано"}</span></div>
                  {notifications.length === 0 && <div className="notification-empty">Пока нет уведомлений</div>}
                  {notifications.map((item) => {
                    const meta = NOTIFICATION_ICON[item.type];
                    const Icon = meta.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        className={`notification-item${item.read ? "" : " unread"}`}
                        onClick={() => openNotification(item)}
                      >
                        <div className={`notification-symbol ${meta.tone}`}><Icon size={15} /></div>
                        <div><strong>{item.title}</strong><span>{item.body ? `${item.body} · ${relativeTimeFromNow(item.createdAt)}` : relativeTimeFromNow(item.createdAt)}</span></div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button className="topbar-user" type="button" onClick={() => setActiveNav("Профиль")} title="Открыть профиль">{currentAvatarUrl ? <Image className="profile-avatar small profile-avatar-image" src={currentAvatarUrl} alt={currentProfile.name} width={29} height={29} unoptimized /> : <div className="profile-avatar small">{currentProfile.initials}</div>}<span className="topbar-logout-label">Профиль</span><ChevronRight size={15} /></button>
          </div>
        </header>

        <div className={`page-content ${activeNav === "Мой практикум" ? "course-page-shell" : ""}`}>
          {activeNav === "Профиль" && sessionProfile && <ProfileView profile={sessionProfile.profile} name={currentProfile.name} initials={currentProfile.initials} role={role} onProfileUpdated={(profile) => setSessionProfile((current) => current ? { ...current, profile: { ...current.profile, ...profile } } : current)} onLogout={logout} />}
          {role === "student" && activeNav !== "Обзор" && activeNav !== "Профиль" && <SectionView activeNav={activeNav as DashboardNav} unlockedModuleIds={unlockedModuleIds} requestedAssignmentId={requestedAssignmentId} requestedDiscussionContext={requestedDiscussionContext} onNavigate={(nextNav) => setActiveNav(nextNav)} onOpenAssignment={(assignmentId) => { setRequestedAssignmentId(assignmentId); setActiveNav("Задания"); }} onOpenDiscussion={(context) => { setRequestedDiscussionContext(context); setActiveNav("Обсуждение"); }} onCloseDiscussionContext={() => setRequestedDiscussionContext(null)} />}
          {role === "curator" && activeNav !== "Профиль" && <CuratorSectionView activeNav={activeNav as CuratorNav} onNavigate={(nextNav) => setActiveNav(nextNav)} />}
          <div className={role === "student" && activeNav === "Обзор" ? "dashboard-view" : "dashboard-view is-hidden"}>
          <div className="welcome-row">
            <div>
              <div className="eyebrow"><Sparkles size={14} /> ЛИЧНЫЙ КАБИНЕТ</div>
              <h1>Добрый вечер, {currentProfile.name.split(" ")[0]}</h1>
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

          <div className="bottom-strip"><div><span className="section-kicker">ТВОЯ ТОЧКА</span><strong>{studentDashboard.lastActivity}</strong></div><button className="text-button" onClick={() => setActiveNav("Записи")}>Продолжить просмотр <Play size={14} /></button></div>
          </div>
        </div>
      </section>
    </main>
    </ViewerLabelContext.Provider>
  );
}

function ProfileView({ profile, name, initials, role, onProfileUpdated, onLogout }: {
  profile: SessionProfile["profile"];
  name: string;
  initials: string;
  role: UserRole;
  onProfileUpdated: (profile: Pick<SessionProfile["profile"], "email" | "emailVerifiedAt">) => void;
  onLogout: () => void;
}) {
  const [email, setEmail] = useState(profile.email ?? "");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [backtestBooking, setBacktestBooking] = useState<ScheduleEvent | null | undefined>(undefined);
  const connectedIdentity = profile.identities.find((identity) => identity.provider === "DISCORD") ?? profile.identities[0];

  useEffect(() => {
    if (role !== "student") return;
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/schedule`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: ScheduleApiEvent[] };
      if (cancelled || !Array.isArray(payload.data)) return;
      const events = payload.data.map(scheduleApiToUi);
      setBacktestBooking(events.find((event) => event.type === "Бэктест" && event.isBookedByActor) ?? null);
    }).catch(() => { if (!cancelled) setBacktestBooking(null); });
    return () => { cancelled = true; };
  }, [role]);

  const saveEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setFeedback(null);
    try {
      const response = await fetch(`${API_ORIGIN}/api/auth/profile`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const payload = await response.json().catch(() => null) as { data?: { email: string | null; emailVerifiedAt: string | null; verificationSent: boolean }; message?: string } | null;
      if (!response.ok || !payload?.data) {
        throw new Error(payload?.message ?? "Не удалось сохранить почту");
      }
      onProfileUpdated(payload.data);
      const text = !payload.data.email
        ? "Почта удалена из профиля."
        : payload.data.verificationSent
          ? "Почта сохранена. Проверьте входящие и подтвердите адрес по ссылке из письма."
          : "Почта сохранена, но письмо подтверждения не отправлено. Проверьте настройки почтового сервиса.";
      setFeedback({ tone: "success", text });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "Не удалось сохранить почту" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="workspace-view profile-page">
      <div className="workspace-view-heading profile-page-heading">
        <div>
          <span className="eyebrow"><Settings2 size={14} /> ЛИЧНЫЕ ДАННЫЕ</span>
          <h1>Профиль</h1>
          <p>Управляй контактами и смотри, какой аккаунт подключён к учебному пространству.</p>
        </div>
      </div>

      <div className="profile-hero content-panel">
        {connectedIdentity?.avatarUrl ? <Image className="profile-avatar large profile-avatar-image" src={connectedIdentity.avatarUrl} alt={name} width={64} height={64} unoptimized /> : <div className="profile-avatar large">{initials}</div>}
        <div className="profile-hero-copy">
          <span className="section-kicker">УЧЁТНАЯ ЗАПИСЬ</span>
          <h2>{name}</h2>
        </div>
      </div>

      <div className="profile-settings-grid">
        <section className="content-panel profile-card">
          <div className="section-heading">
            <div><span className="section-kicker">АВТОРИЗАЦИЯ</span><h2>Подключённый аккаунт</h2></div>
            <ShieldCheck size={19} className="profile-card-icon" />
          </div>
          {connectedIdentity ? (
            <div className="identity-row">
              {connectedIdentity.avatarUrl ? <Image className="identity-mark identity-avatar" src={connectedIdentity.avatarUrl} alt={connectedIdentity.displayName ?? "Discord"} width={32} height={32} unoptimized /> : <div className="identity-mark">{connectedIdentity.provider === "DISCORD" ? "D" : "ID"}</div>}
              <div className="identity-copy">
                <strong>{connectedIdentity.provider === "DISCORD" ? "Discord" : connectedIdentity.provider}</strong>
                <span>{connectedIdentity.displayName ?? connectedIdentity.username ?? "Аккаунт подключён"}</span>
              </div>
              <span className="profile-status success">Подключён</span>
            </div>
          ) : (
            <div className="profile-empty-state">Внешний аккаунт ещё не подключён.</div>
          )}
          <p className="profile-help">Discord используется для подтверждения личности. Изменить его из профиля нельзя.</p>
        </section>

        <section className="content-panel profile-card">
          <div className="section-heading">
            <div><span className="section-kicker">УВЕДОМЛЕНИЯ</span><h2>Email для связи</h2></div>
            <Bell size={19} className="profile-card-icon" />
          </div>
          <form className="profile-email-form" onSubmit={saveEmail}>
            <label className="form-field"><span>Почта</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" /></label>
            <div className="profile-email-meta"><span>{profile.emailVerifiedAt ? "Почта подтверждена" : email ? "Почта ещё не подтверждена" : "Почта не указана"}</span><button className="support-card" type="submit" disabled={saving}><span className="support-card-label">{saving ? "Сохраняем…" : "Сохранить почту"}</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button></div>
            {feedback && <div className={`profile-feedback ${feedback.tone}`}>{feedback.text}</div>}
          </form>
          <p className="profile-help">На этот адрес будут приходить уведомления о новых заданиях, стримах, обсуждениях и проверке работы.</p>
        </section>

        {role === "student" && backtestBooking !== undefined && (
          <section className="content-panel profile-card">
            <div className="section-heading">
              <div><span className="section-kicker">ИНДИВИДУАЛЬНЫЙ ЗВОНОК</span><h2>Бэктест с куратором</h2></div>
              <Target size={19} className="profile-card-icon" />
            </div>
            <div className="identity-row">
              <div className="identity-mark">{backtestBooking ? "1" : "0"}</div>
              <div className="identity-copy">
                <strong>{backtestBooking ? "1 из 1 использовано" : "0 из 1 использовано"}</strong>
                <span>{backtestBooking ? `Записан на ${formatEventDate(backtestBooking.date)}, ${backtestBooking.time}` : "Свободный слот можно выбрать в разделе «Расписание»."}</span>
              </div>
              <span className={`profile-status ${backtestBooking ? "success" : ""}`}>{backtestBooking ? "Забронировано" : "Не использован"}</span>
            </div>
            <p className="profile-help">На весь практикум доступен один индивидуальный разбор бэктеста с куратором.</p>
          </section>
        )}
      </div>

      <div className="profile-actions"><button className="secondary-button" type="button" onClick={onLogout}>Выйти из аккаунта <ArrowUpRight size={16} /></button></div>
    </div>
  );
}

function SectionView({ activeNav, unlockedModuleIds, requestedAssignmentId, requestedDiscussionContext, onNavigate, onOpenAssignment, onOpenDiscussion, onCloseDiscussionContext }: { activeNav: string; unlockedModuleIds: ReadonlySet<string>; requestedAssignmentId: string; requestedDiscussionContext: DiscussionContext | null; onNavigate: (nextNav: DashboardNav) => void; onOpenAssignment: (assignmentId: string) => void; onOpenDiscussion: (context: DiscussionContext) => void; onCloseDiscussionContext: () => void }) {
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
    "Расписание": {
      kicker: "СОБЫТИЯ ПОТОКА",
      title: "Расписание",
      description: "Записывайся на практические части и возвращайся к записям конференций в удобное время.",
    },
    "Стрим": {
      kicker: "ПРЯМОЙ ЭФИР",
      title: "Стрим",
      description: "Здесь появляется прямой эфир потока и чат, когда куратор начинает трансляцию.",
    },
    "Записи": {
      kicker: "БИБЛИОТЕКА ЗАПИСЕЙ",
      title: "Записи",
      description: "Записи практических эфиров, разборов и дополнительных встреч в одном месте.",
    },
    "Обсуждение": {
      kicker: "РАБОЧЕЕ ОБЩЕНИЕ",
      title: "Обсуждение",
      description: "Задавай вопросы по материалам и находи ответы от куратора и участников потока.",
    },
  }[activeNav as "Мой практикум" | "Задания" | "Расписание" | "Стрим" | "Записи" | "Обсуждение"];

  return <div className={`workspace-view ${activeNav === "Мой практикум" || activeNav === "Задания" || activeNav === "Расписание" || activeNav === "Стрим" || activeNav === "Записи" || activeNav === "Обсуждение" ? "learner-course-view" : ""}`}>
     <div className={`workspace-view-heading ${activeNav === "Обсуждение" ? "discussion-page-heading" : activeNav === "Задания" ? "assignment-page-heading" : activeNav === "Расписание" ? "schedule-page-heading" : activeNav === "Стрим" ? "live-stream-page-heading" : activeNav === "Записи" ? "stream-page-heading" : ""}`}><div><span className="eyebrow"><Sparkles size={14} /> {viewContent?.kicker}</span><h1>{viewContent?.title}</h1><p>{viewContent?.description}</p></div></div>
    {activeNav === "Мой практикум" && <CourseView unlockedModuleIds={unlockedModuleIds} onOpenAssignment={onOpenAssignment} onOpenDiscussion={onOpenDiscussion} />}
    {activeNav === "Задания" && <AssignmentsView requestedAssignmentId={requestedAssignmentId} />}
    {activeNav === "Расписание" && <ScheduleView onOpenStreams={(recordingId) => { if (typeof window !== "undefined" && recordingId) window.sessionStorage.setItem("fix-target-stream", recordingId); onNavigate("Записи"); }} onJoinLive={() => onNavigate("Стрим")} />}
    {activeNav === "Стрим" && <StudentLiveStreamView onNavigate={onNavigate} />}
    {activeNav === "Записи" && <StreamsView />}
    {activeNav === "Обсуждение" && (requestedDiscussionContext ? <DiscussionContextBanner context={requestedDiscussionContext} onOpenHistory={onCloseDiscussionContext} /> : <DiscussionViewDb onOpenDiscussion={onOpenDiscussion} />)}
  </div>;
}

function CuratorSectionView({ activeNav, onNavigate }: { activeNav: CuratorNav; onNavigate: (nextNav: CuratorNav) => void }) {
  const headings: Record<CuratorNav, { kicker: string; title: string; description: string }> = {
    "Кабинет куратора": { kicker: "РАБОЧИЙ ЦЕНТР", title: "Кабинет куратора", description: "Все работы, ученики и обратная связь по потоку собраны в одном рабочем контуре." },
    "Очередь проверки": { kicker: "ПРОВЕРКА ДЗ", title: "Очередь проверки", description: "Начни с работ, которые ученики отправили сегодня, и не теряй контекст предыдущих попыток." },
    "Создать задание": { kicker: "НОВАЯ РАБОТА", title: "Создать задание", description: "Собери понятное ДЗ с критериями, сроком и форматом ответа для всего потока." },
    "Ученики": { kicker: "ПОТОК 04", title: "Ученики", description: "Прогресс, активность и история обратной связи по каждому участнику практикума." },
    "Программа": { kicker: "ДОСТУП К ПРОГРАММЕ", title: "Программа", description: "Управление доступностью модулей для участников потока." },
    "Приглашения": { kicker: "ДОСТУП К ПОТОКУ", title: "Приглашения", description: "Создавай персональные ссылки для новых участников и контролируй срок их действия." },
    "Расписание": { kicker: "СОБЫТИЯ ПОТОКА", title: "Расписание", description: "Стримы, групповые проверки и встречи, которые нужно подготовить для потока." },
    "Стримы": { kicker: "ЭФИРЫ ПОТОКА", title: "Стримы", description: "Ближайшие эфиры и записи, которые видят ученики этого потока." },
    "Медиатека": { kicker: "МАТЕРИАЛЫ", title: "Медиатека", description: "Записи эфиров и видеоразборы, привязанные к урокам и работам учеников." },
    "Обсуждения": { kicker: "ОБРАТНАЯ СВЯЗЬ", title: "Обсуждения", description: "Вопросы учеников, ответы куратора и контекст уроков собраны в одном рабочем inbox." },
  };
  const heading = headings[activeNav] ?? headings["Кабинет куратора"];

  const headingClass = activeNav === "Обсуждения" ? "curator-discussion-page-heading" : activeNav === "Медиатека" ? "media-page-heading" : activeNav === "Расписание" ? "schedule-page-heading" : activeNav === "Стримы" ? "curator-streams-page-heading" : activeNav === "Кабинет куратора" ? "curator-dashboard-page-heading" : activeNav === "Очередь проверки" ? "curator-queue-page-heading" : activeNav === "Создать задание" ? "curator-create-page-heading" : activeNav === "Ученики" ? "curator-students-page-heading" : activeNav === "Приглашения" ? "curator-invite-page-heading" : "";
  return <div className="workspace-view learner-course-view"><div className={`workspace-view-heading ${headingClass}`}><div><span className="eyebrow"><Sparkles size={14} /> {heading.kicker}</span><h1>{heading.title}</h1><p>{heading.description}</p></div></div>{activeNav === "Кабинет куратора" && <CuratorReviewWorkspace overview onNavigate={onNavigate} />} {activeNav === "Очередь проверки" && <CuratorReviewWorkspace compact onNavigate={onNavigate} />} {activeNav === "Создать задание" && <CreateAssignmentView onNavigate={onNavigate} />} {activeNav === "Ученики" && <CuratorStudentsView onInvite={() => onNavigate("Приглашения")} />} {activeNav === "Программа" && <CuratorModuleAccessView onNavigate={onNavigate} />} {activeNav === "Приглашения" && <CuratorInvitationsView />} {activeNav === "Расписание" && <CuratorScheduleView onNavigate={onNavigate} />} {activeNav === "Стримы" && <CuratorStreamsView onNavigate={onNavigate} />} {activeNav === "Медиатека" && <CuratorMediaLibraryView />} {activeNav === "Обсуждения" && <CuratorDiscussionsView />} {activeNav !== "Кабинет куратора" && activeNav !== "Очередь проверки" && activeNav !== "Создать задание" && activeNav !== "Расписание" && activeNav !== "Стримы" && activeNav !== "Ученики" && activeNav !== "Программа" && activeNav !== "Приглашения" && activeNav !== "Медиатека" && activeNav !== "Обсуждения" && <CuratorPlaceholder title={heading.title} />}</div>;
}

async function fetchReviewQueue(): Promise<ReviewQueueItem[]> {
  const response = await fetch(`${API_ORIGIN}/api/review/submissions`, { credentials: "include", cache: "no-store" });
  if (!response.ok) return [];
  const payload = await response.json() as { data?: ReviewQueueItem[] };
  return payload.data ?? [];
}

type CuratorDiscussionStatus = "NEW" | "WAITING" | "ANSWERED" | "CLOSED";

type CuratorDiscussionMessage = {
  id: string;
  author: "student" | "curator";
  name: string;
  time: string;
  body: string;
  attachment?: string;
  attachmentPreview?: string;
  attachmentContentUrl?: string;
  attachmentSourceUrl?: string;
  attachmentEmbedUrl?: string;
};

type CuratorDiscussion = {
  id: string;
  title: string;
  student: string;
  initials: string;
  module: string;
  coverPath?: string | null;
  lesson: string;
  assignment?: string;
  status: CuratorDiscussionStatus;
  updatedAt: string;
  messages: CuratorDiscussionMessage[];
};

type DiscussionApiThread = {
  id: string;
  title: string;
  status: "NEW" | "WAITING" | "ANSWERED" | "CLOSED";
  module: { title: string; position: number; coverPath: string | null } | null;
  lesson: { title: string } | null;
  assignment: { title: string } | null;
  student: { name: string | null; email: string | null };
  messages: Array<{ id: string; authorRole: "STUDENT" | "CURATOR" | "OWNER"; authorName: string | null; body: string; createdAt: string; attachments: Array<{ originalName: string; mimeType: string; contentUrl: string | null; sourceUrl: string | null }> }>;
};

function mapDiscussionApiStatus(status: DiscussionApiThread["status"]): CuratorDiscussionStatus {
  return status;
}

function mapDiscussionApiThread(thread: DiscussionApiThread): CuratorDiscussion {
  const courseModule = thread.module ? `${String(thread.module.position).padStart(2, "0")} · ${thread.module.title}` : "Без модуля";
  return {
    id: thread.id,
    title: thread.title,
    student: thread.student.name ?? thread.student.email ?? "Ученик",
    initials: getInitials(thread.student.name ?? thread.student.email ?? "Ученик", "УЧ"),
    module: courseModule,
    coverPath: discussionCoverForModule(thread.module?.position, thread.module?.coverPath),
    lesson: thread.lesson?.title ?? "",
    assignment: thread.assignment?.title,
    status: mapDiscussionApiStatus(thread.status),
    updatedAt: thread.messages[thread.messages.length - 1]?.createdAt ? new Date(thread.messages[thread.messages.length - 1].createdAt).toLocaleString("ru-RU") : "только что",
    messages: thread.messages.map((message) => {
      const imageAttachment = message.attachments.find((attachment) => attachment.mimeType.startsWith("image/") && attachment.contentUrl);
      const linkAttachment = message.attachments.find((attachment) => attachment.sourceUrl);
      const firstAttachment = message.attachments[0];
      return {
        id: message.id,
        author: message.authorRole === "STUDENT" ? "student" : "curator",
        name: message.authorName ?? (message.authorRole === "STUDENT" ? "Ученик" : "Куратор"),
        time: new Date(message.createdAt).toLocaleString("ru-RU"),
        body: message.body,
        attachment: firstAttachment?.originalName,
        attachmentPreview: imageAttachment?.contentUrl ?? undefined,
        attachmentContentUrl: firstAttachment?.contentUrl ?? undefined,
        attachmentSourceUrl: linkAttachment?.sourceUrl ?? undefined,
        attachmentEmbedUrl: linkAttachment?.sourceUrl ? assignmentMaterialEmbed(linkAttachment.sourceUrl) ?? undefined : undefined,
      };
    }),
  };
}

function discussionBodyEmbedUrl(body: string): string | undefined {
  const url = body.match(/https?:\/\/[^\s<>()]+/i)?.[0]?.replace(/[.,!?;:]+$/, "");
  return url ? assignmentMaterialEmbed(url) ?? undefined : undefined;
}

function DiscussionMessageAttachments({ message }: { message: CuratorDiscussionMessage }) {
  const embedUrl = message.attachmentEmbedUrl ?? discussionBodyEmbedUrl(message.body);
  return <>
    {message.attachmentPreview && <div className="discussion-message-image" role="group" aria-label={`Предпросмотр вложения ${message.attachment ?? "изображение"}`}><Image src={message.attachmentPreview} alt={message.attachment ?? "Вложенное изображение"} fill sizes="(max-width: 700px) 100vw, 640px" unoptimized /></div>}
    {embedUrl && <div className="discussion-message-video"><iframe src={embedUrl} title="Видео в ответе куратора" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div>}
    {message.attachmentSourceUrl && !embedUrl && <a className="discussion-message-link" href={message.attachmentSourceUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={15} /><span>Открыть ссылку на материал</span></a>}
    {message.attachment && <div className="discussion-message-attachment"><FileCheck2 size={15} /><span>{message.attachment}</span><ArrowUpRight size={14} /></div>}
  </>;
}

const demoCuratorDiscussions: CuratorDiscussion[] = [
  {
    id: "discussion-1",
    title: "Как отличить возврат в зону от ложного пробоя?",
    student: "Алексей К.",
    initials: "АК",
    module: "01 · Контекст и структура рынка",
    lesson: "Market Logic: базовые принципы",
    status: "NEW",
    updatedAt: "18 минут назад",
    messages: [
      { id: "discussion-1-message-1", author: "student", name: "Алексей К.", time: "Сегодня, 12:06", body: "Подскажите, правильно ли я отметил возврат в зону на графике? Не понимаю, где заканчивается реакция и начинается ложный пробой.", attachment: "EURUSD-уровни.png", attachmentPreview: "/market-logic-cover.png" },
    ],
  },
  {
    id: "discussion-2",
    title: "Дополнительное ДЗ по модулю 03",
    student: "Мария К.",
    initials: "МК",
    module: "03 · Зоны поддержки и сопротивления",
    lesson: "Delivery A.B. Part 1&2",
    assignment: "Тестовое задание к первому уроку",
    status: "WAITING",
    updatedAt: "вчера",
    messages: [
      { id: "discussion-2-message-1", author: "student", name: "Мария К.", time: "Вчера, 17:42", body: "Я отправила работу повторно после комментария. Можно уточнить, нужно ли дополнительно описать сценарий отмены?" },
      { id: "discussion-2-message-2", author: "curator", name: "Мария · куратор", time: "Вчера, 18:01", body: "Да, добавь один короткий пример отмены сценария и отправь новую попытку. Вопрос оставляю открытым до проверки." },
    ],
  },
  {
    id: "discussion-3",
    title: "Поделитесь разметкой перед завтрашним стримом",
    student: "Елена С.",
    initials: "ЕС",
    module: "02 · Narrative и Reversal",
    lesson: "Практика с куратором",
    status: "ANSWERED",
    updatedAt: "2 дня назад",
    messages: [
      { id: "discussion-3-message-1", author: "student", name: "Елена С.", time: "2 дня назад, 15:20", body: "Прикрепляю разметку, которую хочу разобрать на завтрашнем стриме." , attachment: "разметка-сценария.pdf" },
      { id: "discussion-3-message-2", author: "curator", name: "Мария · куратор", time: "2 дня назад, 15:45", body: "Получила. Добавлю этот пример в план разбора и отмечу его во время трансляции." },
    ],
  },
];

function curatorDiscussionStatusLabel(status: CuratorDiscussionStatus): string {
  return status === "NEW" ? "Новый вопрос" : status === "WAITING" ? "Ждёт ответа" : status === "CLOSED" ? "Вопрос закрыт" : "Отвечен";
}

function CuratorDiscussionsView() {
  const [threads, setThreads] = useState<CuratorDiscussion[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [filter, setFilter] = useState<"all" | CuratorDiscussionStatus>("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(demoCuratorDiscussions[0]?.id ?? "");
  const [reply, setReply] = useState("");
  const [replySaving, setReplySaving] = useState(false);
  const [replyError, setReplyError] = useState("");
  // Derived only from real threads — the old seed also mixed in `defaultPracticumModules`
  // (static demo data), which drifts out of sync with the actual course structure and
  // cluttered the filter with modules that no longer exist.
  const moduleOptions = Array.from(new Map(threads.map((thread) => [thread.module, thread.module] as const)).entries());
  const moduleThreads = moduleFilter === "all" ? threads : threads.filter((thread) => thread.module === moduleFilter);
  const visibleThreads = filter === "all" ? moduleThreads : moduleThreads.filter((thread) => thread.status === filter);
  const selectedThread = visibleThreads.find((thread) => thread.id === selectedId) ?? visibleThreads[0];

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/discussions/manage`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread[]; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось загрузить обсуждения.");
      if (!cancelled) setThreads((payload.data ?? []).map(mapDiscussionApiThread));
    }).catch((error: unknown) => {
      if (!cancelled) setLoadError(error instanceof Error ? error.message : "Не удалось загрузить обсуждения.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = reply.trim();
    if (!body || !selectedThread || replySaving) return;
    setReplySaving(true);
    setReplyError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/discussions/${selectedThread.id}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить ответ.");
      const nextThread = mapDiscussionApiThread(payload.data);
      setThreads((current) => current.map((thread) => thread.id === nextThread.id ? nextThread : thread));
      setReply("");
    } catch (error: unknown) {
      setReplyError(error instanceof Error ? error.message : "Не удалось сохранить ответ.");
    } finally {
      setReplySaving(false);
    }
  };

  return <div className="curator-discussions">
    <div className="curator-discussion-summary">
      <div><strong>Вопросы по урокам и заданиям</strong><p>Сначала отвечай на новые вопросы, а полезные ответы позже можно опубликовать в общем Q&A.</p></div>
      <div className="curator-discussion-summary-stats"><span><b>{threads.filter((thread) => thread.status === "NEW" || thread.status === "WAITING").length}</b> требуют ответа</span><span><b>{threads.length}</b> всего тем</span></div>
    </div>
    <div className="curator-discussion-layout">
      <section className="content-panel curator-discussion-list-panel">
        <div className="section-heading"><div><h2>Темы обсуждений</h2></div><span className="progress-inline">{threads.length} темы</span></div>
        <div className="assignment-filter curator-discussion-filters">
          {(["all", "NEW", "WAITING", "ANSWERED"] as const).map((item) => {
            const count = item === "all" ? moduleThreads.length : moduleThreads.filter((thread) => thread.status === item).length;
            const label = item === "all" ? "Все" : curatorDiscussionStatusLabel(item);
            return <button className={`filter-chip ${filter === item ? "active" : ""}`} type="button" key={item} onClick={() => setFilter(item)} aria-pressed={filter === item}>{label} <span>{count}</span></button>;
          })}
          <label className="curator-discussion-module-filter"><span>Урок / модуль</span><select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}><option value="all">Все уроки</option>{moduleOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </div>
        <div className="curator-discussion-thread-list">{loading ? <div className="empty-state"><MessageSquareText size={22} /><strong>Загружаем обсуждения…</strong><span>Проверяем темы из базы данных.</span></div> : loadError ? <div className="empty-state"><MessageSquareText size={22} /><strong>Не удалось загрузить обсуждения</strong><span>{loadError}</span></div> : visibleThreads.length > 0 ? visibleThreads.map((thread) => <button className={`curator-discussion-thread-row ${thread.id === selectedThread?.id ? "selected" : ""}`} type="button" key={thread.id} onClick={() => setSelectedId(thread.id)}><div className={`profile-avatar ${thread.status === "ANSWERED" ? "curator" : ""} ${thread.coverPath ? "has-cover" : ""}`} style={thread.coverPath ? { backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.45), rgba(8,17,27,.85)), url("${thread.coverPath}")` } : undefined}>{!thread.coverPath && thread.initials}</div><div><strong>{thread.title}</strong><span>{thread.student} · {thread.module}</span><small>{thread.updatedAt} · {thread.messages.length} {thread.messages.length === 1 ? "сообщение" : "сообщения"}</small></div><b className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(thread.status)}</b><ChevronRight size={15} /></button>) : <div className="empty-state"><MessageSquareText size={22} /><strong>Обсуждений пока нет</strong><span>Новые вопросы появятся здесь после отправки учеником.</span></div>}</div>
      </section>
      {selectedThread ? <section className="content-panel curator-discussion-detail">
        <div className="curator-discussion-detail-head"><div><span className="section-kicker">{selectedThread.module}</span><h2>{selectedThread.title}</h2><p>{selectedThread.student}{selectedThread.lesson ? ` · ${selectedThread.lesson}` : ""}{selectedThread.assignment ? ` · ${selectedThread.assignment}` : ""}</p></div><span className={`curator-discussion-status ${selectedThread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(selectedThread.status)}</span></div>
        <div className="curator-discussion-module-cover" role="img" aria-label={`Обложка ${selectedThread.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(0,0,0,.9), rgba(0,0,0,.28)), url("${selectedThread.coverPath ?? discussionCoverForContext({ module: selectedThread.module, lesson: selectedThread.lesson })}")` }}><strong>{selectedThread.module}</strong>{selectedThread.lesson && <span>{selectedThread.lesson}</span>}</div>
        <div className="curator-discussion-context">{selectedThread.lesson && <span><BookOpen size={14} /> {selectedThread.lesson}</span>}{selectedThread.assignment && <span><FileCheck2 size={14} /> {selectedThread.assignment}</span>}<span><MessageSquareText size={14} /> Личная тема ученика</span></div>
        <div className="curator-discussion-messages">{selectedThread.messages.map((message) => <article className={`curator-discussion-message ${message.author}`} key={message.id}><div className="curator-discussion-message-meta"><strong>{message.name}</strong><span>{message.time}</span></div><p>{message.body}</p><DiscussionMessageAttachments message={message} /></article>)}</div>
        <form className="curator-discussion-reply" onSubmit={sendReply}><label htmlFor="curator-discussion-reply">ОТВЕТ КУРАТОРА</label><textarea id="curator-discussion-reply" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Напиши ответ и добавь ученику следующий шаг…" rows={4} /><div><span className="curator-discussion-draft-note"><FileCheck2 size={14} /> Ответ сохранится в истории этой темы</span><button className="primary-button" type="submit" disabled={!reply.trim() || replySaving}>{replySaving ? "Сохраняем…" : "Отправить ответ"} <ChevronRight size={15} /></button></div>{replyError && <div className="file-error" role="alert">{replyError}</div>}</form>
      </section> : <section className="content-panel curator-discussion-empty empty-state"><MessageSquareText size={22} /><strong>Выбери тему</strong><span>Справа появится история вопроса и форма ответа.</span></section>}
    </div>
  </div>;
}

function CuratorReviewWorkspace({ compact = false, overview = false, onNavigate }: { compact?: boolean; overview?: boolean; onNavigate?: (nextNav: CuratorNav) => void }) {
  const [filter, setFilter] = useState<"all" | AssignmentStatus>("all");
  const [studentFilter, setStudentFilter] = useState("");
  const [localQueue, setLocalQueue] = useState<ReviewQueueItem[]>([]);
  const [selectedId, setSelectedId] = useState(() => localQueue[0]?.id ?? "");
  const [studentCount, setStudentCount] = useState<number | null>(null);
  useEffect(() => {
    const handleSubmitted = (event: Event) => {
      if (event.type !== assignmentSubmittedEvent) return;
      void fetchReviewQueue().then((queue) => { setLocalQueue(queue); setSelectedId(queue[0]?.id ?? ""); }).catch(() => setLocalQueue([]));
    };
    void fetchReviewQueue().then((queue) => { setLocalQueue(queue); setSelectedId(queue[0]?.id ?? ""); }).catch(() => setLocalQueue([]));
    window.addEventListener(assignmentSubmittedEvent, handleSubmitted);
    return () => window.removeEventListener(assignmentSubmittedEvent, handleSubmitted);
  }, []);
  useEffect(() => {
    // The "Ученики в потоке" stat used to always show the fixture's static "18 учеников"
    // regardless of the real cohort size — same class of bug as the profile name below.
    void fetch(`${API_ORIGIN}/api/security/students`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: unknown[] }> : null)
      .then((payload) => { if (Array.isArray(payload?.data)) setStudentCount(payload.data.length); })
      .catch(() => undefined);
  }, []);
  const reviewCount = localQueue.filter((item) => item.status === "На проверке").length;
  const revisionCount = localQueue.filter((item) => item.status === "Нужна доработка").length;
  const acceptedCount = localQueue.filter((item) => item.status === "Принято").length;
  const curatorDashboard = {
    ...baseCuratorDashboard,
    queue: localQueue,
    stats: {
      ...baseCuratorDashboard.stats,
      review: String(reviewCount),
      reviewDetail: `${reviewCount} отправлено в тестовом контуре`,
      revision: String(revisionCount),
      revisionDetail: "Решения появятся после проверки",
      progress: String(acceptedCount),
      progressDetail: "Работы приняты",
    },
  };
  const studentOptions = useMemo(() => [...new Set(curatorDashboard.queue.map((item) => item.studentName).filter(Boolean))].sort((left, right) => left.localeCompare(right, "ru")), [curatorDashboard.queue]);
  const studentQueue = studentFilter ? curatorDashboard.queue.filter((item) => item.studentName === studentFilter) : curatorDashboard.queue;
  const filteredQueue = filter === "all" ? studentQueue : studentQueue.filter((item) => item.status === filter);
  const selectedItem = filteredQueue.find((item) => item.id === selectedId) ?? filteredQueue[0] ?? emptyReviewQueueItem;
  const filters: Array<{ id: "all" | AssignmentStatus; label: string }> = [
    { id: "all", label: "Все" },
    { id: "На проверке", label: "На проверке" },
    { id: "Нужна доработка", label: "Доработка" },
    { id: "Принято", label: "Принято" },
  ];

  const visibleQueue = overview ? filteredQueue.slice(0, 3) : filteredQueue;
  return <>
    {!compact && <div className="stats-grid curator-stats"><StatCard icon={<FileCheck2 size={17} />} label="Работы на проверке" value={curatorDashboard.stats.review} detail={curatorDashboard.stats.reviewDetail} accent="blue" /><StatCard icon={<RotateCcw size={17} />} label="Нужна доработка" value={curatorDashboard.stats.revision} detail={curatorDashboard.stats.revisionDetail} accent="amber" /><StatCard icon={<CheckCircle2 size={17} />} label="Принято" value={curatorDashboard.stats.progress} detail={curatorDashboard.stats.progressDetail} accent="cyan" /><StatCard icon={<GraduationCap size={17} />} label="Ученики в потоке" value={studentCount === null ? "—" : String(studentCount)} detail="Активные участники" accent="blue" /></div>}
    <div className="curator-workspace">
      <section className="content-panel review-queue">
        <div className="section-heading"><div><span className="section-kicker">{curatorDashboard.cohort.name.toUpperCase()}</span><h2>{overview ? "Последние работы" : "Очередь проверки"}</h2></div><div className="section-heading-actions"><span className="progress-inline">{studentCount === null ? "…" : pluralizeStudents(studentCount)}</span>{onNavigate && <button className="primary-button compact-button curator-create-assignment-button" onClick={() => onNavigate("Создать задание")}><Plus size={15} /> Создать задание</button>}</div></div>
        {!overview && <>
          <div className="assignment-filter curator-filter">{filters.map((item) => { const count = item.id === "all" ? studentQueue.length : studentQueue.filter((queueItem) => queueItem.status === item.id).length; return <button className={`filter-chip ${filter === item.id ? "active" : ""}`} key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{count}</span></button>; })}</div>
          <label className="review-student-filter"><span>Ученик</span><select value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)} aria-label="Фильтр очереди по ученику"><option value="">Все ученики</option>{studentOptions.map((student) => <option value={student} key={student}>{student}</option>)}</select></label>
        </>}
        <div className="review-queue-list">{visibleQueue.length > 0 ? visibleQueue.map((item) => <CuratorQueueRow item={item} selected={item.id === selectedItem.id} key={item.id} onOpen={() => setSelectedId(item.id)} />) : <div className="empty-state"><FileCheck2 size={22} /><strong>Очередь пуста</strong><span>{studentFilter ? "У выбранного ученика нет работ с таким статусом." : "Новые отправки появятся здесь после отправки задания учеником."}</span></div>}</div>
        {overview && onNavigate && <button className="text-button" onClick={() => onNavigate("Очередь проверки")}>Открыть всю очередь <ChevronRight size={15} /></button>}
      </section>
      {!overview && <CuratorReviewPanel item={selectedItem} key={selectedItem.id} />}
    </div>
  </>;
}

function CuratorQueueRow({ item, selected, onOpen }: { item: ReviewQueueItem; selected: boolean; onOpen: () => void }) {
  const modulePosition = Number.parseInt(item.module.slice(0, 2), 10);
  const coverPath = item.coverPath ?? discussionCoverForModule(Number.isNaN(modulePosition) ? undefined : modulePosition);
  return <button className={`review-queue-row ${selected ? "selected" : ""}`} onClick={onOpen} aria-pressed={selected}><div className={`profile-avatar review-queue-cover ${item.coverPath ? "has-cover" : ""}`} role="img" aria-label={`Обложка ${item.module}`} style={{ backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.28), rgba(8,17,27,.78)), url("${coverPath}")` }}>{!coverPath && item.studentInitials}</div><div className="review-queue-copy"><strong>{item.studentName}</strong><span>{item.assignmentTitle} · {item.module}</span><small>{item.submittedAt} · {item.attempt}</small></div><div className={`assignment-badge ${item.tone}`}>{item.status}</div><ChevronRight size={16} /></button>;
}

function formatAttemptCount(count: number) {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;
  if (lastDigit === 1 && lastTwoDigits !== 11) return `${count} попытка`;
  if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) return `${count} попытки`;
  return `${count} попыток`;
}

// Kept temporarily as a reference while the server-backed review panel is stabilized.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyCuratorReviewPanel({ item }: { item: ReviewQueueItem }) {
  const [feedback, setFeedback] = useState("");
  const [videoName, setVideoName] = useState("");
  const [decision, setDecisionState] = useState<"accepted" | "revision" | null>(null);
  const [decisionError, setDecisionError] = useState("");
  const [isSavingDecision, setIsSavingDecision] = useState(false);
  const isRevision = item.status === "Нужна доработка";

  const submitDecision = async (nextDecision: "accepted" | "revision") => {
    if (isSavingDecision) return;
    setDecisionError("");
    setIsSavingDecision(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/review/submissions/${item.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: nextDecision, feedback: feedback.trim() || undefined }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось сохранить решение.");
      setDecisionState(nextDecision);
      window.dispatchEvent(new Event(assignmentSubmittedEvent));
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "Не удалось сохранить решение.");
    } finally {
      setIsSavingDecision(false);
    }
  };

  const setDecision = (nextDecision: "accepted" | "revision" | null) => {
    if (nextDecision === null) {
      setDecisionState(null);
      setDecisionError("");
      return;
    }
    if (decisionError) setDecisionError("");
    void submitDecision(nextDecision);
  };

  if (!item.id) {
    return <section className="content-panel curator-review directory-empty"><div className="empty-state"><FileCheck2 size={24} /><strong>Очередь проверки пока пуста</strong><span>После отправки задания учеником работа появится здесь вместе с его ответом и вложениями.</span></div></section>;
  }

  return <section className="content-panel curator-review"><div className="curator-review-header"><div className="curator-student"><div className="profile-avatar">{item.studentInitials}</div><div><span className="section-kicker">{item.module}</span><strong>{item.studentName}</strong><small>Прогресс потока · {item.progress}</small></div></div><div className={`assignment-badge ${item.tone}`}>{decision === "accepted" ? "Принято" : decision === "revision" ? "Возвращено" : item.status}</div></div><div className="submission-meta"><span><Clock3 size={14} /> Отправлено {item.submittedAt}</span><span><FileCheck2 size={14} /> {item.attempt}</span></div><div className="curator-review-body"><div className="submission-section submission-answer-section"><span className="detail-label">КОММЕНТАРИЙ УЧЕНИКА</span><p className="submission-answer">{item.answer}</p><p className="student-note"><MessageSquareText size={14} /> {item.studentNote}</p></div><div className="submission-section"><span className="detail-label">ВЛОЖЕНИЯ</span><div className="submission-files">{item.attachments.length > 0 ? item.attachments.map((attachment) => { const file = item.attachmentFiles?.find((candidate) => candidate.name === attachment); return <div className={`submission-file-card ${file ? "has-preview" : ""}`} key={attachment}>{file?.type.startsWith("image/") && <><span className="visually-hidden">Предпросмотр изображения {file.name}</span><div className="submission-image-preview" role="img" aria-label={`Предпросмотр вложения ${file.name}`} style={{ backgroundImage: `url("${API_ORIGIN}${file.url}")` }} /></>}{file?.type.startsWith("video/") && <video src={`${API_ORIGIN}${file.url}`} controls preload="metadata" />}<a className="submission-file" href={file ? `${API_ORIGIN}${file.url}` : undefined} target={file ? "_blank" : undefined} rel={file ? "noreferrer" : undefined}><FileCheck2 size={16} /><span>{attachment}</span><ArrowUpRight size={14} /></a></div>; }) : <p className="submission-empty-file">Работа отправлена без вложений.</p>}</div>{item.attachments.length > 0 && <p className="attachment-preview-note">Файл доступен только участникам этой проверки.</p>}</div><div className="submission-section"><span className="detail-label">ИСТОРИЯ ПОПЫТОК</span><div className="attempt-history"><div><span className="attempt-dot done" /><div><strong>Попытка 1</strong><small>{item.submittedAt} · Отправлено на проверку</small></div></div><div><span className={`attempt-dot ${isRevision ? "current" : "muted"}`} /><div><strong>{item.attempt}</strong><small>{isRevision ? "Текущая работа требует внимания" : "Работа ожидает решения куратора"}</small></div></div></div></div><div className="curator-feedback"><label className="detail-label" htmlFor="curator-feedback">ОБРАТНАЯ СВЯЗЬ</label><textarea id="curator-feedback" value={feedback} onChange={(event) => { setFeedback(event.target.value); setDecision(null); }} placeholder="Напиши, что получилось и что нужно поправить..." rows={4} /><label className={`video-feedback ${videoName ? "has-file" : ""}`} htmlFor="curator-video"><Play size={17} /><span>{videoName || "Добавить видеоразбор"}</span><small>MP4 или WebM · до 500 МБ</small><input id="curator-video" type="file" accept="video/mp4,video/webm" onChange={(event) => setVideoName(event.target.files?.[0]?.name ?? "")} /></label>{decision && <div className="detail-feedback curator-decision"><Target size={17} /><div><strong>{decision === "accepted" ? "Работа принята" : "Работа возвращена на доработку"}</strong><p>В предпросмотре статус обновлён. В API это станет транзакцией с историей проверки и уведомлением ученика.</p></div></div>}<div className="curator-actions"><button className="secondary-button" disabled={!feedback.trim()} onClick={() => setDecision("revision")}>Вернуть на доработку</button><button className="primary-button" onClick={() => setDecision("accepted")}>Принять работу <ChevronRight size={16} /></button></div></div></div></section>;
}

function CuratorReviewPanel({ item }: { item: ReviewQueueItem }) {
  const [feedback, setFeedback] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [decision, setDecision] = useState<"accepted" | "revision" | null>(null);
  const [claimError, setClaimError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [checkedCriteria, setCheckedCriteria] = useState<boolean[]>(() => (item.requirements ?? []).map(() => false));
  const [previewFile, setPreviewFile] = useState<NonNullable<ReviewQueueItem["attachmentFiles"]>[number] | null>(null);
  const files = item.attachmentFiles ?? [];
  const currentAttemptNumber = Number.parseInt(item.attempt.replace(/\D/g, ""), 10) || 1;
  const attemptHistory = item.attemptHistory?.length ? item.attemptHistory : [{ attempt: currentAttemptNumber, status: item.status, submittedAt: item.submittedAt }];

  const canDecide = Boolean(item.reviewerId) && item.isReviewerSelf !== false;

  const submitDecision = async (nextDecision: "accepted" | "revision") => {
    if (!item.reviewerId) {
      setClaimError("Сначала возьмите работу на проверку.");
      return;
    }
    if (!canDecide) return;
    setDecisionError("");
    const checkedRequirements = (item.requirements ?? []).filter((_, index) => checkedCriteria[index]);
    try {
      const response = await fetch(`${API_ORIGIN}/api/review/submissions/${item.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: nextDecision, feedback: feedback.trim() || undefined, checkedRequirements: checkedRequirements.length > 0 ? checkedRequirements : undefined }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось сохранить решение.");
      setDecision(nextDecision);
      window.dispatchEvent(new Event(assignmentSubmittedEvent));
    } catch (error) {
      setDecisionError(error instanceof Error ? error.message : "Не удалось сохранить решение.");
    }
  };

  const claimWork = async () => {
    if (claiming) return;
    setClaiming(true);
    setClaimError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/review/submissions/${item.id}/claim`, { method: "POST", credentials: "include" });
      const payload = await response.json() as { data?: { reviewerId: string }; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось взять работу на проверку.");
      window.dispatchEvent(new Event(assignmentSubmittedEvent));
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "Не удалось взять работу на проверку.");
    } finally {
      setClaiming(false);
    }
  };

  if (!item.id) return <section className="content-panel curator-review directory-empty"><div className="empty-state"><FileCheck2 size={24} /><strong>Очередь проверки пока пуста</strong><span>После отправки задания работа появится здесь вместе с ответом и вложениями.</span></div></section>;

  return <section className="content-panel curator-review">
    {item.reviewerId ? (
      item.isReviewerSelf === false
        ? <div className="review-claim-banner review-claim-banner-other"><strong>Проверяет: {item.reviewerName ?? "другой куратор"}</strong><span>Работа закреплена за другим куратором — принять или вернуть на доработку нельзя.</span></div>
        : <div className="review-claim-banner"><strong>Проверяете вы</strong><span>Работа закреплена за вами.</span></div>
    ) : <button type="button" className="primary-button review-claim-button" onClick={() => void claimWork()} disabled={claiming}>{claiming ? "Закрепляем…" : "Взять на проверку"}</button>}
    {claimError && <div className="file-error" role="alert">{claimError}</div>}
    <div className="curator-review-header"><div className="curator-student"><div className="profile-avatar">{item.studentInitials}</div><div><span className="section-kicker">{item.module}</span><strong>{item.studentName}</strong><small>Прогресс потока · {item.progress}</small></div></div><div className={`assignment-badge ${item.tone}`}>{decision === "accepted" ? "Принято" : decision === "revision" ? "Возвращено" : item.status}</div></div>
    {item.coverPath && <div className="curator-review-cover" role="img" aria-label={`Обложка ${item.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(0,0,0,.92), rgba(0,0,0,.3)), url("${item.coverPath}")` }}><strong>{item.module}</strong><span>{item.assignmentTitle}</span></div>}
    <div className="submission-meta"><span><Clock3 size={14} /> Отправлено {item.submittedAt}</span><span><FileCheck2 size={14} /> {item.attempt}</span></div>
    <div className="curator-review-body">
      <div className="submission-section submission-answer-section"><span className="detail-label">КОММЕНТАРИЙ УЧЕНИКА</span><p className="submission-answer">{item.answer}</p><p className="student-note"><MessageSquareText size={14} /> {item.studentNote}</p></div>
      {item.requirements && item.requirements.length > 0 && <div className="submission-section review-criteria"><div className="review-section-heading"><div><span className="detail-label">КРИТЕРИИ ПРОВЕРКИ</span><small>{item.status === "Принято" ? "Отмечено на момент принятия работы — необязательно все." : "Необязательно: отметь то, что проверил. Работу можно принять и без всех галочек."}</small></div><strong>{(item.status === "Принято" ? (item.checkedRequirements?.length ?? 0) : checkedCriteria.filter(Boolean).length)}/{item.requirements.length}</strong></div><div className="review-criteria-list">{item.requirements.map((requirement, index) => { const checked = item.status === "Принято" ? (item.checkedRequirements?.includes(requirement) ?? false) : (checkedCriteria[index] ?? false); return <label className={`review-criteria-item ${checked ? "checked" : ""}`} key={`${item.id}-${requirement}`}><input type="checkbox" checked={checked} disabled={item.status === "Принято"} onChange={() => setCheckedCriteria((current) => current.map((value, currentIndex) => currentIndex === index ? !value : value))} /><span className="review-criteria-box">✓</span><span>{requirement}</span></label>; })}</div></div>}
      <div className="submission-section"><span className="detail-label">ВЛОЖЕНИЯ</span><div className="submission-files">
        {files.length > 0 ? files.map((file) => <div className="submission-file-card has-preview" key={file.id}>
          {file.type.startsWith("image/") && <div className="submission-image-preview"><Image src={`${API_ORIGIN}${file.url}`} alt={`Предпросмотр вложения ${file.name}`} fill sizes="(max-width: 700px) 100vw, 720px" unoptimized /></div>}
          {file.type.startsWith("video/") && <video src={`${API_ORIGIN}${file.url}`} controls preload="metadata" />}
          <button type="button" className="submission-file" onClick={() => setPreviewFile(file)}><FileCheck2 size={16} /><span>{file.name}</span><Maximize2 size={14} /></button>
        </div>) : item.attachments.length > 0 ? <div className="submission-legacy-file"><FileCheck2 size={16} /><div><strong>{[...new Set(item.attachments)].join(", ")}</strong><span>Это вложение сохранено до подключения защищённого хранилища. Попросите ученика отправить работу повторно.</span></div></div> : <p className="submission-empty-file">Работа отправлена без вложений.</p>}
      </div>{(files.length > 0 || item.attachments.length > 0) && <p className="attachment-preview-note">Предпросмотр открыт внутри платформы и доступен только участникам этой проверки.</p>}</div>
        <div className="submission-section review-history-section"><div className="review-section-heading"><div><span className="detail-label">ИСТОРИЯ ПОПЫТОК</span><small>Это одно и то же ДЗ: повторная отправка создаёт новую попытку, а не новую работу.</small></div><strong>{formatAttemptCount(attemptHistory.length)}</strong></div><div className="attempt-history">{attemptHistory.map((attempt) => { const isCurrent = attempt.attempt === currentAttemptNumber; const dotTone = attempt.status === "Принято" ? "done" : isCurrent ? "current" : "muted"; const statusLabel = attempt.status === "На проверке" ? "Отправлено на проверку" : attempt.status; return <div key={attempt.attempt}><span className={`attempt-dot ${dotTone}`} /><div><strong>Попытка {attempt.attempt}{isCurrent ? " · текущая" : ""}</strong><small>{attempt.submittedAt} · {statusLabel}</small></div></div>; })}</div></div>
      <div className="curator-feedback"><label className="detail-label" htmlFor="curator-feedback">ОБРАТНАЯ СВЯЗЬ</label><textarea id="curator-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder={item.status === "Принято" ? "Работа уже принята — история проверки доступна выше." : "Напиши, что получилось и что нужно поправить..."} rows={4} disabled={item.status === "Принято" || !canDecide} />{decisionError && <div className="file-error" role="alert">{decisionError}</div>}{item.status === "Принято" && <div className="detail-feedback curator-decision"><CheckCircle2 size={17} /><div><strong>Работа уже принята</strong><p>Повторная попытка для этого задания не создаётся. Все предыдущие ответы и комментарии сохранены в истории ученика.</p></div></div>}<div className="curator-actions"><button className="secondary-button" disabled={item.status === "Принято" || !canDecide || !feedback.trim()} onClick={() => void submitDecision("revision")}>Вернуть на доработку</button><button className="primary-button" disabled={item.status === "Принято" || !canDecide} onClick={() => void submitDecision("accepted")}>Принять работу <ChevronRight size={16} /></button></div></div>
    </div>
    {previewFile && <div className="attachment-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Просмотр файла ${previewFile.name}`} onMouseDown={(event) => { if (event.currentTarget === event.target) setPreviewFile(null); }}><div className="attachment-modal"><div className="video-modal-head"><strong>{previewFile.name}</strong><button className="icon-button" aria-label="Закрыть просмотр" onClick={() => setPreviewFile(null)}><X size={18} /></button></div>{previewFile.type.startsWith("image/") && <div className="attachment-modal-image" style={{ backgroundImage: `url("${API_ORIGIN}${previewFile.url}")` }} />}{previewFile.type.startsWith("video/") && <video src={`${API_ORIGIN}${previewFile.url}`} controls autoPlay playsInline />}{previewFile.type === "application/pdf" && <iframe src={`${API_ORIGIN}${previewFile.url}`} title={previewFile.name} />}</div></div>}
  </section>;
}

type StudentDirectoryRecord = {
  id: string;
  status: string;
  createdAt: string;
  email: string | null;
  identities: Array<{ provider: string; username: string | null; displayName: string | null }>;
  activeSessionCount: number;
  loginEventCount: number;
  submissionCount: number;
  assignedCurator: { id: string; name: string } | null;
  isAssignedToActor: boolean;
  canClaim: boolean;
  canTransfer: boolean;
  canViewDetails: boolean;
  lastSession: { lastActiveAt: string; deviceName: string | null; ipAddress: string | null; countryCode?: string | null; city: string | null } | null;
};

type CuratorDirectoryRecord = { id: string; name: string; email: string | null };

function formatRegion(city: string | null | undefined, countryCode: string | null | undefined): string {
  const parts = [city, countryCode].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(", ") : "Регион не определён";
}

function formatLoginEventLabel(outcome: string, reasonCode: string | null): string {
  if (outcome === "SUCCESS") return "Успешный вход";
  if (reasonCode === "DEVICE_APPROVAL_REQUIRED") return "Вход заблокирован";
  return outcome;
}

function formatLoginEventReason(reasonCode: string | null): string | null {
  if (reasonCode === "DEVICE_APPROVAL_REQUIRED") return "Новое устройство ожидает решения куратора";
  return reasonCode ? `Причина: ${reasonCode}` : null;
}

function CuratorStudentsView({ onInvite }: { onInvite: () => void }) {
  const [students, setStudents] = useState<StudentDirectoryRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [claimingStudentId, setClaimingStudentId] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const loadStudents = async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/security/students`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 403 ? "Нет прав для просмотра списка учеников." : "Не удалось загрузить список учеников.");
        const payload = await response.json() as { data: StudentDirectoryRecord[] };
        setStudents(payload.data);
        setSelectedId("");
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить список учеников.");
      } finally {
        setLoading(false);
      }
    };
    void loadStudents();
    return () => controller.abort();
  }, []);

  const selectedStudent = students.find((student) => student.id === selectedId) ?? students[0];
  const activeSessions = students.reduce((total, student) => total + student.activeSessionCount, 0);
  const submissions = students.reduce((total, student) => total + student.submissionCount, 0);

  const claimStudent = async (studentId: string) => {
    if (claimingStudentId) return;
    setClaimingStudentId(studentId);
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/students/${studentId}/claim`, {
        method: "POST",
        credentials: "include",
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось закрепить ученика.");

      const refreshed = await fetch(`${API_ORIGIN}/api/security/students`, { credentials: "include", cache: "no-store" });
      const refreshedPayload = await refreshed.json() as { data?: StudentDirectoryRecord[]; message?: string };
      if (!refreshed.ok || !Array.isArray(refreshedPayload.data)) {
        throw new Error(refreshedPayload.message ?? "Ученик закреплён, но список не удалось обновить.");
      }
      setStudents(refreshedPayload.data);
    } finally {
      setClaimingStudentId("");
    }
  };

  const transferStudent = async (studentId: string, curatorId: string) => {
    if (claimingStudentId) return;
    setClaimingStudentId(studentId);
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/students/${studentId}/assignment`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ curatorId }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось передать ученика.");

      const refreshed = await fetch(`${API_ORIGIN}/api/security/students`, { credentials: "include", cache: "no-store" });
      const refreshedPayload = await refreshed.json() as { data?: StudentDirectoryRecord[]; message?: string };
      if (!refreshed.ok || !Array.isArray(refreshedPayload.data)) {
        throw new Error(refreshedPayload.message ?? "Ученик передан, но список не удалось обновить.");
      }
      setStudents(refreshedPayload.data);
    } finally {
      setClaimingStudentId("");
    }
  };

  if (selectedStudent && selectedId) return <StudentDirectoryFullPage student={selectedStudent} onBack={() => setSelectedId("")} onClaim={claimStudent} onTransfer={transferStudent} claiming={claimingStudentId === selectedStudent.id} />;

  if (loading) return <section className="content-panel directory-empty"><div className="empty-state"><UsersRoundIcon /><strong>Загружаем учеников</strong><span>Проверяем доступ и получаем данные из базы.</span></div></section>;
  if (error) return <section className="content-panel directory-empty"><div className="empty-state"><ShieldCheck size={24} /><strong>{error}</strong><span>Список доступен владельцу и куратору только в рамках их прав.</span><button className="primary-button" onClick={onInvite}><UserPlus size={16} /> Открыть приглашения</button></div></section>;
  if (students.length === 0) return <section className="content-panel directory-empty"><div className="empty-state"><UsersRoundIcon /><strong>Пока нет учеников</strong><span>Создай первое приглашение, чтобы участник появился в этом списке.</span><button className="primary-button" onClick={onInvite}><UserPlus size={16} /> Создать приглашение</button></div></section>;

  return <div className="student-directory"><div className="directory-stats"><StatCard icon={<UsersRoundIcon />} label="Учеников в доступе" value={String(students.length)} detail="Активные участники потока" accent="blue" /><StatCard icon={<MonitorSmartphone size={18} />} label="Активных устройств" value={String(activeSessions)} detail="Сессии, которые видит система" accent="cyan" /><StatCard icon={<FileCheck2 size={18} />} label="Отправлено работ" value={String(submissions)} detail="Всего в базе" accent="amber" /></div><div className="directory-layout"><section className="content-panel directory-list"><div className="section-heading"><div><span className="section-kicker">ПРОФИЛИ ПОТОКА</span><h2>Ученики</h2></div><div className="section-heading-actions"><span className="progress-inline">{students.length} профилей</span><button className="primary-button compact-button curator-create-assignment-button" onClick={onInvite}><UserPlus size={15} /> Создать приглашение</button></div></div><div className="directory-rows">{students.map((student) => { const identity = student.identities.find((item) => item.provider === "DISCORD") ?? student.identities[0]; return <button className={`directory-row ${student.id === selectedStudent.id ? "selected" : ""}`} key={student.id} onClick={() => setSelectedId(student.id)}><div className="profile-avatar">{(identity?.displayName ?? identity?.username ?? "У").slice(0, 2).toUpperCase()}</div><div className="directory-row-copy"><strong>{identity?.displayName ?? identity?.username ?? "Без имени"}</strong><span>{identity?.provider ?? "Профиль без провайдера"} · {student.status === "ACTIVE" ? "Активен" : student.status}</span></div><div className="directory-row-meta"><strong>{student.submissionCount}</strong><span>ДЗ</span></div><ChevronRight size={16} /></button>; })}</div></section><StudentDirectoryDetail student={selectedStudent} onClaim={claimStudent} onTransfer={transferStudent} claiming={claimingStudentId === selectedStudent?.id} /></div></div>;
}

function StudentDirectoryFullPage({ student, onBack, onClaim, onTransfer, claiming }: { student: StudentDirectoryRecord; onBack: () => void; onClaim: (studentId: string) => Promise<void>; onTransfer?: (studentId: string, curatorId: string) => Promise<void>; claiming: boolean }) {
  const identity = student.identities.find((item) => item.provider === "DISCORD") ?? student.identities[0];
  const [curators, setCurators] = useState<CuratorDirectoryRecord[]>([]);
  const [selectedCuratorId, setSelectedCuratorId] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState("");
  useEffect(() => {
    if (!student.canTransfer || !onTransfer) return;
    let cancelled = false;
    void fetch(API_ORIGIN + "/api/security/curators", { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data: CuratorDirectoryRecord[] }> : null)
      .then((payload) => {
        if (cancelled || !payload?.data) return;
        setCurators(payload.data);
        const alternatives = payload.data.filter((curator) => curator.id !== student.assignedCurator?.id);
        setSelectedCuratorId((current) => current && alternatives.some((curator) => curator.id === current) ? current : alternatives[0]?.id ?? "");
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [student.id, student.canTransfer, student.assignedCurator?.id, onTransfer]);
  void curators;
  void transferOpen;
  void transferError;

  const transfer = async () => {
    if (!onTransfer || !selectedCuratorId || transferring) return;
    setTransferring(true);
    setTransferError("");
    try {
      await onTransfer(student.id, selectedCuratorId);
      setTransferOpen(false);
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : "Не удалось передать ученика.");
    } finally {
      setTransferring(false);
    }
  };
  void transfer;
  return <div className="student-full-page"><div className="student-full-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Назад к ученикам</button><div><span className="section-kicker">ПРОФИЛЬ УЧЕНИКА</span><strong>{identity?.displayName ?? identity?.username ?? "Без имени"}</strong></div></div><StudentDirectoryDetail student={student} onClaim={onClaim} claiming={claiming} /></div>;
}

function StudentDirectoryDetail({ student, onClaim, onTransfer, claiming }: { student: StudentDirectoryRecord; onClaim?: (studentId: string) => Promise<void>; onTransfer?: (studentId: string, curatorId: string) => Promise<void>; claiming?: boolean }) {
  return <div className="student-detail-stack directory-detail"><StudentDirectoryDetailContent student={student} onClaim={onClaim} onTransfer={onTransfer} claiming={claiming} /><StudentModuleAccessPanel student={student} /><StudentTransferControls student={student} onTransfer={onTransfer} /></div>;
}

type StudentModuleAccessRow = { moduleId: string; title: string; number: string; defaultAccess: string; status: string; isOverride: boolean };

/**
 * Per-student module override — independent of each module's cohort-wide default (see
 * CuratorModuleAccessView on "Программа"). Opening/closing here marks isOverride so the
 * module-wide toggle never silently reverts it; "Сбросить" removes the override and lets
 * the student fall back to whatever the module's default is for everyone else.
 */
function StudentModuleAccessPanel({ student }: { student: StudentDirectoryRecord }) {
  const [rows, setRows] = useState<StudentModuleAccessRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/students/${student.id}/access`, { credentials: "include", cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { data?: StudentModuleAccessRow[]; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось загрузить доступ к модулям");
      setRows(payload.data);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить доступ к модулям");
    }
  }, [student.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const setAccess = async (moduleId: string, unlocked: boolean) => {
    setBusy(moduleId); setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${moduleId}/students/${student.id}/access`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unlocked }) });
      if (!response.ok) throw new Error("Не удалось изменить доступ");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить доступ");
    } finally {
      setBusy("");
    }
  };

  const markCompleted = async (moduleId: string) => {
    if (!window.confirm("Отметить модуль пройденным? Откроется содержимое следующего модуля, а ДЗ следующего модуля станет доступно для отправки этому ученику.")) return;
    setBusy(moduleId); setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${moduleId}/students/${student.id}/complete`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Не удалось отметить модуль пройденным");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отметить модуль пройденным");
    } finally {
      setBusy("");
    }
  };

  if (!student.canViewDetails) return null;
  if (!rows) return null;

  return <section className="student-module-access-panel">
    <button className="student-module-access-toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <div className="student-module-access-head"><span className="section-kicker">ДОСТУП К МОДУЛЯМ</span><strong>Точечно для этого ученика</strong><span>Открыть/закрыть — не трогает общий переключатель на «Программе», действует только на этого ученика. «Отметить пройденным» — открывает следующий модуль и разблокирует его ДЗ.</span></div>
      <ChevronDown size={16} className={`student-module-access-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
    </button>
    {expanded && <>
    {error && <div className="file-error" role="alert">{error}</div>}
    <div className="student-module-access-list">
      {rows.map((row) => {
        const unlocked = row.status !== "LOCKED";
        const completed = row.status === "COMPLETED";
        return <div className={`student-module-access-row ${unlocked ? "is-unlocked" : "is-locked"}`} key={row.moduleId}>
          <div className="student-module-access-copy"><strong>{row.number} · {row.title}</strong><small>{completed ? "Выполнен учеником" : unlocked ? "Открыт" : "Закрыт"}{row.isOverride && !completed ? " · вручную для этого ученика" : ""}</small></div>
          <div className="student-module-access-actions">
            {!completed && <button className={unlocked ? "secondary-button" : "primary-button"} type="button" disabled={busy === row.moduleId} onClick={() => void setAccess(row.moduleId, !unlocked)}>{busy === row.moduleId ? "Сохраняем…" : unlocked ? "Закрыть этому ученику" : "Открыть этому ученику"}</button>}
            {!completed && unlocked && <button className="secondary-button" type="button" disabled={busy === row.moduleId} onClick={() => void markCompleted(row.moduleId)}>Отметить пройденным</button>}
          </div>
        </div>;
      })}
    </div>
    </>}
  </section>;
}

function StudentTransferControls({ student, onTransfer }: { student: StudentDirectoryRecord; onTransfer?: (studentId: string, curatorId: string) => Promise<void> }) {
  const [curators, setCurators] = useState<CuratorDirectoryRecord[]>([]);
  const [selectedCuratorId, setSelectedCuratorId] = useState("");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!student.canTransfer) return;
    let cancelled = false;
    void fetch(API_ORIGIN + "/api/security/curators", { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data: CuratorDirectoryRecord[] }> : null)
      .then((payload) => {
        if (cancelled || !payload?.data) return;
        setCurators(payload.data);
        const alternatives = payload.data.filter((curator) => curator.id !== student.assignedCurator?.id);
        setSelectedCuratorId(alternatives[0]?.id ?? "");
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [student.canTransfer, student.assignedCurator?.id]);

  if (!student.canTransfer) return null;
  const alternatives = curators.filter((curator) => curator.id !== student.assignedCurator?.id);
  const transfer = async () => {
    if (!selectedCuratorId || saving) return;
    setSaving(true);
    setError("");
    try {
      if (onTransfer) {
        await onTransfer(student.id, selectedCuratorId);
      } else {
        const response = await fetch(`${API_ORIGIN}/api/security/students/${student.id}/assignment`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ curatorId: selectedCuratorId }) });
        if (!response.ok) {
          const payload = await response.json() as { message?: string };
          throw new Error(payload.message ?? "Не удалось передать ученика.");
        }
        window.location.reload();
      }
      setOpen(false);
    } catch (transferError) {
      setError(transferError instanceof Error ? transferError.message : "Не удалось передать ученика.");
    } finally {
      setSaving(false);
    }
  };

  return <section className="student-transfer-panel"><div className="student-transfer-panel-head"><div><span className="section-kicker">НАЗНАЧЕНИЕ</span><strong>{student.assignedCurator ? `Закреплён за: ${student.assignedCurator.name}` : "Куратор ещё не назначен"}</strong></div><button type="button" className="secondary-button" onClick={() => { setError(""); setOpen((current) => !current); }}><ArrowRightLeft size={15} /> Передать ученика</button></div>{open && <div className="student-transfer-form"><label htmlFor={`student-transfer-${student.id}`}>Новый куратор</label><select id={`student-transfer-${student.id}`} value={selectedCuratorId} onChange={(event) => setSelectedCuratorId(event.target.value)}><option value="">Выберите куратора</option>{alternatives.map((curator) => <option key={curator.id} value={curator.id}>{curator.name}{curator.email ? ` · ${curator.email}` : ""}</option>)}</select><div className="student-transfer-actions"><button className="secondary-button" type="button" onClick={() => setOpen(false)}>Отмена</button><button className="primary-button" type="button" disabled={!selectedCuratorId || saving} onClick={() => void transfer()}>{saving ? "Передаём…" : "Подтвердить передачу"}</button></div>{alternatives.length === 0 && <span className="student-transfer-empty">Нет других активных кураторов.</span>}{error && <div className="file-error" role="alert">{error}</div>}</div>}</section>;
}

function StudentDirectoryDetailContent({ student, onClaim, onTransfer, claiming }: { student: StudentDirectoryRecord; onClaim?: (studentId: string) => Promise<void>; onTransfer?: (studentId: string, curatorId: string) => Promise<void>; claiming?: boolean }) {
  type AssignmentAttempt = {
    id: string;
    attempt: number;
    status: string;
    answerText: string | null;
    submittedAt: string | null;
    createdAt: string;
    feedback: Array<{ id: string; text: string; createdAt: string }>;
    files: Array<{ id: string; originalName: string; mimeType: string; byteSize: number }>;
  };
  type AssignmentHistory = AssignmentAttempt & {
    assignmentId: string;
    title: string;
    module: string;
    attempts: AssignmentAttempt[];
  };

  const identity = student.identities.find((item) => item.provider === "DISCORD") ?? student.identities[0];
  const [detail, setDetail] = useState<{ sessions: Array<{ id: string; status: string; deviceName: string | null; userAgent: string | null; ipAddress: string | null; countryCode?: string | null; city: string | null; lastActiveAt: string; createdAt: string; expiresAt: string }>; loginEvents: Array<{ id: string; outcome: string; reasonCode: string | null; ipAddress: string | null; countryCode?: string | null; city: string | null; createdAt: string }> } | null>(null);
  const [revoking, setRevoking] = useState("");
  const [approving, setApproving] = useState("");
  const [securityError, setSecurityError] = useState("");
  const [studentTab, setStudentTab] = useState<"overview" | "assignments">("overview");
  const [studentAssignments, setStudentAssignments] = useState<AssignmentHistory[]>([]);
  const [expandedAssignmentId, setExpandedAssignmentId] = useState("");
  const [claimingSelf, setClaimingSelf] = useState(false);
  const [claimError, setClaimError] = useState("");
  const [curators, setCurators] = useState<CuratorDirectoryRecord[]>([]);
  const [selectedCuratorId, setSelectedCuratorId] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState("");

  useEffect(() => {
    if (!student.canTransfer || !onTransfer) return;
    let cancelled = false;
    void fetch(API_ORIGIN + "/api/security/curators", { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data: CuratorDirectoryRecord[] }> : null)
      .then((payload) => {
        if (cancelled || !payload?.data) return;
        setCurators(payload.data);
        const alternatives = payload.data.filter((curator) => curator.id !== student.assignedCurator?.id);
        setSelectedCuratorId((current) => current && alternatives.some((curator) => curator.id === current) ? current : alternatives[0]?.id ?? "");
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [student.id, student.canTransfer, student.assignedCurator?.id, onTransfer]);

  const transfer = async () => {
    if (!onTransfer || !selectedCuratorId || transferring) return;
    setTransferring(true);
    setTransferError("");
    try {
      await onTransfer(student.id, selectedCuratorId);
      setTransferOpen(false);
    } catch (error) {
      setTransferError(error instanceof Error ? error.message : "Не удалось передать ученика.");
    } finally {
      setTransferring(false);
    }
  };

  void curators;
  void transferOpen;
  void transferError;
  void transfer;

  const claimSelf = async () => {
    if (claimingSelf) return;
    setClaimingSelf(true);
    setClaimError("");
    try {
      if (onClaim) await onClaim(student.id);
      else {
        const response = await fetch(`${API_ORIGIN}/api/security/students/${student.id}/claim`, { method: "POST", credentials: "include" });
        if (!response.ok) {
          const payload = await response.json() as { message?: string };
          throw new Error(payload.message ?? "Не удалось закрепить ученика.");
        }
      }
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "Не удалось закрепить ученика.");
    } finally {
      setClaimingSelf(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    if (!student.canViewDetails) return;
    void fetch(API_ORIGIN + "/api/security/students/" + student.id, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data: typeof detail }> : null)
      .then((payload) => { if (!cancelled && payload?.data) setDetail(payload.data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [student.id, student.canViewDetails]);

  useEffect(() => {
    void fetch(API_ORIGIN + "/api/security/students/" + student.id + "/assignments", { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data: AssignmentHistory[] }> : null)
      .then((payload) => { if (payload?.data) setStudentAssignments(payload.data); })
      .catch(() => undefined);
  }, [student.id]);

  const revoke = async (sessionId: string) => {
    if (!window.confirm("Отозвать эту сессию?")) return;
    setRevoking(sessionId);
    setSecurityError("");
    try {
      const response = await fetch(API_ORIGIN + "/api/security/students/" + student.id + "/sessions/" + sessionId + "/revoke", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Owner security review" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось изменить статус устройства.");
      }
      setDetail((current) => current ? { ...current, sessions: current.sessions.map((session) => session.id === sessionId ? { ...session, status: "REVOKED" } : session) } : current);
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "Не удалось изменить статус устройства.");
    } finally {
      setRevoking("");
    }
  };

  const approve = async (sessionId: string) => {
    setApproving(sessionId);
    setSecurityError("");
    try {
      const response = await fetch(API_ORIGIN + "/api/security/students/" + student.id + "/sessions/" + sessionId + "/approve", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Device approved by curator" }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось разрешить устройство.");
      }
      setDetail((current) => current ? { ...current, sessions: current.sessions.map((session) => session.id === sessionId ? { ...session, status: "ACTIVE" } : session) } : current);
    } catch (error) {
      setSecurityError(error instanceof Error ? error.message : "Не удалось разрешить устройство.");
    } finally {
      setApproving("");
    }
  };

  const activeSessions = detail?.sessions.filter((session) => session.status === "ACTIVE") ?? [];
  const pendingSessions = detail?.sessions.filter((session) => session.status === "PENDING") ?? [];
  const revokedSessions = detail?.sessions.filter((session) => session.status === "REVOKED" || session.status === "EXPIRED") ?? [];
  const unusualActivity = activeSessions.length > 1 && new Set(activeSessions.map((session) => session.countryCode ?? session.city ?? session.ipAddress).filter(Boolean)).size > 1;
  const formatDevice = (userAgent: string | null) => userAgent?.includes("Windows") ? "Windows · браузер" : userAgent?.includes("Macintosh") ? "macOS · браузер" : userAgent?.includes("Android") ? "Android · мобильное устройство" : userAgent?.includes("iPhone") ? "iPhone · мобильное устройство" : "Браузер";
  const formatDateTime = (value: string | null) => value ? new Date(value).toLocaleString("ru-RU") : "Дата не указана";
  const statusLabel = (status: string) => status === "ACCEPTED" ? "Принято" : status === "NEEDS_REVISION" ? "На доработке" : status === "IN_REVIEW" ? "На проверке" : status === "SUBMITTED" ? "Отправлено" : status === "DRAFT" ? "Черновик" : status;
  const statusTone = (status: string) => status === "ACCEPTED" ? "green" : status === "NEEDS_REVISION" ? "amber" : "blue";

  if (!student.canViewDetails) {
    return <section className="content-panel directory-detail"><div className="empty-state"><ShieldCheck size={24} /><strong>Ученик пока не закреплён</strong><span>Закрепите ученика за собой, чтобы открыть его задания, входы и устройства.</span>{student.canClaim && <button className="primary-button" type="button" onClick={() => void claimSelf()} disabled={claimingSelf || claiming}><UserPlus size={16} />{claimingSelf || claiming ? "Закрепляем…" : "Взять ученика"}</button>}{claimError && <div className="file-error" role="alert">{claimError}</div>}</div></section>;
  }

  return <section className="content-panel directory-detail">
    <div className="directory-detail-heading">
      <div className="profile-avatar large">{(identity?.displayName ?? identity?.username ?? "У").slice(0, 2).toUpperCase()}</div>
      <div className="directory-detail-title"><span className="section-kicker">ПРОФИЛЬ УЧЕНИКА</span><h2>{identity?.displayName ?? identity?.username ?? "Без имени"}</h2><p>{identity?.provider ?? "Профиль без провайдера"} · {student.status === "ACTIVE" ? "Активен" : student.status}</p><div className={`student-assignment-status ${student.isAssignedToActor ? "current" : ""}`}><span>{student.isAssignedToActor ? "Закреплён за вами" : student.assignedCurator ? `Закреплён за: ${student.assignedCurator.name}` : "Не закреплён за куратором"}</span>{student.canClaim && <button type="button" className="secondary-button" onClick={() => void claimSelf()} disabled={claimingSelf || claiming}><UserPlus size={15} />{claimingSelf || claiming ? "Закрепляем…" : student.assignedCurator ? "Переназначить себе" : "Взять ученика"}</button>}</div>{claimError && <div className="file-error" role="alert">{claimError}</div>}</div>
    </div>
    <div className="directory-detail-grid">
      <div><span>Discord</span><strong>{identity?.username ?? "Не подключён"}</strong></div>
      <div><span>Отправлено ДЗ</span><strong>{student.submissionCount}</strong></div>
      <div><span>Событий входа</span><strong>{student.loginEventCount}</strong></div>
      <div><span>Активных устройств</span><strong>{detail ? activeSessions.length : student.activeSessionCount} / 2</strong></div>
    </div>
    <div className="student-detail-tabs">
      <button className={studentTab === "overview" ? "active" : ""} onClick={() => setStudentTab("overview")}>Безопасность</button>
      <button className={studentTab === "assignments" ? "active" : ""} onClick={() => setStudentTab("assignments")}>Задания ({studentAssignments.length})</button>
    </div>
    {studentTab === "assignments" ? <div className="student-assignment-history">
      {studentAssignments.length === 0 ? <div className="empty-state compact"><FileCheck2 size={21} /><strong>Отправленных заданий пока нет</strong></div> : studentAssignments.map((assignment) => {
        const expanded = expandedAssignmentId === assignment.id;
        return <article className={"student-assignment-card " + (expanded ? "expanded" : "")} key={assignment.id} onClick={() => setExpandedAssignmentId(expanded ? "" : assignment.id)}>
          <div className="student-assignment-card-head">
            <div><span className="section-kicker">{assignment.module}</span><h3>{assignment.title}</h3><p>{assignment.attempts.length} {assignment.attempts.length === 1 ? "попытка" : "попытки"} · последняя отправка {formatDateTime(assignment.submittedAt)}</p></div>
            <div className={"assignment-badge " + statusTone(assignment.status)}>{statusLabel(assignment.status)}</div>
          </div>
          {expanded && <div className="student-assignment-thread">
            <div className="student-assignment-thread-heading"><span className="detail-label">ИСТОРИЯ ЗАДАНИЯ</span><strong>{assignment.attempts.length} {assignment.attempts.length === 1 ? "попытка" : "попытки"} · ответы и комментарии по порядку</strong></div>
            <div className="student-assignment-timeline">
              {assignment.attempts.map((attempt) => <div className="student-assignment-attempt" key={attempt.id}>
                <div className="student-assignment-attempt-head">
                  <div><strong>Попытка {attempt.attempt}</strong><span>{formatDateTime(attempt.submittedAt ?? attempt.createdAt)}</span></div>
                  <span className={"assignment-badge " + statusTone(attempt.status)}>{statusLabel(attempt.status)}</span>
                </div>
                <div><span className="detail-label">ОТВЕТ УЧЕНИКА</span><p>{attempt.answerText || "Ответ отправлен без текста."}</p></div>
                {attempt.files.length > 0 && <div><span className="detail-label">ВЛОЖЕНИЯ</span><div className="student-assignment-files">{attempt.files.map((file) => file.mimeType.startsWith("image/") ? <div className="student-assignment-image" key={file.id}><Image src={API_ORIGIN + "/api/files/" + file.id + "/content"} alt={file.originalName} width={320} height={210} unoptimized /><span>{file.originalName}</span></div> : <a key={file.id} href={API_ORIGIN + "/api/files/" + file.id + "/content"} target="_blank" rel="noreferrer">{file.originalName}</a>)}</div></div>}
                {attempt.feedback.length > 0 ? <div className="student-assignment-feedback"><strong>КОММЕНТАРИИ КУРАТОРА</strong>{attempt.feedback.map((feedback) => <div className="student-assignment-feedback-item" key={feedback.id}><span>{feedback.text}</span><small>{formatDateTime(feedback.createdAt)}</small></div>)}</div> : <div className="student-assignment-feedback empty"><strong>КОММЕНТАРИИ КУРАТОРА</strong><span>Комментариев по этой попытке пока нет.</span></div>}
              </div>)}
            </div>
          </div>}
        </article>;
      })}
    </div> : <div className="directory-security">
      {securityError && <div className="file-error" role="alert">{securityError}</div>}
      {detail && pendingSessions.length > 0 && <div className="security-pending-list"><div className="security-pending-heading"><div><span className="section-kicker">ТРЕБУЕТСЯ РЕШЕНИЕ</span><h4>Новые устройства ожидают подтверждения</h4><p>Если уже заняты два места, сначала отзовите активное устройство, затем разрешите это.</p></div><span>{pendingSessions.length}</span></div>{pendingSessions.map((session) => <article className="security-device-card pending" key={session.id}><div className="security-device-head"><div><span className="security-device-status pending">ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ</span><h4>{formatDevice(session.userAgent)}</h4></div><div className="security-device-actions"><button className="primary-button" disabled={approving === session.id} onClick={() => void approve(session.id)}>{approving === session.id ? "Разрешаем…" : "Разрешить устройство"}</button><button className="secondary-button danger" disabled={revoking === session.id} onClick={() => void revoke(session.id)}>{revoking === session.id ? "Отклоняем…" : "Отклонить"}</button></div></div><div className="security-device-grid"><div><span>IP-АДРЕС</span><strong>{session.ipAddress ?? "Не определён"}</strong></div><div><span>РЕГИОН</span><strong>{formatRegion(session.city, session.countryCode)}</strong></div><div><span>ЗАПРОС</span><strong>{formatDateTime(session.createdAt)}</strong></div><div><span>ИСТЕКАЕТ</span><strong>{formatDateTime(session.expiresAt)}</strong></div></div></article>)}</div>}
      <div className="section-heading"><div><span className="section-kicker">КОНТРОЛЬ ДОСТУПА</span><h3>Доверенные устройства</h3></div><ShieldCheck size={18} className="heading-icon" /></div>
      {unusualActivity && <div className="file-error" role="status">Активные сессии имеют разные сетевые признаки. Это сигнал для проверки, но не доказательство передачи аккаунта.</div>}
      {detail && activeSessions.length === 0 && pendingSessions.length === 0 && <div className="empty-state compact"><MonitorSmartphone size={21} /><strong>Нет активных устройств</strong><span>Все ранее созданные сессии отозваны или завершены.</span></div>}
      {activeSessions.map((session) => <article className="security-device-card" key={session.id}><div className="security-device-head"><div><span className="security-device-status">АКТИВНО</span><h4>{formatDevice(session.userAgent)}</h4></div><button className="secondary-button" disabled={revoking === session.id} onClick={() => void revoke(session.id)}>{revoking === session.id ? "Отзываем…" : "Отозвать доступ"}</button></div><div className="security-device-grid"><div><span>IP-АДРЕС</span><strong>{session.ipAddress ?? "Не определён"}</strong></div><div><span>РЕГИОН</span><strong>{formatRegion(session.city, session.countryCode)}</strong></div><div><span>ПЕРВЫЙ ВХОД</span><strong>{new Date(session.createdAt).toLocaleString("ru-RU")}</strong></div><div><span>ПОСЛЕДНЯЯ АКТИВНОСТЬ</span><strong>{new Date(session.lastActiveAt).toLocaleString("ru-RU")}</strong></div></div></article>)}
      {revokedSessions.length > 0 && <details className="security-event-list"><summary className="detail-label">ЗАВЕРШЁННЫЕ СЕССИИ ({revokedSessions.length})</summary>{revokedSessions.slice(0, 10).map((session) => <div className="security-event" key={session.id}><strong>{formatDevice(session.userAgent)}</strong><span>Сессия завершена · {new Date(session.createdAt).toLocaleString("ru-RU")} · IP: {session.ipAddress ?? "не определён"} · {formatRegion(session.city, session.countryCode)}</span></div>)}</details>}
      {detail && <details className="security-event-list"><summary className="detail-label">ПОСЛЕДНИЕ ВХОДЫ</summary>{detail.loginEvents.slice(0, 5).map((event) => <div className="security-event" key={event.id}><strong>{formatLoginEventLabel(event.outcome, event.reasonCode)}{formatLoginEventReason(event.reasonCode) && <small>{formatLoginEventReason(event.reasonCode)}</small>}</strong><span>{new Date(event.createdAt).toLocaleString("ru-RU")} · IP: {event.ipAddress ?? "не определён"} · {formatRegion(event.city, event.countryCode)}</span></div>)}</details>}
    </div>}
  </section>;
}

function UsersRoundIcon() {
  return <UserPlus size={18} />;
}

function CuratorInvitationsViewLegacyCurrent() {
  const [role, setRole] = useState<"STUDENT" | "CURATOR">("STUDENT");
  const [email, setEmail] = useState("");
  const [discordId] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("24");
  const [inviteUrl, setInviteUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(""); setInviteUrl(""); setIsSubmitting(true);
    try {
      if (!isDiscordUserId(discordId)) throw new Error("Укажите корректный Discord ID (17–20 цифр), а не имя пользователя.");
      const response = await fetch(`${API_ORIGIN}/api/auth/invitations`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, email: email.trim() || undefined, expiresInHours: Number(expiresInHours), targetProvider: "DISCORD", targetSubject: discordId.trim() }) });
      const payload = await response.json() as { data?: { token: string; expiresAt: string; emailSent?: boolean }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать приглашение");
      const url = `${window.location.origin}/?invite=${encodeURIComponent(payload.data.token)}`;
      setInviteUrl(url); setNotice(`Ссылка создана до ${new Date(payload.data.expiresAt).toLocaleString("ru-RU")}. ${payload.data.emailSent ? "Письмо отправлено." : "Письмо не отправлено: для тестового отправителя Resend нужен email аккаунта Resend."}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "API недоступен. Проверь сервер."); }
    finally { setIsSubmitting(false); }
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(inviteUrl);
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (!copied) {
        const helper = document.createElement("textarea");
        helper.value = inviteUrl;
        helper.setAttribute("readonly", "true");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      setNotice("Ссылка скопирована.");
    } catch {
      setNotice("Не удалось скопировать автоматически. Выдели ссылку и нажми Ctrl+C.");
    }
  };

  return <div className="invitation-layout"><form className="content-panel invitation-form" onSubmit={createInvitation}><div className="section-heading"><div><span className="section-kicker">НОВЫЙ ДОСТУП</span><h2>Создать приглашение</h2><p className="section-heading-note">Email сохранится у ученика и будет использоваться для уведомлений.</p></div><UserPlus size={19} className="heading-icon" /></div><div className="form-body"><label className="form-field"><span>Роль участника</span><select value={role} onChange={(event) => setRole(event.target.value as "STUDENT" | "CURATOR")}><option value="STUDENT">Ученик</option><option value="CURATOR">Куратор</option></select></label><label className="form-field"><span>Email участника</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="student@example.com" required={role === "STUDENT"} /><small className="file-field-note">На этот адрес можно отправлять уведомления о ДЗ, стримах и событиях.</small></label><label className="form-field"><span>Ссылка действует, часов</span><input type="number" min="1" max="720" value={expiresInHours} onChange={(event) => setExpiresInHours(event.target.value)} required /></label><div className="invitation-policy"><ShieldCheck size={17} /><div><strong>Одноразовая ссылка</strong><span>После первого подтверждения Discord приглашение нельзя использовать повторно.</span></div></div><button className="primary-button" type="submit" disabled={isSubmitting || !expiresInHours || (role === "STUDENT" && !email.trim())}>{isSubmitting ? "Создаём…" : "Создать ссылку"} <ChevronRight size={16} /></button>{notice && <div className={`detail-feedback ${inviteUrl ? "accepted" : ""}`}><ShieldCheck size={17} /><div><strong>{notice}</strong>{inviteUrl && <div className="invite-result"><input readOnly value={inviteUrl} aria-label="Одноразовая ссылка" /><button className="secondary-button" type="button" onClick={() => void copyInvite}><Copy size={15} /> Копировать</button></div>}</div></div>}</div></form><aside className="content-panel invitation-info"><div className="section-heading"><div><span className="section-kicker">ПЕРЕД ОТПРАВКОЙ</span><h2>Что произойдёт</h2></div><ShieldCheck size={18} className="heading-icon" /></div><div className="invitation-steps"><div><strong>01</strong><span>Email сохранится в профиле ученика до первого входа.</span></div><div><strong>02</strong><span>Участник подтвердит личность через Discord.</span></div><div><strong>03</strong><span>После входа будут доступны уведомления, задания и история безопасности.</span></div></div></aside></div>;
}

void CuratorInvitationsViewLegacyCurrent;

function CuratorInvitationsView() {
  const [role, setRole] = useState<"STUDENT" | "CURATOR">("STUDENT");
  const [email, setEmail] = useState("");
  const [discordId, setDiscordId] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("24");
  const [inviteUrl, setInviteUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const createInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("");
    setInviteUrl("");
    if (!isDiscordUserId(discordId)) {
      setNotice("Укажите корректный Discord ID (17–20 цифр), а не имя пользователя.");
      return;
    }
    setIsSubmitting(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/auth/invitations`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role,
          email: email.trim() || undefined,
          expiresInHours: Number(expiresInHours),
          targetProvider: "DISCORD",
          targetSubject: discordId.trim(),
        }),
      });
      const payload = await response.json() as { data?: { token: string; expiresAt: string; emailSent?: boolean }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать приглашение");
      setInviteUrl(`${window.location.origin}/?invite=${encodeURIComponent(payload.data.token)}`);
      setNotice(`Ссылка создана до ${new Date(payload.data.expiresAt).toLocaleString("ru-RU")}. ${payload.data.emailSent ? "Письмо отправлено." : "Письмо не отправлено: email не указан или Resend не настроен."}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "API недоступен. Проверьте сервер.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(inviteUrl);
      } else {
        const helper = document.createElement("textarea");
        helper.value = inviteUrl;
        helper.setAttribute("readonly", "true");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        helper.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice("Не удалось скопировать автоматически. Выделите ссылку и нажмите Ctrl+C.");
    }
  };

  return <div className="invitation-layout">
    <form className="content-panel invitation-form" onSubmit={createInvitation}>
      <div className="section-heading"><div><span className="section-kicker">НОВЫЙ ДОСТУП</span><h2>Создать приглашение</h2><p className="section-heading-note">Ссылка будет работать только для указанного Discord-аккаунта.</p></div><UserPlus size={19} className="heading-icon" /></div>
      <div className="form-body">
        <label className="form-field"><span>Роль участника</span><select value={role} onChange={(event) => setRole(event.target.value as "STUDENT" | "CURATOR")}><option value="STUDENT">Ученик</option><option value="CURATOR">Куратор</option></select></label>
        <label className="form-field"><span>Email участника</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="student@example.com" required={role === "STUDENT"} /><small className="file-field-note">На этот адрес будут приходить уведомления о ДЗ, стримах и обсуждениях.</small></label>
        <label className="form-field"><span>Discord ID участника</span><input type="text" inputMode="numeric" pattern="[0-9]{17,20}" value={discordId} onChange={(event) => setDiscordId(event.target.value)} placeholder="Например, 1535254297472925738" required /><small className="file-field-note">Это числовой ID Discord, не username. Найти его можно в Discord с включённым режимом разработчика.</small></label>
        <label className="form-field"><span>Ссылка действует, часов</span><input type="number" min="1" max="720" value={expiresInHours} onChange={(event) => setExpiresInHours(event.target.value)} required /></label>
        <div className="invitation-policy"><ShieldCheck size={17} /><div><strong>Одноразовая ссылка</strong><span>После подтверждения Discord приглашение нельзя использовать повторно.</span></div></div>
        <button className="primary-button" type="submit" disabled={isSubmitting || !expiresInHours || !isDiscordUserId(discordId) || (role === "STUDENT" && !email.trim())}>{isSubmitting ? "Создаём…" : "Создать ссылку"} <ChevronRight size={16} /></button>
        {notice && <div className={`detail-feedback ${inviteUrl ? "accepted" : ""}`}><ShieldCheck size={17} /><div><strong>{notice}</strong>{inviteUrl && <div className="invite-result"><input readOnly value={inviteUrl} aria-label="Одноразовая ссылка" /><button className={`secondary-button ${copied ? "copied" : ""}`} type="button" onClick={() => void copyInvite()}>{copied ? <CheckCircle2 size={15} /> : <Copy size={15} />} {copied ? "Скопировано" : "Копировать"}</button></div>}</div></div>}
      </div>
    </form>
    <aside className="content-panel invitation-info"><div className="section-heading"><div><span className="section-kicker">ПЕРЕД ОТПРАВКОЙ</span><h2>Что произойдёт</h2></div><ShieldCheck size={18} className="heading-icon" /></div><div className="invitation-steps"><div><strong>01</strong><span>Email сохранится в профиле участника.</span></div><div><strong>02</strong><span>Сервер сверит Discord ID до создания сессии.</span></div><div><strong>03</strong><span>Если ID не совпадёт, приглашение останется неактивированным.</span></div></div></aside>
  </div>;
}

function CuratorInvitationsLegacy() {
  const [role, setRole] = useState<"STUDENT" | "CURATOR">("STUDENT");
  const [expiresInHours, setExpiresInHours] = useState("24");
  const [inviteUrl, setInviteUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const createInvitation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice("");
    setInviteUrl("");
    setIsSubmitting(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/auth/invitations`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, expiresInHours: Number(expiresInHours) }) });
      if (!response.ok) {
        setNotice(response.status === 403 ? "Создавать приглашения может только владелец платформы." : "Не удалось создать приглашение.");
        return;
      }
      const payload = await response.json() as { data: { token: string; expiresAt: string } };
      const url = `${window.location.origin}/?invite=${encodeURIComponent(payload.data.token)}`;
      setInviteUrl(url);
      setNotice(`Ссылка создана до ${new Date(payload.data.expiresAt).toLocaleString("ru-RU")}.`);
    } catch {
      setNotice("API недоступен. Проверь, что сервер запущен.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setNotice("Ссылка скопирована.");
  };

  return <div className="invitation-layout"><form className="content-panel invitation-form" onSubmit={createInvitation}><div className="section-heading"><div><span className="section-kicker">НОВЫЙ ДОСТУП</span><h2>Создать приглашение</h2></div><UserPlus size={19} className="heading-icon" /></div><div className="form-body"><label className="form-field"><span>Роль участника</span><select value={role} onChange={(event) => setRole(event.target.value as "STUDENT" | "CURATOR")}><option value="STUDENT">Ученик</option><option value="CURATOR">Куратор</option></select></label><label className="form-field"><span>Ссылка действует, часов</span><input type="number" min="1" max="720" value={expiresInHours} onChange={(event) => setExpiresInHours(event.target.value)} /></label><div className="invitation-policy"><ShieldCheck size={17} /><div><strong>Одноразовая ссылка</strong><span>После первого подтверждения Discord приглашение нельзя использовать повторно.</span></div></div><button className="primary-button" type="submit" disabled={isSubmitting || !expiresInHours}>{isSubmitting ? "Создаём..." : "Создать ссылку"} <ChevronRight size={16} /></button>{notice && <div className={`detail-feedback ${inviteUrl ? "accepted" : ""}`}><ShieldCheck size={17} /><div><strong>{notice}</strong>{inviteUrl && <div className="invite-result"><input readOnly value={inviteUrl} aria-label="Одноразовая ссылка" /><button className="secondary-button" type="button" onClick={() => void copyInvite}><Copy size={15} /> Копировать</button></div>}</div></div>}</div></form><aside className="content-panel invitation-info"><div className="section-heading"><div><span className="section-kicker">ПЕРЕД ОТПРАВКОЙ</span><h2>Что произойдёт</h2></div><ShieldCheck size={18} className="heading-icon" /></div><div className="invitation-steps"><div><strong>01</strong><span>Ссылка отправляется конкретному участнику в личном сообщении.</span></div><div><strong>02</strong><span>Discord-профиль привязывается на сервере, а не из данных браузера.</span></div><div><strong>03</strong><span>После входа владелец видит сессии, устройства и историю входов.</span></div></div></aside></div>;
}

void CuratorInvitationsLegacy;

type BuilderLesson = Pick<CourseLesson, "id" | "title" | "description" | "media" | "assignments">;

function CuratorLessonPageLegacy({ module, lesson, lessons, onBack, onNavigate, onSwitchLesson }: { module: CourseApiModule; lesson: CourseLesson; lessons: CourseLesson[]; onBack: () => void; onNavigate: (nextNav: CuratorNav) => void; onSwitchLesson: (lessonId: string) => void }) {
  const studentModule: PracticumModule = { id: module.id, section: ["Welcome", "Education", "Q&A", "Practice"].includes(module.section) ? module.section as PracticumSection : "Education", number: module.number, title: module.title, status: module.status, progress: module.progress, lessons: module.lessons.length, description: module.description ?? "", locked: module.locked };
  const fallback = modulePageContentFor(studentModule);
  const lessonMedia = lesson.media ?? [];
  const [media, setMedia] = useState<CourseLessonMedia[]>(lessonMedia);
  const [assignments, setAssignments] = useState<CourseLesson["assignments"]>(lesson.assignments ?? []);
  const [description, setDescription] = useState(lesson.description ?? "");
  const [selectedId, setSelectedId] = useState(lessonMedia.find((item) => item.kind !== "QA")?.id ?? "");
  const [showAssignmentForm, setShowAssignmentForm] = useState(false);
  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [assignmentDescription, setAssignmentDescription] = useState("");
  const [assignmentRequirement, setAssignmentRequirement] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const thematicMedia = media.filter((item) => item.kind !== "QA");
  const selectedMedia = thematicMedia.find((item) => item.id === selectedId) ?? thematicMedia[0];

  const openMediaLibrary = (targetKind: "STREAM" | "QA" | "BREAKDOWN") => {
    window.sessionStorage.setItem("curator-target-lesson", lesson.id);
    window.sessionStorage.setItem("curator-target-kind", targetKind);
    onNavigate("Медиатека");
  };

  const createAssignment = async () => {
    if (!assignmentTitle.trim() || !assignmentDescription.trim()) return;
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/assignments`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: lesson.id,
          title: assignmentTitle.trim(),
          description: assignmentDescription.trim(),
          moduleNumber: module.number,
          moduleTitle: module.title,
          requirements: assignmentRequirement.trim() ? [assignmentRequirement.trim()] : [],
          allowedFormats: ["comment", "image"],
        }),
      });
      const payload = await response.json().catch(() => ({})) as { data?: CourseLesson["assignments"][number]; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать домашнее задание");
      setAssignments((current) => [...current, payload.data as CourseLesson["assignments"][number]]);
      setAssignmentTitle(""); setAssignmentDescription(""); setAssignmentRequirement(""); setShowAssignmentForm(false);
      setNotice("Домашнее задание добавлено в этот урок.");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Не удалось создать домашнее задание");
    } finally { setSaving(false); }
  };

  const moveMedia = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    setMedia((current) => {
      const from = current.findIndex((item) => item.id === draggedId);
      const to = current.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const save = async () => {
    setSaving(true); setNotice("");
    try {
      const [lessonResponse, orderResponse] = await Promise.all([
        fetch(`${API_ORIGIN}/api/course/lessons/${lesson.id}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: lesson.title, description }) }),
        fetch(`${API_ORIGIN}/api/course/lessons/${lesson.id}/media/reorder`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaIds: media.map((item) => item.id) }) }),
      ]);
      if (!lessonResponse.ok || !orderResponse.ok) throw new Error("Не удалось сохранить изменения урока");
      setNotice("Изменения сохранены. Именно так урок увидит ученик.");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Не удалось сохранить изменения урока");
    } finally { setSaving(false); }
  };

  return <div className="module-page curator-lesson-page"><div className="module-page-toolbar"><button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к программе</button><span className="module-page-breadcrumb">{module.section} / {module.title} / {lesson.title}</span><div className="curator-lesson-switcher">{lessons.map((item) => <button className={item.id === lesson.id ? "active" : ""} type="button" key={item.id} onClick={() => onSwitchLesson(item.id)}>{item.title}</button>)}</div><div className="curator-lesson-toolbar-actions"><button className="secondary-button" type="button" onClick={() => openMediaLibrary("STREAM")}><Plus size={15} /> Добавить стрим</button><button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Сохраняем…" : "Сохранить урок"}</button></div></div><header className="module-page-header"><div><span className="eyebrow"><BookOpen size={14} /> МОДУЛЬ {module.number} · РЕДАКТИРОВАНИЕ</span><h2>{module.title}</h2><p>{module.title} · страница полностью повторяет вид ученика.</p></div><div className="module-page-progress"><strong>{module.progress}%</strong><span>пройдено учениками</span><i><b style={{ width: `${module.progress}%` }} /></i></div></header><div className="curator-lesson-hint"><Settings2 size={16} /><span>Перетаскивайте карточки стримов в нужном порядке. Текст и материалы сохраняются для страницы ученика.</span></div><div className="module-resource-grid"><section className="module-resource-card module-description-card"><div className="module-resource-heading"><BookOpen size={17} /><h3>Описание</h3><span>Редактируется</span></div><textarea className="curator-lesson-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Добавьте описание урока…" /></section><section className="module-resource-card module-stream-card"><div className="module-resource-heading"><Play size={17} /><h3>Записи стримов</h3><span>{media.length} {media.length === 1 ? "материал" : "материалов"}</span><button className="quiet-button" type="button" onClick={() => openMediaLibrary("STREAM")}><Plus size={15} /> Добавить стрим</button></div>{selectedMedia?.embedUrl ? <div className="module-video-stage"><iframe src={selectedMedia.embedUrl} title={selectedMedia.title ?? "Запись стрима"} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /><span className="module-video-label">{selectedMedia.title ?? "Запись стрима"}</span><span className="stream-duration">{selectedMedia.status === "PUBLISHED" ? "ОПУБЛИКОВАНО" : "ЧЕРНОВИК"}</span></div> : media.length === 0 ? <div className="module-video-stage curator-fallback-video"><video src="https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" poster="/market-logic-cover.png" controls playsInline /><span className="module-video-label">{fallback.streamTitle}</span></div> : <div className="module-media-empty"><Play size={20} /><strong>Добавьте первый стрим</strong><span>После добавления он появится здесь отдельной карточкой.</span></div>}{media.length > 0 && <div className="module-media-playlist curator-media-playlist">{media.map((item, index) => <button className={`module-media-item ${item.id === selectedMedia?.id ? "selected" : ""}`} type="button" draggable onDragStart={() => setDraggedId(item.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveMedia(item.id)} key={item.id} onClick={() => setSelectedId(item.id)}><span className="curator-drag-handle">⋮⋮</span><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.title ?? "Материал без названия"}</strong><small>{item.kind === "QA" ? "Q&A" : item.kind === "BREAKDOWN" ? "Разбор" : "Стрим"} · {item.status === "PUBLISHED" ? "Опубликовано" : "Черновик"}</small></div><ArrowUpRight size={14} /></button>)}</div>}</section><section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{assignments.length} {assignments.length === 1 ? "задание" : "заданий"}</span><button className="quiet-button" type="button" onClick={() => setShowAssignmentForm((current) => !current)}><Plus size={15} /> {showAssignmentForm ? "Закрыть" : "Добавить ДЗ"}</button></div>{showAssignmentForm && <div className="curator-inline-form"><input value={assignmentTitle} onChange={(event) => setAssignmentTitle(event.target.value)} placeholder="Название домашнего задания" /><textarea value={assignmentDescription} onChange={(event) => setAssignmentDescription(event.target.value)} placeholder="Описание и контекст для ученика" /><input value={assignmentRequirement} onChange={(event) => setAssignmentRequirement(event.target.value)} placeholder="Критерий проверки (необязательно)" /><button className="primary-button" type="button" disabled={saving || !assignmentTitle.trim() || !assignmentDescription.trim()} onClick={() => void createAssignment()}>{saving ? "Создаём…" : "Создать ДЗ в этом уроке"}</button></div>}<ol>{assignments.flatMap((assignment) => assignment.requirements.length > 0 ? assignment.requirements : [assignment.title]).map((item) => <li key={item}>{item}</li>)}</ol></section><section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>Блок урока</span><button className="quiet-button" type="button" onClick={() => openMediaLibrary("QA")}><Plus size={15} /> Добавить Q&A</button></div><ul>{fallback.questions.map((question) => <li key={question}>{question}</li>)}</ul><div className="module-action-feedback">Этот блок будет отображаться у ученика так же, как на этой странице.</div></section></div>{notice && <div className="detail-feedback accepted curator-lesson-notice">{notice}</div>}</div>;
}

void CuratorLessonPageLegacy;

function CuratorLessonPage({ module, lesson, lessons, onBack, onNavigate, onSwitchLesson }: { module: CourseApiModule; lesson: CourseLesson; lessons: CourseLesson[]; onBack: () => void; onNavigate: (nextNav: CuratorNav) => void; onSwitchLesson: (lessonId: string) => void }) {
  const studentModule: PracticumModule = { id: module.id, section: ["Welcome", "Education", "Q&A", "Practice"].includes(module.section) ? module.section as PracticumSection : "Education", number: module.number, title: module.title, status: module.status, progress: module.progress, lessons: module.lessons.length, description: module.description ?? "", locked: module.locked };
  const fallback = modulePageContentFor(studentModule);
  const lessonMedia = lesson.media ?? [];
  const [media, setMedia] = useState<CourseLessonMedia[]>(lessonMedia);
  const [assignments, setAssignments] = useState<CourseLesson["assignments"]>(lesson.assignments ?? []);
  const [description, setDescription] = useState(lesson.description ?? "");
  const [showAssignmentForm, setShowAssignmentForm] = useState(false);
  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [assignmentDescription, setAssignmentDescription] = useState("");
  const [assignmentRequirements, setAssignmentRequirements] = useState<string[]>([""]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingMediaId, setDeletingMediaId] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const showNotice = (message: string, error = false) => { setNoticeError(error); setNotice(message); };
  const thematicMedia = media.filter((item) => item.kind !== "QA");
  const qaMedia = media.filter((item) => item.kind === "QA");

  const openMediaLibrary = (targetKind: "STREAM" | "QA" | "BREAKDOWN") => {
    window.sessionStorage.setItem("curator-target-lesson", lesson.id);
    window.sessionStorage.setItem("curator-target-kind", targetKind);
    onNavigate("Медиатека");
  };
  // The lesson editor uses the same canonical assignment form as the curator sidebar.
  // Keep the lesson context in session storage so the form can preselect this exact lesson.
  useEffect(() => {
    if (!showAssignmentForm) return;
    window.sessionStorage.setItem(ASSIGNMENT_TARGET_MODULE_KEY, module.id);
    window.sessionStorage.setItem(ASSIGNMENT_TARGET_LESSON_KEY, lesson.id);
    onNavigate("Создать задание");
  }, [lesson.id, module.id, onNavigate, showAssignmentForm]);
  const createAssignment = async () => {
    if (!assignmentTitle.trim() || !assignmentDescription.trim()) return;
    setSaving(true); showNotice("");
    try {
      const requirements = assignmentRequirements.map((requirement) => requirement.trim()).filter(Boolean);
      const response = await fetch(`${API_ORIGIN}/api/assignments`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonId: lesson.id, title: assignmentTitle.trim(), description: assignmentDescription.trim(), moduleNumber: module.number, moduleTitle: module.title, requirements, allowedFormats: ["comment", "image"] }) });
      const payload = await response.json().catch(() => ({})) as { data?: CourseLesson["assignments"][number]; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать домашнее задание");
      const createdAssignment = payload.data as CourseLesson["assignments"][number];
      setAssignments((current) => [...current, {
        ...createdAssignment,
        title: createdAssignment.title || assignmentTitle.trim(),
        description: createdAssignment.description || assignmentDescription.trim(),
        requirements: Array.isArray(createdAssignment.requirements) ? createdAssignment.requirements : requirements,
        allowedFormats: Array.isArray(createdAssignment.allowedFormats) ? createdAssignment.allowedFormats : ["comment", "image"],
        deadline: createdAssignment.deadline ?? null,
      }]);
      setAssignmentTitle(""); setAssignmentDescription(""); setAssignmentRequirements([""]); setShowAssignmentForm(false); showNotice("Домашнее задание добавлено в этот урок.");
    } catch (reason) { showNotice(reason instanceof Error ? reason.message : "Не удалось создать домашнее задание", true); }
    finally { setSaving(false); }
  };
  const moveMedia = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    setMedia((current) => {
      const from = current.findIndex((item) => item.id === draggedId); const to = current.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved); return next;
    });
  };
  const archiveLessonMedia = async (item: CourseLessonMedia) => {
    if (deletingMediaId) return;
    const title = item.title?.trim() || "Без названия";
    if (!window.confirm(`Убрать запись «${title}» из этого урока? Само видео Vimeo удалено не будет.`)) return;
    setDeletingMediaId(item.id);
    setSaving(true);
    showNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media/${item.id}`, { method: "DELETE", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось удалить запись.");
      setMedia((current) => current.filter((mediaItem) => mediaItem.id !== item.id));
      showNotice("Запись убрана из урока и больше не будет показана ученикам.");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Не удалось удалить запись.", true);
    } finally {
      setSaving(false);
      setDeletingMediaId("");
    }
  };
  const save = async () => {
    setSaving(true); showNotice("");
    try {
      const [lessonResponse, orderResponse] = await Promise.all([
        fetch(`${API_ORIGIN}/api/course/lessons/${lesson.id}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: lesson.title, description }) }),
        fetch(`${API_ORIGIN}/api/course/lessons/${lesson.id}/media/reorder`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaIds: media.map((item) => item.id) }) }),
      ]);
      if (!lessonResponse.ok || !orderResponse.ok) throw new Error("Не удалось сохранить изменения урока");
      showNotice("Изменения сохранены. Именно так урок увидит ученик.");
    } catch (reason) { showNotice(reason instanceof Error ? reason.message : "Не удалось сохранить изменения урока", true); }
    finally { setSaving(false); }
  };

  return <div className="module-page curator-lesson-page">
    <div className="module-page-toolbar"><button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к программе</button><span className="module-page-breadcrumb">{module.section} / {module.title} / {lesson.title}</span><div className="curator-lesson-switcher">{lessons.map((item) => <button className={item.id === lesson.id ? "active" : ""} type="button" key={item.id} onClick={() => onSwitchLesson(item.id)}>{item.title}</button>)}</div><div className="curator-lesson-toolbar-actions"><button className="secondary-button" type="button" onClick={() => openMediaLibrary("STREAM")}><Plus size={15} /> Добавить стрим</button><button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Сохраняем…" : "Сохранить урок"}</button></div></div>
    <div className="curator-lesson-page-header"><span className="section-kicker">МОДУЛЬ {module.number}</span><h2>{module.title}</h2></div>
    <div className="curator-lesson-hint"><Settings2 size={16} /><span>Тематические стримы находятся в центральном блоке, а записи Q&A — рядом с вопросами.</span></div>
    <div className="module-resource-grid">
      <section className="module-resource-card module-description-card"><div className="module-resource-heading"><BookOpen size={17} /><h3>Описание</h3><span>Редактируется</span></div><textarea className="curator-lesson-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Добавьте описание урока…" /></section>
      <section className="module-resource-card module-stream-card"><div className="module-resource-heading"><Play size={17} /><h3>Тематические записи</h3><span>{thematicMedia.length} {thematicMedia.length === 1 ? "материал" : "материалов"}</span><button className="quiet-button add-button" type="button" onClick={() => openMediaLibrary("STREAM")}><Plus size={15} /> Добавить стрим</button></div>{thematicMedia.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Тематических стримов пока нет</strong><span>Q&A-записи не смешиваются с тематическими материалами.</span></div> : <div className="module-video-stack">{thematicMedia.map((item) => <div className={`module-video-stage ${draggedId === item.id ? "is-dragging" : ""}`} key={item.id} draggable onDragStart={() => setDraggedId(item.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveMedia(item.id)}>{item.embedUrl && <iframe src={item.embedUrl} title={item.title ?? "Запись стрима"} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}<span className="module-video-label">{item.title ?? "Материал без названия"}</span><span className="stream-duration">{item.status === "PUBLISHED" ? "ОПУБЛИКОВАНО" : "ЧЕРНОВИК"}</span><div className="module-video-card-controls"><span className="curator-drag-handle" title="Перетащите, чтобы изменить порядок">⋮⋮</span><span className="module-video-kind-badge">{mediaKindLabel(item.kind)}</span><button className="quiet-button danger-button" type="button" disabled={saving || deletingMediaId === item.id} onClick={() => void archiveLessonMedia(item)}>{deletingMediaId === item.id ? "Удаляем…" : "Удалить"}</button></div></div>)}</div>}</section>
      <section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{assignments.length} {assignments.length === 1 ? "задание" : "заданий"}</span><button className="quiet-button add-button" type="button" onClick={() => setShowAssignmentForm((current) => !current)}><Plus size={15} /> {showAssignmentForm ? "Закрыть" : "Добавить ДЗ"}</button></div>{showAssignmentForm && <div className="curator-inline-form"><input value={assignmentTitle} onChange={(event) => setAssignmentTitle(event.target.value)} placeholder="Название домашнего задания" /><textarea value={assignmentDescription} onChange={(event) => setAssignmentDescription(event.target.value)} placeholder="Описание и контекст для ученика" /><div className="assignment-criteria-editor"><div className="assignment-criteria-heading"><span>Критерии проверки</span><button className="quiet-button" type="button" onClick={() => setAssignmentRequirements((current) => [...current, ""])}><Plus size={14} /> Добавить критерий</button></div>{assignmentRequirements.map((requirement, index) => <div className="assignment-criterion-row" key={`new-criterion-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><input value={requirement} onChange={(event) => setAssignmentRequirements((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="Например: разобрать график и описать выводы" />{assignmentRequirements.length > 1 && <button className="icon-button compact" type="button" aria-label={`Удалить критерий ${index + 1}`} onClick={() => setAssignmentRequirements((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>}</div>)}</div><button className="primary-button" type="button" disabled={saving || !assignmentTitle.trim() || !assignmentDescription.trim()} onClick={() => void createAssignment()}>{saving ? "Создаём…" : "Создать ДЗ в этом уроке"}</button></div>}{assignments.length > 0 ? <div className="curator-assignment-list">{assignments.map((assignment) => <article className="curator-assignment-card" key={assignment.id}><div><strong>{assignment.title}</strong><p>{assignment.description}</p></div>{assignment.requirements.length > 0 && <ol>{assignment.requirements.map((requirement, index) => <li key={`${assignment.id}-${index}`}>{requirement}</li>)}</ol>}</article>)}</div> : <div className="module-empty-copy">В этом уроке пока нет домашних заданий.</div>}</section>
      <section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>{qaMedia.length} {qaMedia.length === 1 ? "запись" : "записей"}</span><button className="quiet-button add-button" type="button" onClick={() => openMediaLibrary("QA")}><Plus size={15} /> Добавить Q&A</button></div>{qaMedia.length > 0 && <div className="module-video-stack">{qaMedia.map((item) => <div className="module-qa-video-stage" key={item.id}>{item.embedUrl && <TrackedVideo mediaId={item.id} src={item.embedUrl} title={item.title ?? "Q&A с куратором"} />}<span>{item.title ?? "Q&A-запись"}</span><div className="module-video-card-controls"><span className="module-video-kind-badge">{item.status === "PUBLISHED" ? "Опубликовано" : "Черновик"}</span><button className="quiet-button danger-button" type="button" disabled={saving || deletingMediaId === item.id} onClick={() => void archiveLessonMedia(item)}>{deletingMediaId === item.id ? "Удаляем…" : "Удалить"}</button></div></div>)}</div>}<ul>{fallback.questions.map((question) => <li key={question}>{question}</li>)}</ul>{qaMedia.length === 0 && <div className="module-action-feedback">Добавьте Q&A-запись — она будет показана ученику именно в этом блоке.</div>}</section>
    </div>{notice && <div className={`detail-feedback ${noticeError ? "error" : "accepted"} curator-lesson-notice`} role={noticeError ? "alert" : undefined}>{notice}</div>}
  </div>;
}

function CuratorLessonBuilder({ lesson, onNavigate, onEdit, onOpenPage }: { lesson: BuilderLesson; onNavigate: (nextNav: CuratorNav) => void; onEdit: () => void; onOpenPage: () => void }) {
  const [open] = useState(false);
  const [media, setMedia] = useState<CourseLessonMedia[]>(lesson.media ?? []);
  const [description, setDescription] = useState(lesson.description ?? "");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  const moveMedia = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    setMedia((current) => {
      const from = current.findIndex((item) => item.id === draggedId);
      const to = current.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const saveOrder = async () => {
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/lessons/${lesson.id}/media/reorder`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaIds: media.map((item) => item.id) }) });
      if (!response.ok) throw new Error("Не удалось сохранить порядок блоков");
      setNotice("Порядок блоков сохранён");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Не удалось сохранить порядок блоков");
    } finally { setSaving(false); }
  };

  const saveDescription = async () => {
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/lessons/${lesson.id}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: lesson.title, description }) });
      if (!response.ok) throw new Error("Не удалось сохранить текст урока");
      setNotice("Текст урока сохранён");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : "Не удалось сохранить текст урока");
    } finally { setSaving(false); }
  };

  return <div className="lesson-builder-shell"><div className="module-lesson-row"><div><strong>{lesson.title}</strong><span>{media.length + (lesson.assignments?.length ?? 0)} блоков · конструктор урока</span></div><div className="lesson-builder-actions"><button className="primary-button" type="button" onClick={onOpenPage}>Открыть урок</button><button className="secondary-button" type="button" onClick={onEdit}>Название и описание</button><button className="secondary-button" type="button" onClick={() => onNavigate("Медиатека")}>Медиатека <ArrowUpRight size={14} /></button></div></div>{open && <div className="lesson-builder"><div className="lesson-builder-canvas"><div className="lesson-builder-toolbar"><div><span className="section-kicker">КОНСТРУКТОР УРОКА</span><strong>Блоки увидит ученик в этом порядке</strong></div><div className="lesson-builder-toolbar-actions"><button className="secondary-button" type="button" disabled={saving} onClick={() => void saveDescription()}>{saving ? "Сохраняем…" : "Сохранить текст"}</button><button className="primary-button" type="button" disabled={saving} onClick={() => void saveOrder()}>{saving ? "Сохраняем…" : "Сохранить порядок"}</button></div></div><div className="lesson-builder-block text-block"><div className="lesson-builder-block-head"><span className="lesson-builder-grip">⋮⋮</span><strong>Текст урока</strong><span className="lesson-builder-type">Описание</span></div><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Добавьте вводный текст, инструкции или контекст для ученика…" /></div>{media.map((item) => <div className="lesson-builder-block" key={item.id} draggable onDragStart={() => setDraggedId(item.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveMedia(item.id)}><div className="lesson-builder-block-head"><span className="lesson-builder-grip">⋮⋮</span><strong>{item.title || "Материал без названия"}</strong><span className="lesson-builder-type">{item.kind === "QA" ? "Q&A" : item.kind === "BREAKDOWN" ? "Разбор" : "Стрим"}</span></div>{item.embedUrl ? <div className="lesson-builder-video"><iframe src={item.embedUrl} title={item.title || "Видео урока"} allow="autoplay; fullscreen; picture-in-picture" /></div> : <div className="lesson-builder-empty">У материала пока нет предпросмотра</div>}</div>)}{lesson.assignments?.map((assignment) => <div className="lesson-builder-block assignment-block" key={assignment.id}><div className="lesson-builder-block-head"><span className="lesson-builder-grip">⋮⋮</span><strong>{assignment.title}</strong><span className="lesson-builder-type">Домашнее задание</span></div><p>{assignment.description}</p></div>)}{media.length === 0 && (lesson.assignments?.length ?? 0) === 0 && <div className="lesson-builder-empty">Добавьте первый стрим в медиатеке — он появится здесь отдельным блоком.</div>}{notice && <div className="detail-feedback accepted">{notice}</div>}</div><aside className="lesson-builder-preview"><span className="section-kicker">ПРЕДПРОСМОТР</span><strong>Так увидит ученик</strong><div className="student-lesson-preview"><h3>{lesson.title}</h3>{description && <p>{description}</p>}{media.map((item) => <div className="student-preview-media" key={item.id}><span>{item.title || "Материал"}</span>{item.embedUrl && <iframe src={item.embedUrl} title={item.title || "Материал"} allow="autoplay; fullscreen; picture-in-picture" />}</div>)}{lesson.assignments?.map((assignment) => <div className="student-preview-assignment" key={assignment.id}><strong>{assignment.title}</strong><span>Домашнее задание</span></div>)}</div></aside></div>}</div>;
}

function CuratorModuleAccessView({ onNavigate }: { onNavigate: (nextNav: CuratorNav) => void }) {
  const [modules, setModules] = useState<CourseApiModule[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState("");
  const [editingLesson, setEditingLesson] = useState("");
  const [lessonTitle, setLessonTitle] = useState("");
  const [lessonDescription, setLessonDescription] = useState("");
  const [openedLessonId, setOpenedLessonId] = useState("");
  const [showModuleForm, setShowModuleForm] = useState(false);
  const [moduleTitle, setModuleTitle] = useState("");
  const [moduleSection, setModuleSection] = useState("Education");
  const [moduleDescription, setModuleDescription] = useState("");
  const [moduleCoverPath, setModuleCoverPath] = useState("");
  const [moduleCoverFile, setModuleCoverFile] = useState<File | null>(null);
  const [moduleCoverFileName, setModuleCoverFileName] = useState("");
  const [moduleLessonTitle, setModuleLessonTitle] = useState("");
  useEffect(() => { void fetch(`${API_ORIGIN}/api/course/manage`, { credentials: "include", cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error("Не удалось загрузить программу"); const payload = await response.json() as { data: { modules: CourseApiModule[] } }; setModules(payload.data.modules); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось загрузить программу")); }, []);
  // A curator always sees full content while editing, so the server hardcodes
  // module.locked to false for this role — it never reflects the real per-cohort state.
  // module.status (backed by Module.defaultAccess) is the real "open to everyone" signal.
  const toggle = async (module: CourseApiModule) => {
    const currentlyUnlocked = module.status !== "LOCKED";
    setBusy(module.id); setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${module.id}/access`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unlocked: !currentlyUnlocked }) });
      if (!response.ok) throw new Error("Не удалось изменить доступ");
      setModules((current) => current.map((item) => item.id === module.id ? { ...item, status: currentlyUnlocked ? "LOCKED" : "UNLOCKED" } : item));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось изменить доступ"); } finally { setBusy(""); }
  };
  const markCompleted = async (module: CourseApiModule) => {
    if (!window.confirm(`Отметить блок «${module.title}» пройденным для всех учеников потока? Каждому откроется содержимое следующего блока, а его ДЗ станет доступно для отправки.`)) return;
    setBusy(module.id); setError(""); setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${module.id}/complete`, { method: "POST", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { data?: { completedCount: number; totalEnrollments: number }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось отметить блок пройденным");
      setNotice(`«${module.title}» отмечен пройденным: ${payload.data.completedCount} из ${payload.data.totalEnrollments} учеников.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отметить блок пройденным");
    } finally {
      setBusy("");
    }
  };
  const deleteModule = async (module: CourseApiModule) => { if (!window.confirm(`Удалить блок «${module.title}»? Все материалы блока без работ учеников будут удалены.`)) return; setBusy(module.id); setError(""); try { const response = await fetch(`${API_ORIGIN}/api/course/modules/${module.id}`, { method: "DELETE", credentials: "include" }); const payload = await response.json().catch(() => null) as { message?: string } | null; if (!response.ok) throw new Error(payload?.message || "Не удалось удалить блок"); setModules((current) => current.filter((item) => item.id !== module.id)); if (expanded === module.id) setExpanded(""); if (openedLessonId && module.lessons.some((lesson) => lesson.id === openedLessonId)) setOpenedLessonId(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось удалить блок"); } finally { setBusy(""); } };
  const saveLesson = async (lessonId: string) => { setBusy(lessonId); setError(""); try { const response = await fetch(`${API_ORIGIN}/api/course/lessons/${lessonId}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: lessonTitle, description: lessonDescription }) }); if (!response.ok) throw new Error("Не удалось сохранить урок"); setModules((current) => current.map((module) => ({ ...module, lessons: module.lessons.map((lesson) => lesson.id === lessonId ? { ...lesson, title: lessonTitle, description: lessonDescription } : lesson) }))); setEditingLesson(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось сохранить урок"); } finally { setBusy(""); } };
  const createModule = async () => {
    setBusy("new-module"); setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: moduleTitle, section: moduleSection, description: moduleDescription, coverPath: moduleCoverPath || undefined, lessonTitle: moduleLessonTitle || undefined }) });
      const payload = await response.json().catch(() => ({})) as { data?: CourseApiModule; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать блок");
      let createdModule = payload.data;
      if (moduleCoverFile) {
        let uploadedFileId = "";
        try {
          uploadedFileId = await uploadPrivateFile(moduleCoverFile, "MODULE_COVER");
          const attachResponse = await fetch(`${API_ORIGIN}/api/files/${uploadedFileId}/module-cover/${createdModule.id}`, { method: "POST", credentials: "include" });
          const attachPayload = await attachResponse.json().catch(() => ({})) as { data?: { coverPath: string }; message?: string };
          if (!attachResponse.ok || !attachPayload.data) throw new Error(attachPayload.message ?? "обложку не удалось прикрепить");
          createdModule = { ...createdModule, coverPath: attachPayload.data.coverPath };
        } catch (reason) {
          if (uploadedFileId) void fetch(`${API_ORIGIN}/api/files/${uploadedFileId}`, { method: "DELETE", credentials: "include" }).catch(() => undefined);
          setModules((current) => [...current, createdModule]);
          setShowModuleForm(false); setModuleTitle(""); setModuleDescription(""); setModuleCoverPath(""); setModuleCoverFile(null); setModuleCoverFileName(""); setModuleLessonTitle("");
          throw new Error(`Блок создан, но ${reason instanceof Error ? reason.message : "обложку не удалось прикрепить"}.`);
        }
      }
      setModules((current) => [...current, createdModule]);
      setShowModuleForm(false); setModuleTitle(""); setModuleDescription(""); setModuleCoverPath(""); setModuleCoverFile(null); setModuleCoverFileName(""); setModuleLessonTitle("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать блок"); }
    finally { setBusy(""); }
  };
  const openedLesson = modules.flatMap((module) => module.lessons.map((lesson) => ({ module, lesson }))).find((item) => item.lesson.id === openedLessonId);
  if (openedLesson) return <CuratorLessonPage key={openedLesson.lesson.id} module={openedLesson.module} lesson={openedLesson.lesson} lessons={openedLesson.module.lessons} onBack={() => setOpenedLessonId("")} onNavigate={onNavigate} onSwitchLesson={setOpenedLessonId} />;
  const unlockedCount = modules.filter((module) => module.status !== "LOCKED").length;
  return <section className="content-panel module-access-panel"><div className="section-heading"><div><span className="section-kicker">ДОСТУП К ПРОГРАММЕ</span><h2>Блоки практикума</h2><p className="section-heading-note">Откройте блок — и сразу попадёте в страницу его урока, как её видит ученик.</p></div><span className="progress-inline">{unlockedCount} из {modules.length} открыто</span><button className="primary-button module-add-button" type="button" onClick={() => setShowModuleForm((current) => !current)}><Plus size={16} /> {showModuleForm ? "Закрыть форму" : "Добавить блок"}</button></div>{showModuleForm && <div className="module-create-form"><div className="module-create-form-heading"><div><span className="section-kicker">НОВЫЙ БЛОК</span><strong>Добавить модуль в программу</strong><p>Новый блок будет закрыт для учеников. После создания добавьте материалы и откройте доступ.</p></div></div><div className="module-create-fields"><label><span>Название блока</span><input value={moduleTitle} onChange={(event) => setModuleTitle(event.target.value)} placeholder="Например, Управление риском" /></label><label><span>Раздел</span><select value={moduleSection} onChange={(event) => setModuleSection(event.target.value)}><option value="Education">Education</option><option value="Practice">Practice</option><option value="Q&A">Q&A</option><option value="Welcome">Welcome</option></select></label><label className="module-create-wide"><span>Описание</span><textarea value={moduleDescription} onChange={(event) => setModuleDescription(event.target.value)} placeholder="Что ученик изучит в этом блоке" /></label><div className="module-cover-picker module-create-wide"><div className="module-cover-picker-head"><span>Обложка блока</span><small>PNG, JPG или WEBP · до 5 МБ</small></div><label className="module-cover-upload"><Plus size={16} /><span>{moduleCoverFileName || "Выбрать изображение с компьютера"}</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { setError("Обложка должна быть PNG, JPG или WEBP."); return; } if (file.size > 5 * 1024 * 1024) { setError("Размер обложки не должен превышать 5 МБ."); return; } setModuleCoverFile(file); setModuleCoverFileName(file.name); setModuleCoverPath(""); setError(""); }} /></label><label><span>Или путь из public</span><input value={moduleCoverPath} onChange={(event) => { setModuleCoverPath(event.target.value); setModuleCoverFile(null); setModuleCoverFileName(""); }} placeholder="/event-covers/PRE-session.png" /></label></div><label><span>Первый урок</span><input value={moduleLessonTitle} onChange={(event) => setModuleLessonTitle(event.target.value)} placeholder="Вводный урок" /></label></div><div className="module-create-actions"><button className="secondary-button" type="button" onClick={() => setShowModuleForm(false)}>Отмена</button><button className="primary-button" type="button" disabled={busy === "new-module" || !moduleTitle.trim()} onClick={() => void createModule()}>{busy === "new-module" ? "Создаём…" : "Создать блок"}</button></div></div>}{error && <div className="file-error" role="alert">{error}</div>}{notice && <div className="form-action-feedback">{notice}</div>}<div className="module-access-list">{modules.map((module) => { const unlocked = module.status !== "LOCKED"; const isExpanded = expanded === module.id; return <div key={module.id}><div className={`module-access-row ${unlocked ? "is-unlocked" : "is-locked"}`}><div className={`module-access-status ${unlocked ? "open" : "closed"}`}>{unlocked ? "Доступен ученикам" : "Закрыт"}</div><div className="module-access-copy"><strong data-module-number={module.number}>{module.title}</strong><span>{module.section} · {module.lessons.length} {module.lessons.length === 1 ? "урок" : "уроков"}</span></div><div className="module-access-actions"><button className="secondary-button" type="button" onClick={() => module.lessons[0] ? setOpenedLessonId(module.lessons[0].id) : setExpanded(isExpanded ? "" : module.id)}>Открыть урок</button><button className={unlocked ? "secondary-button" : "primary-button"} type="button" disabled={busy === module.id} onClick={() => void toggle(module)}>{busy === module.id ? "Сохраняем…" : unlocked ? "Закрыть блок" : "Разблокировать"}</button><button className="secondary-button" type="button" disabled={busy === module.id} onClick={() => void markCompleted(module)}>Модуль пройден</button><button className="secondary-button danger-button" type="button" disabled={busy === module.id} onClick={() => void deleteModule(module)}>Удалить</button></div></div>{isExpanded && <div className="module-lesson-editor"><div className="module-lesson-editor-head"><strong>Уроки блока</strong><button className="secondary-button" type="button" onClick={() => onNavigate("Медиатека")}><Plus size={15} /> Добавить материал</button></div>{module.lessons.map((lesson) => <div className="module-lesson-row" key={lesson.id}>{editingLesson === lesson.id ? <div className="module-lesson-edit-form"><input value={lessonTitle} onChange={(event) => setLessonTitle(event.target.value)} /><textarea value={lessonDescription} onChange={(event) => setLessonDescription(event.target.value)} placeholder="Описание урока" /><div><button className="primary-button" type="button" disabled={busy === lesson.id} onClick={() => void saveLesson(lesson.id)}>Сохранить</button><button className="secondary-button" type="button" onClick={() => setEditingLesson("")}>Отмена</button></div></div> : <CuratorLessonBuilder lesson={lesson} onNavigate={onNavigate} onEdit={() => { setEditingLesson(lesson.id); setLessonTitle(lesson.title); setLessonDescription(lesson.description ?? ""); }} onOpenPage={() => setOpenedLessonId(lesson.id)} />}</div>)}</div>}</div>; })}</div></section>;
}

function CuratorPlaceholder({ title }: { title: string }) {
  return <section className="content-panel curator-placeholder"><div className="empty-state"><Target size={24} /><strong>{title} будет следующим рабочим разделом</strong><span>Каркас роли уже отделён от ученического интерфейса. После проверки основного сценария здесь появятся реальные списки и действия куратора.</span></div></section>;
}

// Kept only as a visual reference for the server-backed media library below.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyCuratorMediaLibraryView({ onAttachLessonVideo }: { onAttachLessonVideo: (moduleId: string, video: LessonVideo) => void }) {
  const initialUrl = "https://vimeo.com/1197792122?share=copy&fl=sv&fe=ci";
  const initialEmbedUrl = normalizeVimeoUrl(initialUrl) ?? "";
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("market-logic-stream");
  const [showForm, setShowForm] = useState(false);
  const [draftTitle, setDraftTitle] = useState("Market Logic · запись стрима");
  const [draftUrl, setDraftUrl] = useState(initialUrl);
  const [draftSource, setDraftSource] = useState<LessonVideo["source"]>("vimeo");
  const [draftFileUrl, setDraftFileUrl] = useState("");
  const [draftFileName, setDraftFileName] = useState("");
  const [draftType, setDraftType] = useState<MediaLibraryItem["type"]>("Запись стрима");
  const [notice, setNotice] = useState("");
  const [attached, setAttached] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaLibraryItem[]>([
    { id: "market-logic-stream", title: "Market Logic · запись стрима", source: "vimeo", url: initialEmbedUrl, duration: "1:21:16", type: "Запись стрима", kind: "stream", module: "Education / Market Logic", lessonId: "week-1", status: "Опубликовано", cover: "/market-logic-cover.png" },
    { id: "qa-curator", title: "Q&A с куратором", source: "vimeo", url: "", duration: "42:08", type: "Видеоразбор", kind: "breakdown", module: "Education / Market Logic", lessonId: "week-1", status: "Черновик", cover: "/qa-cover.png" },
    { id: "backtest-guide", title: "Backtest: что, как, зачем?", source: "upload", url: "", duration: "PDF", type: "Материал урока", kind: "file", module: "Practice / Backtest", lessonId: "backtest", status: "Привязан к уроку", cover: "/backtest-performance.png" },
  ]);
  const filteredItems = filter === "all" ? mediaItems : mediaItems.filter((item) => item.kind === filter);
  const selectedItem = mediaItems.find((item) => item.id === selectedId) ?? mediaItems[0];
  const canPreview = selectedItem.url.length > 0;
  const filters = [{ id: "all", label: "Все" }, { id: "stream", label: "Стримы" }, { id: "breakdown", label: "Видеоразборы" }, { id: "file", label: "Материалы" }];

  const createMediaItem = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = draftSource === "vimeo" ? normalizeVimeoUrl(draftUrl) : draftFileUrl;
    if (!url) {
      setNotice(draftSource === "vimeo" ? "Нужна корректная ссылка Vimeo с номером видео." : "Выбери видеофайл для загрузки.");
      return;
    }
    const kind = draftType === "Видеоразбор" ? "breakdown" : draftType === "Материал урока" ? "file" : "stream";
    const nextItem: MediaLibraryItem = { id: `media-${Date.now()}`, title: draftTitle.trim() || "Новый материал", source: draftSource, url, duration: draftSource === "upload" ? "Видео" : "1:21:16", type: draftType, kind, module: "Education / Market Logic", lessonId: "week-1", status: "Черновик", cover: "/market-logic-cover.png" };
    setMediaItems((current) => [nextItem, ...current]);
    setSelectedId(nextItem.id);
    setAttached(false);
    setNotice("Материал добавлен в медиатеку. Проверь предпросмотр и прикрепи его к уроку.");
  };

  const attachSelected = () => {
    if (!canPreview) return;
    onAttachLessonVideo(selectedItem.lessonId, { title: selectedItem.title, source: selectedItem.source, url: selectedItem.url, duration: selectedItem.duration });
    setAttached(true);
  };

  return <div className="media-library-page"><div className="media-library-toolbar"><div className="assignment-filter">{filters.map((item) => <button className={`filter-chip ${filter === item.id ? "active" : ""}`} key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{item.id === "all" ? mediaItems.length : mediaItems.filter((mediaItem) => mediaItem.kind === item.id).length}</span></button>)}</div><button className="primary-button" onClick={() => { setShowForm((current) => !current); setNotice(""); }}><Plus size={16} /> {showForm ? "Закрыть добавление" : "Добавить материал"}</button></div>{showForm && <section className="content-panel media-editor-panel"><div className="section-heading"><div><span className="section-kicker">НОВЫЙ МАТЕРИАЛ</span><h2>Добавить стрим или видео</h2><p className="section-heading-note">Выбери источник, укажи урок и сначала проверь материал в предпросмотре.</p></div></div><form className="media-editor-body" onSubmit={createMediaItem}><div className="media-source-switch" role="group" aria-label="Источник видео"><button type="button" className={draftSource === "vimeo" ? "active" : ""} onClick={() => setDraftSource("vimeo")}>Ссылка Vimeo</button><button type="button" className={draftSource === "upload" ? "active" : ""} onClick={() => setDraftSource("upload")}>Загрузить файл</button></div><div className="media-editor-fields"><label className="form-field"><span>Название материала</span><input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} /></label><label className="form-field"><span>Тип</span><select value={draftType} onChange={(event) => setDraftType(event.target.value as MediaLibraryItem["type"])}><option>Запись стрима</option><option>Видеоразбор</option><option>Материал урока</option></select></label><label className="form-field"><span>Привязать к уроку</span><select defaultValue="week-1"><option value="week-1">Market Logic · базовые принципы</option></select></label>{draftSource === "vimeo" ? <label className="form-field"><span>Ссылка Vimeo</span><input type="url" value={draftUrl} onChange={(event) => { setDraftUrl(event.target.value); setNotice(""); }} placeholder="https://vimeo.com/123456789" /></label> : <label className="form-field"><span>Видео-файл</span><input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; setDraftFileName(file.name); setDraftFileUrl(URL.createObjectURL(file)); setNotice(""); }} /><small className="file-field-note">{draftFileName || "MP4, WebM или MOV · до 500 МБ"}</small></label>}</div><p className="media-link-note">После прикрепления материал появится внизу страницы выбранного урока. В production файл будет загружаться в S3-compatible storage, а Vimeo останется внешним защищённым источником.</p><div className="media-form-actions"><button className="primary-button" type="submit"><Play size={16} /> Добавить в медиатеку</button>{notice && <span className="form-action-feedback"><Target size={16} /> {notice}</span>}</div></form></section>}<div className="media-library-grid"><section className="media-card-grid">{filteredItems.map((item) => <button className={`media-card ${item.id === selectedId ? "selected" : ""}`} key={item.id} onClick={() => { setSelectedId(item.id); setAttached(false); }} aria-pressed={item.id === selectedId}><div className="media-card-cover"><Image src={item.cover} alt={`Обложка: ${item.title}`} fill sizes="(max-width: 700px) 100vw, (max-width: 1100px) 50vw, 33vw" /><span className="media-card-kind">{item.type}</span>{item.kind === "stream" && <span className="media-card-play"><Play size={16} fill="currentColor" /></span>}<span className="media-card-duration">{item.duration}</span></div><div className="media-card-copy"><span>{item.module}</span><h3>{item.title}</h3><div><small className={`media-status ${item.status === "Черновик" ? "draft" : ""}`}>{item.status}</small><ChevronRight size={15} /></div></div></button>)}</section><section className="content-panel media-preview-panel"><div className="section-heading"><div><span className="section-kicker">ПРЕДПРОСМОТР</span><h2>{selectedItem.title}</h2></div><span className="media-source-badge"><span className="live-dot" /> {selectedItem.source === "vimeo" ? "Vimeo" : "Файл"}</span></div>{selectedItem.source === "vimeo" && canPreview ? <div className="media-vimeo-stage"><iframe src={selectedItem.url} title={`Предпросмотр: ${selectedItem.title}`} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div> : selectedItem.source === "upload" && canPreview ? <div className="media-vimeo-stage"><video src={selectedItem.url} controls playsInline /></div> : <div className="media-selected-cover"><Image src={selectedItem.cover} alt="" fill sizes="(max-width: 1000px) 100vw, 45vw" /></div>}<div className="media-preview-meta"><div><span className="section-kicker">ПРИВЯЗКА К УРОКУ</span><strong>{selectedItem.module} · Market Logic</strong><small>{attached ? "Материал прикреплён к уроку" : canPreview ? "Готов к привязке к уроку" : "Сначала добавь ссылку или файл"}</small></div><button className="primary-button" type="button" disabled={!canPreview} onClick={attachSelected}>{attached ? "Прикреплено" : "Прикрепить к уроку"} {!attached && <ChevronRight size={16} />}</button></div></section></div></div>;
}

type CuratorMediaItem = CourseLessonMedia & {
  lessonId: string | null;
  lessonTitle: string;
  moduleTitle: string;
  eventTitle?: string;
};

function mediaKindLabel(kind: CuratorMediaItem["kind"]): string {
  return {
    LESSON_VIDEO: "Урок",
    STREAM: "Стрим",
    QA: "Q&A",
    BREAKDOWN: "Разбор",
    TALKS: "Talks · общение",
  }[kind];
}

function CuratorMediaLibraryView() {
  const [course, setCourse] = useState<CourseState | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [scheduleEventId, setScheduleEventId] = useState("");
  const [title, setTitle] = useState("");
  const [vimeoUrl, setVimeoUrl] = useState("");
  const [kind, setKind] = useState<CuratorMediaItem["kind"]>("STREAM");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [viewersFor, setViewersFor] = useState("");
  const [viewersLoading, setViewersLoading] = useState(false);
  const [viewers, setViewers] = useState<{ id: string; ipAddress: string | null; createdAt: string; viewer: { id: string; role: string; name: string } }[]>([]);
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyKind, setReclassifyKind] = useState<CuratorMediaItem["kind"]>("STREAM");
  const [reclassifyLessonId, setReclassifyLessonId] = useState("");
  const [reclassifyScheduleEventId, setReclassifyScheduleEventId] = useState("");
  const [showExisting, setShowExisting] = useState(false);

  const loadCourse = useCallback(async () => {
    const response = await fetch(`${API_ORIGIN}/api/course/manage`, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as CourseApiPayload & { message?: string };
    if (!response.ok) throw new Error(payload.message ?? "Не удалось загрузить программу.");
    const nextCourse = normalizeCourse(payload);
    if (!nextCourse) throw new Error("В программе пока нет уроков.");
    setCourse(nextCourse);
    const firstLessonId = nextCourse.modules.flatMap((module) => nextCourse.lessonsByModule[module.id] ?? []).find(Boolean)?.id ?? "";
    setLessonId((current) => current || firstLessonId);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCourse()
        .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Не удалось загрузить программу."))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCourse]);

  const lessons = useMemo(() => course?.modules.flatMap((module) => (course.lessonsByModule[module.id] ?? []).map((lesson) => ({
    id: lesson.id,
    label: `${module.number} · ${module.title} — ${lesson.title}`,
  }))) ?? [], [course]);
  const items = useMemo<CuratorMediaItem[]>(() => {
    if (!course) return [];
    const eventTitles = new Map(course.scheduleEvents.map((event) => [event.id, event.title]));
    const lessonItems = course.modules.flatMap((module) => (course.lessonsByModule[module.id] ?? []).flatMap((lesson) => lesson.media.map((media) => ({
      ...media,
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      moduleTitle: `${module.number} · ${module.title}`,
      eventTitle: media.scheduleEventId ? eventTitles.get(media.scheduleEventId) : undefined,
    }))));
    const globalItems = course.globalMedia.map((media) => ({
      ...media,
      lessonId: null,
      lessonTitle: "Без привязки к уроку",
      moduleTitle: "Общая медиатека",
      eventTitle: media.scheduleEventId ? eventTitles.get(media.scheduleEventId) : undefined,
    }));
    return [...lessonItems, ...globalItems];
  }, [course]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  const isGlobalMedia = kind === "TALKS";
  const mediaDestinationLabel = kind === "QA" ? "Q&A урока" : kind === "BREAKDOWN" ? "разбор урока" : kind === "LESSON_VIDEO" ? "урок" : "тематический блок урока";
  const existingInScope = isGlobalMedia
    ? items.filter((item) => item.kind === "TALKS")
    : scheduleEventId
      ? items.filter((item) => item.scheduleEventId === scheduleEventId && item.kind === kind)
      : lessonId
        ? items.filter((item) => item.lessonId === lessonId && item.kind === kind)
        : [];
  useEffect(() => {
    const targetLessonId = window.sessionStorage.getItem("curator-target-lesson");
    const targetEventId = window.sessionStorage.getItem("curator-target-event");
    const targetKind = window.sessionStorage.getItem("curator-target-kind");
    if (targetKind === "STREAM" || targetKind === "QA" || targetKind === "BREAKDOWN") window.setTimeout(() => setKind(targetKind), 0);
    window.sessionStorage.removeItem("curator-target-kind");
    if (targetEventId && course?.scheduleEvents.some((event) => event.id === targetEventId)) {
      window.sessionStorage.removeItem("curator-target-event");
      window.setTimeout(() => setScheduleEventId(targetEventId), 0);
    }
    if (!targetLessonId || !lessons.some((lesson) => lesson.id === targetLessonId)) return;
    window.sessionStorage.removeItem("curator-target-lesson");
    const timer = window.setTimeout(() => { setLessonId(targetLessonId); }, 0);
    return () => window.clearTimeout(timer);
  }, [lessons, course?.scheduleEvents]);

  const createMedia = async (event: FormEvent<HTMLFormElement>, publishAfterCreate = false) => {
    event.preventDefault();
    setNotice("");
    setSaving(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(isGlobalMedia ? {} : { lessonId: lessonId || undefined, scheduleEventId: scheduleEventId || undefined }), title, kind, vimeoUrl }),
      });
      const payload = await response.json().catch(() => ({})) as { data?: { id: string }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось добавить запись.");
      if (publishAfterCreate) {
        const publishResponse = await fetch(`${API_ORIGIN}/api/course/media/${payload.data.id}/publish`, { method: "POST", credentials: "include" });
        if (!publishResponse.ok) throw new Error("Черновик создан, но не удалось опубликовать запись");
      }
      await loadCourse();
      setSelectedId(payload.data.id);
      setTitle("");
      setVimeoUrl("");
       setNotice(publishAfterCreate ? (isGlobalMedia ? "Talks-запись опубликована в общей медиатеке." : scheduleEventId ? "Запись опубликована и привязана к выбранному событию." : "Стрим опубликован и добавлен в выбранный урок.") : "Черновик создан. Проверь запись и опубликуй её, когда она готова для учеников.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось добавить запись.");
    } finally {
      setSaving(false);
    }
  };

  const publishMedia = async () => {
    if (!selected || selected.status === "PUBLISHED") return;
    setNotice("");
    setSaving(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media/${selected.id}/publish`, { method: "POST", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось опубликовать запись.");
      await loadCourse();
      setNotice("Запись опубликована. Она появится у учеников с доступом к этому модулю.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось опубликовать запись.");
    } finally {
      setSaving(false);
    }
  };

  const loadViewers = async (mediaId: string) => {
    if (viewersFor === mediaId) { setViewersFor(""); return; }
    setViewersFor(mediaId);
    setViewersLoading(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media/${mediaId}/viewers`, { credentials: "include", cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { data?: { events: typeof viewers } };
      setViewers(payload.data?.events ?? []);
    } catch {
      setViewers([]);
    } finally {
      setViewersLoading(false);
    }
  };

  const attachSelected = async () => {
    if (!selected || !lessonId || !selected.lessonId || selected.kind === "TALKS" || selected.lessonId === lessonId) return;
    setNotice(""); setSaving(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media/${selected.id}/lesson`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lessonId }) });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось привязать стрим к уроку");
      await loadCourse();
      setNotice("Стрим привязан к выбранному уроку.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось привязать стрим к уроку");
    } finally { setSaving(false); }
  };

  const openReclassify = () => {
    if (!selected) return;
    setReclassifyKind(selected.kind);
    setReclassifyLessonId(selected.lessonId ?? "");
    setReclassifyScheduleEventId(selected.scheduleEventId ?? "");
    setReclassifying(true);
  };

  const saveReclassify = async () => {
    if (!selected) return;
    const isTalks = reclassifyKind === "TALKS";
    setNotice(""); setSaving(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media/${selected.id}/kind`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: reclassifyKind,
          lessonId: isTalks ? undefined : (reclassifyScheduleEventId ? undefined : reclassifyLessonId || undefined),
          scheduleEventId: isTalks ? undefined : (reclassifyScheduleEventId || undefined),
        }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось изменить тип записи.");
      await loadCourse();
      setReclassifying(false);
      setNotice("Тип записи изменён. Проверь нужный блок урока.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось изменить тип записи.");
    } finally { setSaving(false); }
  };

  const archiveSelected = async () => {
    if (!selected || deletingId) return;
    const title = selected.title?.trim() || "Без названия";
    if (!window.confirm(`Убрать запись «${title}» из урока и медиатеки? Само видео Vimeo удалено не будет.`)) return;
    setNotice("");
    setDeletingId(selected.id);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media/${selected.id}`, { method: "DELETE", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось удалить запись.");
      setSelectedId("");
      setReclassifying(false);
      await loadCourse();
      setNotice("Запись удалена из доступного контента. Видео Vimeo осталось в исходном аккаунте.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось удалить запись.");
    } finally {
      setDeletingId("");
    }
  };

  return <div className="media-library-page">
    <section className="content-panel media-editor-panel">
       <div className="section-heading"><div><span className="section-kicker">НОВАЯ ЗАПИСЬ</span><h2>Добавить запись в медиатеку</h2><p className="section-heading-note">Тип Q&A попадёт только в блок «Q&A с куратором», тематический стрим — в центральный блок урока, а Talks останется в общей медиатеке.</p></div></div>
      <form className="media-editor-body" onSubmit={(event) => { const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; void createMedia(event, submitter?.dataset.publish === "true"); }}>
        <div className="media-editor-fields">
          <label className="form-field"><span>{isGlobalMedia ? "Привязка" : "Привязать к уроку"}</span><select value={isGlobalMedia ? "" : lessonId} onChange={(event) => { setLessonId(event.target.value); if (event.target.value) setScheduleEventId(""); }} disabled={isGlobalMedia || loading || lessons.length === 0}><option value="">{isGlobalMedia ? "Без привязки · общая медиатека" : "Выбери урок"}</option>{lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.label}</option>)}</select></label>
          <label className="form-field"><span>Привязать к событию (необязательно)</span><select value={scheduleEventId} onChange={(event) => { setScheduleEventId(event.target.value); if (event.target.value) setLessonId(""); }} disabled={isGlobalMedia || loading}><option value="">Без события</option>{course?.scheduleEvents.map((event) => <option key={event.id} value={event.id}>{event.date} · {event.title}</option>)}</select></label>
          <label className="form-field"><span>Тип</span><select value={kind} onChange={(event) => { const nextKind = event.target.value as CuratorMediaItem["kind"]; setKind(nextKind); if (nextKind !== "TALKS" && !lessonId) setLessonId(lessons[0]?.id ?? ""); }}><option value="STREAM">Стрим</option><option value="QA">Q&A</option><option value="BREAKDOWN">Разбор</option><option value="LESSON_VIDEO">Урок</option><option value="TALKS">Talks · общение</option></select></label>
          <label className="form-field"><span>Название</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Q&A по Market Logic · 05.06" /></label>
          <label className="form-field"><span>Ссылка Vimeo</span><input type="url" value={vimeoUrl} onChange={(event) => setVimeoUrl(event.target.value)} placeholder="https://vimeo.com/123456789" /></label>{normalizeVimeoUrl(vimeoUrl) && <div className="media-link-live-preview"><span>Предпросмотр новой записи</span><iframe src={normalizeVimeoUrl(vimeoUrl) ?? undefined} title="Предпросмотр Vimeo" allow="autoplay; fullscreen; picture-in-picture" /> </div>}
        </div>
         <div className="media-form-actions"><button className="secondary-button" type="submit" disabled={saving || (!isGlobalMedia && !lessonId && !scheduleEventId) || !title.trim() || !vimeoUrl.trim()}>Сохранить черновик</button><button className="primary-button" type="submit" data-publish="true" disabled={saving || (!isGlobalMedia && !lessonId && !scheduleEventId) || !title.trim() || !vimeoUrl.trim()}>{isGlobalMedia ? "Опубликовать в медиатеку" : scheduleEventId ? "Опубликовать к событию" : `Опубликовать в ${mediaDestinationLabel}`} <ChevronRight size={16} /></button>{notice && <span className="form-action-feedback"><Target size={16} /> {notice}</span>}</div>
      </form>
    </section>
    {(isGlobalMedia || lessonId || scheduleEventId) && <section className="content-panel media-existing-toggle">
      <button className="secondary-button" type="button" onClick={() => setShowExisting((current) => { const next = !current; if (!next) { setSelectedId(""); setReclassifying(false); } return next; })}>{showExisting ? "Скрыть существующие записи" : `Показать существующие записи (${existingInScope.length})`}</button>
      {showExisting && (existingInScope.length === 0
        ? <p className="media-link-note">Здесь пока пусто — это будет первая запись такого типа в этом блоке.</p>
        : <div className="module-media-playlist">{existingInScope.map((item, index) => <button className={`module-media-item ${item.id === selectedId ? "selected" : ""}`} type="button" key={item.id} onClick={() => setSelectedId(item.id)}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.title ?? "Без названия"}</strong><small>{mediaKindLabel(item.kind)} · {item.status === "PUBLISHED" ? "Опубликовано" : "Черновик"}</small></div><ChevronRight size={14} /></button>)}</div>)}
    </section>}
    {selected && <section className="content-panel media-preview-panel">
      <div className="section-heading"><div><span className="section-kicker">ЗАПИСЬ</span><h2>{selected.title ?? "Без названия"}</h2></div><span className="media-source-badge">{selected.status === "PUBLISHED" ? "Опубликовано" : "Черновик"}</span></div>{selected.embedUrl ? <div className="media-vimeo-stage"><iframe src={selected.embedUrl} title={selected.title ?? "Предпросмотр записи"} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div> : <div className="empty-state"><Play size={22} /><strong>Плеер недоступен</strong><span>Проверь ссылку Vimeo.</span></div>}<div className="media-preview-meta"><div><span className="section-kicker">{selected.kind === "TALKS" ? "ОБЩАЯ МЕДИАТЕКА" : "ПРИВЯЗКА"}</span><strong>{selected.eventTitle ? `Событие · ${selected.eventTitle}` : selected.moduleTitle}</strong><small>{selected.lessonTitle} · {mediaKindLabel(selected.kind)}</small></div><div className="media-preview-actions">{selected.kind !== "TALKS" && <button className="secondary-button" type="button" disabled={saving || deletingId !== "" || !lessonId || !selected.lessonId || selected.lessonId === lessonId} onClick={() => void attachSelected()}>{selected.lessonId === lessonId ? "Уже привязан" : "Привязать к выбранному уроку"}</button>}<button className="secondary-button" type="button" disabled={saving || deletingId !== ""} onClick={() => (reclassifying ? setReclassifying(false) : openReclassify())}>{reclassifying ? "Отменить изменение типа" : "Изменить тип"}</button>{selected.status === "PUBLISHED" && <button className="secondary-button" type="button" onClick={() => void loadViewers(selected.id)}><Eye size={15} /> {viewersFor === selected.id ? "Скрыть просмотры" : "Кто смотрел"}</button>}<button className="secondary-button danger-button" type="button" disabled={saving || deletingId === selected.id} onClick={() => void archiveSelected()}>{deletingId === selected.id ? "Удаляем…" : "Удалить запись"}</button><button className="primary-button" type="button" disabled={saving || deletingId !== "" || selected.status === "PUBLISHED"} onClick={() => void publishMedia()}>{selected.status === "PUBLISHED" ? "Опубликовано" : "Опубликовать"} <ChevronRight size={16} /></button></div>{reclassifying && <div className="media-viewers-panel media-reclassify-panel"><p className="media-link-note">Меняет тип и привязку этой же записи — новая копия не создаётся.</p><div className="media-editor-fields"><label className="form-field"><span>Тип</span><select value={reclassifyKind} onChange={(event) => { const nextKind = event.target.value as CuratorMediaItem["kind"]; setReclassifyKind(nextKind); if (nextKind !== "TALKS" && !reclassifyLessonId && !reclassifyScheduleEventId) setReclassifyLessonId(lessons[0]?.id ?? ""); }}><option value="STREAM">Стрим</option><option value="QA">Q&A</option><option value="BREAKDOWN">Разбор</option><option value="LESSON_VIDEO">Урок</option><option value="TALKS">Talks · общение</option></select></label>{reclassifyKind !== "TALKS" && <><label className="form-field"><span>Привязать к уроку</span><select value={reclassifyLessonId} onChange={(event) => { setReclassifyLessonId(event.target.value); if (event.target.value) setReclassifyScheduleEventId(""); }}><option value="">Выбери урок</option>{lessons.map((lesson) => <option key={lesson.id} value={lesson.id}>{lesson.label}</option>)}</select></label><label className="form-field"><span>Привязать к событию (необязательно)</span><select value={reclassifyScheduleEventId} onChange={(event) => { setReclassifyScheduleEventId(event.target.value); if (event.target.value) setReclassifyLessonId(""); }}><option value="">Без события</option>{course?.scheduleEvents.map((event) => <option key={event.id} value={event.id}>{event.date} · {event.title}</option>)}</select></label></>}</div><div className="media-form-actions"><button className="primary-button" type="button" disabled={saving || (reclassifyKind !== "TALKS" && !reclassifyLessonId && !reclassifyScheduleEventId)} onClick={() => void saveReclassify()}>Сохранить тип</button></div></div>}{viewersFor === selected.id && <div className="media-viewers-panel">{viewersLoading ? <span className="media-viewers-empty">Загружаем…</span> : viewers.length === 0 ? <span className="media-viewers-empty">Пока никто не открывал эту запись.</span> : viewers.map((event) => <div className="media-viewers-row" key={event.id}><strong>{event.viewer.name}</strong><span>{event.viewer.role === "STUDENT" ? "Ученик" : event.viewer.role === "CURATOR" ? "Куратор" : "Владелец"}</span><span>{event.ipAddress ?? "IP не определён"}</span><span>{new Date(event.createdAt).toLocaleString("ru-RU")}</span></div>)}</div>}</div>
    </section>}
  </div>;
}

function normalizeVimeoUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl.trim());
    if (!/(^|\.)vimeo\.com$/i.test(url.hostname)) return null;
    const videoId = url.pathname.split("/").find((part) => /^\d+$/.test(part));
    if (!videoId) return null;
    const privacyHash = url.searchParams.get("h");
    return `https://player.vimeo.com/video/${videoId}${privacyHash ? `?h=${encodeURIComponent(privacyHash)}` : ""}`;
  } catch {
    return null;
  }
}

function CuratorScheduleView({ onNavigate }: { onNavigate: (nextNav: CuratorNav) => void }) {
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selectedId, setSelectedId] = useState(events[0]?.id ?? "");
  const [showForm, setShowForm] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ScheduleEvent | null>(null);
  const [formDate, setFormDate] = useState(() => toDateKey(new Date()));
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [scheduleLoadError, setScheduleLoadError] = useState("");
  useEffect(() => {
    const load = async () => {
      const response = await fetch(`${API_ORIGIN}/api/schedule`, { credentials: "include", cache: "no-store" });
      if (!response.ok) { setScheduleLoadError("Не удалось загрузить расписание с сервера. Показаны локальные/демонстрационные данные."); return; }
      setScheduleLoadError("");
      const payload = await response.json() as { data?: ScheduleApiEvent[] };
      // A genuinely empty schedule is a real state, not a signal to (re-)seed demo
      // events — that one-time localStorage-era migration wasn't idempotent and
      // created duplicate rows (each ran twice under React StrictMode in dev, and
      // is equally racy across concurrent requests in production).
      if (Array.isArray(payload.data)) setEvents(payload.data.map(scheduleApiToUi));
    };
    void load().catch(() => setScheduleLoadError("Не удалось загрузить расписание с сервера. Показаны локальные/демонстрационные данные."));
  }, []);

  const selectedEvent = events.find((event) => event.id === selectedId) ?? events[0];
  const detailsEvent = events.find((event) => event.id === detailsId);
  const openCreateForDate = (date: string) => {
    const existing = events.find((event) => event.date === date);
    if (existing) { setSelectedId(existing.id); setDetailsId(existing.id); setPendingDate(null); return; }
    setFormDate(date); setEditingEvent(null); setShowForm(false); setPendingDate(date);
  };
  const confirmCreateForDate = () => { if (!pendingDate) return; setFormDate(pendingDate); setEditingEvent(null); setPendingDate(null); setShowForm(true); };
  const openEvent = (event: ScheduleEvent) => { setSelectedId(event.id); setDetailsId(event.id); setPendingDate(null); setShowForm(false); };
  const openEdit = (event: ScheduleEvent) => { setEditingEvent(event); setFormDate(event.date); setDetailsId(null); setPendingDate(null); setShowForm(true); };
  const removeEvent = () => { if (!selectedEvent || !window.confirm(`Удалить событие «${selectedEvent.title}»?`)) return; void fetch(`${API_ORIGIN}/api/schedule/${selectedEvent.id}`, { method: "DELETE", credentials: "include" }).catch(() => undefined); setEvents((current) => current.filter((event) => event.id !== selectedEvent.id)); setSelectedId(events.find((event) => event.id !== selectedEvent.id)?.id ?? ""); setDetailsId(null); };
  const saveEvent = async (event: ScheduleEvent) => {
    const body = { type: scheduleUiTypeToApi(event.type), title: event.title, date: event.date, time: event.time, description: event.description, live: event.live, coverPath: event.coverPath?.startsWith("data:") ? undefined : event.coverPath };
    const isPersisted = !event.id.startsWith("event-");
    const response = await fetch(`${API_ORIGIN}/api/schedule${isPersisted ? `/${event.id}` : ""}`, { method: isPersisted ? "PUT" : "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({})) as { data?: ScheduleApiEvent; message?: string };
    if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить событие");
    const saved = scheduleApiToUi(payload.data);
    setEvents((current) => isPersisted ? current.map((item) => item.id === event.id ? saved : item) : [...current, saved]);
    setSelectedId(saved.id); setShowForm(false); setEditingEvent(null); setDetailsId(null);
  };
  const releaseBooking = async (eventId: string) => {
    const response = await fetch(`${API_ORIGIN}/api/schedule/${eventId}/cancel-booking`, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => ({})) as { data?: ScheduleApiEvent; message?: string };
    if (!response.ok || !payload.data) return;
    const updated = scheduleApiToUi(payload.data);
    setEvents((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  return <div className="curator-schedule">{scheduleLoadError && <div className="file-error" role="alert">{scheduleLoadError}</div>}<div className="curator-schedule-toolbar"><div><span className="section-kicker">РАСПИСАНИЕ ПОТОКА</span><strong>{events.length} событий опубликовано</strong><span>События видят ученики этого потока после публикации.</span></div><div className="schedule-toolbar-actions"><button className="primary-button" onClick={() => { setEditingEvent(null); setPendingDate(null); setDetailsId(null); setFormDate(toDateKey(new Date())); setShowForm((current) => !current); }}><Plus size={16} /> {showForm ? "Закрыть форму" : "Создать событие"}</button><span className="schedule-toolbar-divider" aria-hidden="true" /><button className="secondary-button" disabled={!selectedEvent} onClick={() => selectedEvent && openEdit(selectedEvent)}><Pencil size={15} /> Редактировать</button><button className="secondary-button danger-button" disabled={!selectedEvent} onClick={removeEvent}><Trash2 size={15} /> Удалить</button></div></div>{pendingDate && <div className="schedule-date-confirm"><div><strong>Добавить событие на {formatEventDate(pendingDate)}?</strong><span>Дата уже выбрана. Подтверди действие, и откроется форма с деталями.</span></div><div><button className="secondary-button" type="button" onClick={() => setPendingDate(null)}>Нет</button><button className="primary-button" type="button" onClick={confirmCreateForDate}>Да, добавить</button></div></div>}{showForm && <ScheduleEventForm initialDate={formDate} initialEvent={editingEvent} onCancel={() => { setShowForm(false); setEditingEvent(null); }} onCreate={(event) => { void saveEvent(event).catch(() => undefined); }} />}<div className="calendar-layout"><section className="content-panel calendar-panel"><CalendarGrid events={events} selectedId={selectedEvent?.id ?? ""} onSelect={(eventId) => { const event = events.find((item) => item.id === eventId); if (event) openEvent(event); }} onDateSelect={openCreateForDate} /></section><section className="content-panel calendar-events"><div className="section-heading"><div><span className="section-kicker">ПЛАН ПОТОКА</span><h2>События и записи</h2></div><CalendarDays size={18} className="heading-icon" /></div>{events.length === 0 ? <div className="empty-state"><CalendarDays size={22} /><strong>Событий пока нет</strong><span>Кликни по дате в календаре или нажми «Создать событие».</span></div> : events.map((event) => <ScheduleEventCard event={event} selected={event.id === selectedEvent?.id} mode="curator" onOpen={() => openEvent(event)} key={event.id} />)}</section></div>{detailsEvent && <CuratorScheduleEventDetails event={detailsEvent} onEdit={() => openEdit(detailsEvent)} onDelete={removeEvent} onClose={() => setDetailsId(null)} onAddRecording={() => { window.sessionStorage.setItem("curator-target-event", detailsEvent.id); onNavigate("Медиатека"); }} onReleaseBooking={() => void releaseBooking(detailsEvent.id)} />}</div>;
}

function CuratorScheduleEventDetails({ event, onEdit, onDelete, onClose, onAddRecording, onReleaseBooking }: { event: ScheduleEvent; onEdit: () => void; onDelete: () => void; onClose: () => void; onAddRecording: () => void; onReleaseBooking: () => void }) {
  const coverPath = eventCoverPath(event);
  const isBacktest = event.type === "Бэктест";
  return <div className="event-details-overlay" role="presentation" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}><section className="event-details-modal rich-event-modal curator-event-details" role="dialog" aria-modal="true" aria-labelledby="curator-schedule-event-title"><div className="rich-event-topbar"><h2 id="curator-schedule-event-title">{event.title}</h2><button className="icon-button compact" aria-label="Закрыть детали события" onClick={onClose}><X size={20} /></button></div>{coverPath && <div className="rich-event-cover" role="img" aria-label={`Обложка события: ${event.title}`} style={{ backgroundImage: `url("${coverPath}")` }} />}<div className="rich-event-tabs"><span className="active">Сведения о событии</span><span>{event.type}</span></div><div className="rich-event-body"><div className="rich-event-date"><Clock3 size={17} /><strong>{event.weekday} · {event.time}</strong></div><h3>{event.title}</h3><div className="rich-event-line"><CalendarDays size={16} /><span>{formatEventDate(event.date)}</span></div><div className="rich-event-description">{event.description}</div>{isBacktest && <div className="event-recording-note"><Target size={16} /><div><strong>{event.bookedByStudentName ? `Записан: ${event.bookedByStudentName}` : "Слот пока свободен"}</strong><span>{event.bookedByStudentName ? "Индивидуальный слот занят этим учеником." : "Ученик сможет записаться на этот слот из своего расписания."}</span></div></div>}{event.recordingAvailable && <div className="event-recording-note"><Play size={16} /><div><strong>Запись уже добавлена</strong><span>Ученики увидят её в разделе «Стримы».</span></div></div>}</div><div className="rich-event-footer"><button className="secondary-button danger-button" onClick={onDelete}>Удалить</button><button className="secondary-button" onClick={onEdit}>Редактировать</button>{isBacktest && event.bookedByStudentName && <button className="secondary-button" onClick={onReleaseBooking}>Освободить слот</button>}{!event.recordingAvailable && <button className="secondary-button" onClick={onAddRecording}><Plus size={15} /> Добавить запись Vimeo</button>}<button className="primary-button" onClick={onClose}>Закрыть</button></div></section></div>;
}

function eventStartDate(event: ScheduleEvent): Date {
  const startTime = event.time.split(/\s*[—–-]\s*/)[0]?.trim() || "00:00";
  return new Date(`${event.date}T${startTime}:00`);
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return days > 0 ? `${days} дн ${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

type LiveInputDto = { uid: string; rtmpsUrl: string | null; rtmpsStreamKey: string | null; isLive: boolean; playbackIframeUrl: string | null };

const REACTION_OPTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;

type StreamChatReaction = { emoji: string; userIds: string[] };
type StreamChatMessage = { id: string; body: string; createdAt: string; authorId: string; authorName: string; authorRole: "STUDENT" | "CURATOR" | "OWNER"; attachment: { fileId: string; url: string } | null; replyTo: { id: string; authorName: string; authorRole: "STUDENT" | "CURATOR" | "OWNER"; body: string } | null; reactions: StreamChatReaction[] };
type ChatReactionEvent = { messageId: string; emoji: string; userId: string; added: boolean };

function applyReactionEvent(messages: StreamChatMessage[], event: ChatReactionEvent): StreamChatMessage[] {
  return messages.map((message) => {
    if (message.id !== event.messageId) return message;
    const reactions = message.reactions.filter((reaction) => reaction.emoji !== event.emoji);
    const existing = message.reactions.find((reaction) => reaction.emoji === event.emoji);
    const userIds = (existing?.userIds ?? []).filter((id) => id !== event.userId);
    if (event.added) userIds.push(event.userId);
    if (userIds.length > 0) reactions.push({ emoji: event.emoji, userIds });
    return { ...message, reactions };
  });
}

function useStreamChat() {
  const [messages, setMessages] = useState<StreamChatMessage[]>([]);
  const [connected, setConnected] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState("");
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/auth/session`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { data?: { userId?: string } } | null) => { if (payload?.data?.userId) setCurrentUserId(payload.data.userId); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const socket = io(`${SOCKET_ORIGIN}/streams`, { path: SOCKET_PATH, withCredentials: true });
    socketRef.current = socket;
    socket.on("connect", () => { setConnected(true); setChatError(null); });
    socket.on("disconnect", () => setConnected(false));
    socket.on("chat:history", (history: StreamChatMessage[]) => setMessages(history));
    socket.on("chat:message", (message: StreamChatMessage) => setMessages((current) => [...current, message]));
    socket.on("chat:reaction", (event: ChatReactionEvent) => setMessages((current) => applyReactionEvent(current, event)));
    socket.on("chat:error", (message: string) => setChatError(message));
    return () => { socket.disconnect(); socketRef.current = null; };
  }, []);

  const sendMessage = useCallback((body: string, fileId?: string, replyToId?: string) => {
    if (!body.trim() && !fileId) return;
    socketRef.current?.emit("chat:send", { body, fileId, replyToId });
  }, []);

  const react = useCallback((messageId: string, emoji: string) => {
    socketRef.current?.emit("chat:react", { messageId, emoji });
  }, []);

  return { messages, connected, chatError, currentUserId, sendMessage, react };
}

async function uploadChatImage(file: File): Promise<string> {
  const createResponse = await fetch(`${API_ORIGIN}/api/files`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalName: file.name || "screenshot.png", mimeType: file.type, byteSize: file.size, purpose: "CHAT" }),
  });
  const createPayload = await createResponse.json() as { data?: { id: string; uploadUrl: string }; message?: string };
  if (!createResponse.ok || !createPayload.data) throw new Error(createPayload.message ?? "Не удалось загрузить изображение");
  const uploadResponse = await fetch(`${API_ORIGIN}${createPayload.data.uploadUrl}`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!uploadResponse.ok) throw new Error("Не удалось загрузить изображение");
  return createPayload.data.id;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"]+)/g;

function linkifyText(text: string): ReactNode[] {
  // split() with a capturing group interleaves matches at odd indices — no need to re-test them.
  return text.split(URL_PATTERN).map((part, index) => (
    index % 2 === 1
      ? <a key={index} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
      : part
  ));
}

function ChatMessageRow({ message, currentUserId, onReply, onReact }: { message: StreamChatMessage; currentUserId: string; onReply: (message: StreamChatMessage) => void; onReact: (messageId: string, emoji: string) => void }) {
  const isStaff = message.authorRole === "CURATOR" || message.authorRole === "OWNER";
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => { if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) setPickerOpen(false); };
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, [pickerOpen]);

  const replyIsStaff = message.replyTo?.authorRole === "CURATOR" || message.replyTo?.authorRole === "OWNER";
  // A student answering another student's question — distinct from a curator's reply, so
  // whoever is scanning the chat can tell at a glance who actually helped.
  const isPeerAnswer = !isStaff && Boolean(message.replyTo) && message.replyTo?.authorRole === "STUDENT";

  return <div className={`live-room-chat-message ${isStaff ? "is-staff" : ""} ${isPeerAnswer ? "is-peer-answer" : ""}`}>
    <div className="live-room-chat-message-toolbar">
      <button type="button" className="icon-button compact" aria-label="Ответить на сообщение" onClick={() => onReply(message)}><CornerUpLeft size={13} /></button>
      <div className="live-room-reaction-picker-wrap" ref={pickerRef}>
        <button type="button" className="icon-button compact" aria-label="Добавить реакцию" onClick={() => setPickerOpen((current) => !current)}><SmilePlus size={13} /></button>
        {pickerOpen && <div className="live-room-reaction-picker">{REACTION_OPTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => { onReact(message.id, emoji); setPickerOpen(false); }}>{emoji}</button>)}</div>}
      </div>
    </div>
    <div><span className="live-room-chat-author"><strong className={isStaff ? "author-staff" : undefined}>{message.authorName}</strong>{isStaff && <em className="live-room-chat-staff-badge">Куратор</em>}{isPeerAnswer && <em className="live-room-chat-peer-badge">Ответ ученика</em>}</span><span>{new Date(message.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span></div>
    {message.replyTo && <div className="live-room-chat-reply-quote"><CornerUpLeft size={13} /><strong className={replyIsStaff ? "author-staff" : undefined}>{message.replyTo.authorName}</strong><span>{message.replyTo.body || "Вложение"}</span></div>}
    {message.body && <p>{linkifyText(message.body)}</p>}
    {message.attachment && <a className="live-room-chat-image-link" href={message.attachment.url} target="_blank" rel="noopener noreferrer"><img className="live-room-chat-image" src={message.attachment.url} alt="Скриншот" loading="lazy" /></a>}
    {message.reactions.length > 0 && <div className="live-room-chat-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} className={`live-room-chat-reaction ${reaction.userIds.includes(currentUserId) ? "active" : ""}`} onClick={() => onReact(message.id, reaction.emoji)}>{reaction.emoji} <span>{reaction.userIds.length}</span></button>)}</div>}
  </div>;
}

function ChatPanel({ isFullscreen }: { isFullscreen: boolean }) {
  const [chatDraft, setChatDraft] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<StreamChatMessage | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const { messages: chatMessages, connected: chatConnected, chatError, currentUserId, sendMessage, react } = useStreamChat();

  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
  }, [chatMessages]);

  const submitChatMessage = (event: FormEvent) => {
    event.preventDefault();
    if (!chatDraft.trim()) return;
    sendMessage(chatDraft, undefined, replyingTo?.id);
    setChatDraft("");
    setReplyingTo(null);
  };

  const handlePaste = async (event: ClipboardEvent<HTMLInputElement>) => {
    const item = Array.from(event.clipboardData.items).find((entry) => entry.type.startsWith("image/"));
    if (!item) return;
    event.preventDefault();
    const file = item.getAsFile();
    if (!file) return;
    setUploadingImage(true);
    setUploadError(null);
    try {
      const fileId = await uploadChatImage(file);
      sendMessage(chatDraft, fileId, replyingTo?.id);
      setChatDraft("");
      setReplyingTo(null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Не удалось загрузить изображение");
    } finally {
      setUploadingImage(false);
    }
  };

  return <aside className="content-panel live-room-chat">
    <div className="section-heading"><div><span className="section-kicker">ЧАТ</span><h2>Чат эфира</h2></div>{chatConnected ? <span className="live-room-chat-status online">На связи</span> : <span className="live-room-chat-status">Подключение…</span>}</div>
    <div className="live-room-chat-messages" ref={chatScrollRef}>
      {chatMessages.length === 0 ? (
        <div className="live-room-chat-placeholder">
          <MessageSquareText size={22} />
          <strong>Сообщений пока нет</strong>
          <span>Здесь будет обсуждение эфира в реальном времени{isFullscreen ? " — чат остаётся справа и на весь экран." : "."}</span>
        </div>
      ) : chatMessages.map((message) => <ChatMessageRow message={message} currentUserId={currentUserId} onReply={setReplyingTo} onReact={react} key={message.id} />)}
    </div>
    {(chatError || uploadError) && <span className="live-room-error live-room-chat-error">{uploadError ?? chatError}</span>}
    {replyingTo && <div className="live-room-chat-replying-bar"><CornerUpLeft size={13} /><span>Ответ для <strong>{replyingTo.authorName}</strong>: {replyingTo.body || "Вложение"}</span><button type="button" className="icon-button compact" aria-label="Отменить ответ" onClick={() => setReplyingTo(null)}><X size={13} /></button></div>}
    <form className="live-room-chat-form" onSubmit={submitChatMessage}>
      <input type="text" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onPaste={(event) => void handlePaste(event)} placeholder={uploadingImage ? "Загружаем скриншот…" : "Написать в чат…"} maxLength={2000} disabled={!chatConnected || uploadingImage} />
      <button type="submit" className="icon-button compact" aria-label="Отправить" disabled={!chatConnected || uploadingImage || !chatDraft.trim()}><ArrowRight size={15} /></button>
    </form>
  </aside>;
}

function CuratorStreamsView({ onNavigate }: { onNavigate: (nextNav: CuratorNav) => void }) {
  const [upcoming, setUpcoming] = useState<ScheduleEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const liveWrapRef = useRef<HTMLDivElement>(null);
  const [liveInput, setLiveInput] = useState<LiveInputDto | null>(null);
  const [liveInputLoading, setLiveInputLoading] = useState(true);
  const [settingUp, setSettingUp] = useState(false);
  const [liveInputError, setLiveInputError] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [copiedField, setCopiedField] = useState<"url" | "key" | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/schedule`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: ScheduleApiEvent[] };
      if (cancelled || !Array.isArray(payload.data)) return;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const events = payload.data.map(scheduleApiToUi)
        .filter((event) => new Date(`${event.date}T12:00:00`) >= today)
        .sort((a, b) => eventStartDate(a).getTime() - eventStartDate(b).getTime());
      setUpcoming(events);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const refreshLiveInput = useCallback(async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/live-input`, { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data?: LiveInputDto | null };
      setLiveInput(payload.data ?? null);
    } catch { /* keep last known state */ }
  }, []);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/streams/live-input`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: LiveInputDto | null };
      setLiveInput(payload.data ?? null);
      // An already-configured live input is re-applied (not just read) on every visit, so a
      // setting added after it was first created (e.g. Low-Latency HLS) reaches it too —
      // this never rotates the RTMP URL/key, so OBS keeps working unchanged.
      if (payload.data) {
        void fetch(`${API_ORIGIN}/api/streams/live-input`, { method: "POST", credentials: "include" })
          .then((refreshResponse) => (refreshResponse.ok ? refreshResponse.json() as Promise<{ data?: LiveInputDto }> : null))
          .then((refreshPayload) => { if (refreshPayload?.data) setLiveInput(refreshPayload.data); })
          .catch(() => undefined);
      }
    }).catch(() => undefined).finally(() => setLiveInputLoading(false));
  }, []);

  useEffect(() => {
    const poll = window.setInterval(() => { void refreshLiveInput(); }, 15_000);
    return () => window.clearInterval(poll);
  }, [refreshLiveInput]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void liveWrapRef.current?.requestFullscreen();
    }
  };

  const setupLiveInput = async () => {
    setSettingUp(true);
    setLiveInputError(null);
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/live-input`, { method: "POST", credentials: "include" });
      const payload = await response.json() as { data?: LiveInputDto; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось настроить трансляцию");
      setLiveInput(payload.data);
    } catch (error) {
      setLiveInputError(error instanceof Error ? error.message : "API недоступен. Проверь сервер.");
    } finally {
      setSettingUp(false);
    }
  };

  const copyValue = async (value: string, field: "url" | "key") => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const helper = document.createElement("textarea");
        helper.value = value;
        helper.setAttribute("readonly", "true");
        helper.style.position = "fixed";
        helper.style.opacity = "0";
        document.body.appendChild(helper);
        helper.select();
        document.execCommand("copy");
        document.body.removeChild(helper);
      }
      setCopiedField(field);
      window.setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 1800);
    } catch { /* clipboard unavailable */ }
  };

  const nextEvent = upcoming[0];
  const msToNextEvent = nextEvent ? eventStartDate(nextEvent).getTime() - now : null;

  return <div className="live-room">
    <div className="curator-schedule-toolbar">
      <div><span className="section-kicker">ЭФИР ПОТОКА</span><strong>Прямой эфир</strong><span>Здесь куратор будет запускать трансляцию и вести чат с учениками.</span></div>
      <div className="schedule-toolbar-actions">
        <button className="secondary-button" onClick={() => { window.sessionStorage.setItem("curator-target-kind", "STREAM"); onNavigate("Медиатека"); }}><Plus size={16} /> Загрузить запись в Медиатеку</button>
      </div>
    </div>

    <div className="live-room-live" ref={liveWrapRef}>
      <section className="content-panel live-room-player">
        <div className="section-heading">
          <div><span className="section-kicker">ЭФИР</span><h2>Окно трансляции</h2></div>
          <div className="live-room-player-actions">
            {liveInput?.isLive ? <span className="live-room-live-badge"><span className="live-dot" /> В эфире</span> : liveInput ? <span className="live-room-soon-badge">Офлайн</span> : null}
            <button className="icon-button compact" type="button" aria-label={isFullscreen ? "Свернуть" : "На весь экран"} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          </div>
        </div>
        {liveInput?.isLive && liveInput.playbackIframeUrl ? (
          <div className="live-room-player-frame">
            <iframe src={liveInput.playbackIframeUrl} allow="autoplay; fullscreen; encrypted-media" allowFullScreen title="Прямой эфир" />
          </div>
        ) : (
          <div className="live-room-player-placeholder">
            <Radio size={26} />
            {liveInputLoading ? <strong>Проверяем настройки трансляции…</strong> : liveInput ? <>
              <strong>Ждём подключения из OBS</strong>
              <div className="live-room-rtmp-box">
                <div className="live-room-rtmp-row">
                  <span>Server URL</span>
                  <code>{liveInput.rtmpsUrl}</code>
                  <button type="button" className="icon-button compact" aria-label="Скопировать URL" onClick={() => liveInput.rtmpsUrl && void copyValue(liveInput.rtmpsUrl, "url")}>{copiedField === "url" ? <CheckCircle2 size={14} /> : <Copy size={14} />}</button>
                </div>
                <div className="live-room-rtmp-row">
                  <span>Stream Key</span>
                  <code>{keyVisible ? liveInput.rtmpsStreamKey : "••••••••••••••••••••"}</code>
                  <button type="button" className="icon-button compact" aria-label={keyVisible ? "Скрыть ключ" : "Показать ключ"} onClick={() => setKeyVisible((current) => !current)}>{keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  <button type="button" className="icon-button compact" aria-label="Скопировать ключ" onClick={() => liveInput.rtmpsStreamKey && void copyValue(liveInput.rtmpsStreamKey, "key")}>{copiedField === "key" ? <CheckCircle2 size={14} /> : <Copy size={14} />}</button>
                </div>
              </div>
              {msToNextEvent !== null && msToNextEvent > 0 && <span className="live-room-countdown-inline">До эфира «{nextEvent.title}»: <strong>{formatCountdown(msToNextEvent)}</strong></span>}
              <span>Вставь эти данные в OBS (Settings → Stream → Custom) один раз и жми Start Streaming — видео появится здесь автоматически, статус обновляется каждые ~15 секунд.</span>
            </> : <>
              <strong>Трансляция ещё не настроена</strong>
              <span>Создадим постоянный RTMP-адрес для потока — вставишь его в OBS один раз, дальше он не меняется.</span>
              {liveInputError && <span className="live-room-error">{liveInputError}</span>}
              <button className="primary-button" type="button" onClick={() => void setupLiveInput()} disabled={settingUp}><Radio size={15} /> {settingUp ? "Настраиваем…" : "Настроить трансляцию"}</button>
            </>}
          </div>
        )}
      </section>

      <ChatPanel isFullscreen={isFullscreen} />
    </div>

    <section className="content-panel live-room-upcoming">
      <div className="section-heading"><div><span className="section-kicker">РАСПИСАНИЕ</span><h2>Ближайшие эфиры</h2></div><CalendarDays size={18} className="heading-icon" /></div>
      {upcoming.length > 0 ? <div className="live-room-upcoming-list">{upcoming.map((event) => <button className="live-room-upcoming-row" type="button" key={event.id} onClick={() => onNavigate("Расписание")}><div><strong>{event.title}</strong><span>{event.weekday}, {formatEventDate(event.date)} · {event.time}</span></div><ChevronRight size={16} /></button>)}</div> : <div className="empty-state compact"><CalendarDays size={20} /><strong>Эфиров пока не запланировано</strong><span>Добавь событие в «Расписании», чтобы оно появилось здесь.</span></div>}
    </section>
  </div>;
}

const scheduleCoverOptions = [
  { label: "Backtest", path: "/event-covers/BACKTEST.png" },
  { label: "Morning", path: "/event-covers/MORNING.png" },
  { label: "Q&A", path: "/event-covers/QA.png" },
  { label: "Pre-session", path: "/event-covers/pre-session-cover.jpg" },
] as const;

function ScheduleEventForm({ initialDate = toDateKey(new Date()), initialEvent, onCreate, onCancel }: { initialDate?: string; initialEvent?: ScheduleEvent | null; onCreate: (event: ScheduleEvent) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(initialEvent?.title ?? "");
  const [type, setType] = useState<ScheduleEvent["type"]>(initialEvent?.type ?? "Практическая часть");
  const [date, setDate] = useState(initialEvent?.date ?? initialDate);
  const [time, setTime] = useState(initialEvent?.time ?? "19:00 — 20:30");
  const [description, setDescription] = useState(initialEvent?.description ?? "");
  const [coverPath, setCoverPath] = useState<string>(initialEvent?.coverPath ?? scheduleCoverOptions[0].path);
  const [coverFileName, setCoverFileName] = useState("");
  const [coverError, setCoverError] = useState("");
  const canCreate = title.trim().length > 2 && description.trim().length > 3 && date.length > 0 && time.trim().length > 0;
  useEffect(() => { if (!initialEvent) { const timer = window.setTimeout(() => setDate(initialDate), 0); return () => window.clearTimeout(timer); } }, [initialDate, initialEvent]);
  const handleCoverFile = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setCoverError("Выберите файл изображения."); return; }
    if (file.size > 5 * 1024 * 1024) { setCoverError("Размер обложки не должен превышать 5 МБ."); return; }
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") { setCoverPath(reader.result); setCoverFileName(file.name); setCoverError(""); } };
    reader.readAsDataURL(file);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    const parsedDate = new Date(`${date}T12:00:00`);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(parsedDate);
    onCreate({ id: initialEvent?.id ?? `event-${Date.now()}`, date, day: date.slice(-2), month: parsedDate.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase(), weekday, type, title: title.trim(), time: time.trim(), live: type === "Практическая часть", description: description.trim(), recordingAvailable: initialEvent?.recordingAvailable ?? false, coverPath: coverPath.trim() || undefined });
  };

  return <form className="content-panel schedule-form" onSubmit={submit}><div className="section-heading"><div><span className="section-kicker">НОВОЕ СОБЫТИЕ</span><h2>Добавить встречу в поток</h2></div><button type="button" className="icon-button compact" aria-label="Закрыть форму" onClick={onCancel}><X size={16} /></button></div><div className="form-body"><div className="form-grid"><label className="form-field form-field-wide"><span>Название</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Разбор рынка в прямом эфире" /></label><label className="form-field"><span>Тип события</span><select value={type} onChange={(event) => setType(event.target.value as ScheduleEvent["type"])}><option>Практическая часть</option><option>Q&A</option><option>Разбор ДЗ</option><option>Бэктест</option></select>{type === "Бэктест" && <small className="form-field-hint">Индивидуальный слот: свободен для записи, пока его не займёт один ученик — лимит 1 звонок на весь практикум.</small>}</label><label className="form-field"><span>Дата</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="form-field"><span>Время</span><input value={time} onChange={(event) => setTime(event.target.value)} placeholder="19:00 — 20:30" /></label><label className="form-field form-field-wide"><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Что будет происходить на встрече и что подготовить ученикам?" /></label></div><div className="schedule-cover-picker"><div><span className="form-section-label">Обложка события</span><p>Выберите готовую обложку или загрузите свою.</p></div><div className="schedule-cover-grid">{scheduleCoverOptions.map((option) => <button type="button" className={`schedule-cover-option ${coverPath === option.path ? "selected" : ""}`} key={option.path} onClick={() => { setCoverPath(option.path); setCoverFileName(""); }}><span style={{ backgroundImage: `url("${option.path}")` }} /><strong>{option.label}</strong></button>)}</div><label className="schedule-cover-upload"><Plus size={16} /><span>{coverFileName || "Выбрать изображение с компьютера"}</span><small>PNG, JPG, WEBP · до 5 МБ</small><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleCoverFile(event.target.files?.[0])} /></label>{coverError && <div className="file-error" role="alert">{coverError}</div>}</div><div className="create-actions"><button type="button" className="secondary-button" onClick={onCancel}>Отмена</button><button type="submit" className="primary-button" disabled={!canCreate}>Опубликовать событие <ChevronRight size={16} /></button></div></div></form>;
}

type SubmissionFormat = "comment" | "image" | "video";

const assignmentPublishedEvent = "fix-assignment-published";
const assignmentSubmittedEvent = "fix-assignment-submitted";

const emptyStudentAssignment: Assignment = {
  id: "",
  title: "",
  module: "",
  status: "Не начато",
  tone: "gray",
  date: "",
  deadline: "",
  description: "",
  requirements: [],
};

const emptyReviewQueueItem: ReviewQueueItem = {
  id: "",
  studentName: "",
  studentInitials: "",
  assignmentTitle: "",
  module: "",
  status: "На проверке",
  tone: "blue",
  submittedAt: "",
  attempt: "",
  studentNote: "",
  answer: "",
  attachments: [],
  attachmentFiles: [],
  progress: "",
};

function isAssignment(value: unknown): value is Assignment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Assignment>;
  return typeof candidate.id === "string" && typeof candidate.title === "string" && typeof candidate.description === "string" && Array.isArray(candidate.requirements) && typeof candidate.module === "string";
}

function isReviewQueueItem(value: unknown): value is ReviewQueueItem {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReviewQueueItem>;
  return typeof candidate.id === "string" && typeof candidate.studentName === "string" && typeof candidate.assignmentTitle === "string" && typeof candidate.answer === "string" && Array.isArray(candidate.attachments);
}

function CreateAssignmentView({ onNavigate }: { onNavigate: (nextNav: CuratorNav) => void }) {
  const [published, setPublished] = useState<Assignment | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    const handlePublished = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isAssignment(event.detail)) return;
      setPublished(event.detail);
    };
    window.addEventListener(assignmentPublishedEvent, handlePublished);
    return () => window.removeEventListener(assignmentPublishedEvent, handlePublished);
  }, []);

  if (published) return <section className="assignment-publish-success content-panel">
    <div className="assignment-publish-success-icon"><ShieldCheck size={24} /></div>
    <span className="section-kicker">Статус задания</span>
    <h2>Задание опубликовано</h2>
    <p><strong>{published.title}</strong> доступно ученикам в разделе «Задания» и связанном модуле.</p>
    <div className="assignment-publish-success-actions">
      <button className="primary-button" onClick={() => { setPublished(null); setFormKey((value) => value + 1); }}><Plus size={16} /> Создать ещё одно</button>
      <button className="secondary-button" onClick={() => onNavigate("Очередь проверки")}><ArrowUpRight size={16} /> Открыть очередь проверки</button>
    </div>
  </section>;

  return <CreateAssignmentForm key={formKey} />;
}

async function uploadPrivateFile(file: File, purpose?: "MODULE_COVER"): Promise<string> {
  const createResponse = await fetch(`${API_ORIGIN}/api/files`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ originalName: file.name, mimeType: file.type, byteSize: file.size, purpose }),
  });
  const createPayload = await createResponse.json() as { message?: string; data?: { id: string; uploadUrl: string } };
  if (!createResponse.ok || !createPayload.data) throw new Error(createPayload.message ?? "Не удалось подготовить файл.");
  const uploadUrl = createPayload.data.uploadUrl.startsWith("http") ? createPayload.data.uploadUrl : `${API_ORIGIN}${createPayload.data.uploadUrl}`;
  const uploadResponse = await fetch(uploadUrl, { method: "PUT", credentials: "include", headers: { "Content-Type": file.type }, body: file });
  if (!uploadResponse.ok) {
    const payload = await uploadResponse.json().catch(() => ({})) as { message?: string };
    throw new Error(payload.message ?? "Не удалось загрузить файл.");
  }
  return createPayload.data.id;
}

type ManagedAssignment = Assignment & { publicationStatus: string };

// Kept for the future assignment-management section; creation flow intentionally stays focused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CuratorAssignmentManager() {
  const [items, setItems] = useState<ManagedAssignment[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  const loadAssignments = useCallback(async () => {
    const response = await fetch(`${API_ORIGIN}/api/assignments/manage`, { credentials: "include", cache: "no-store" });
    const payload = await response.json() as { data?: ManagedAssignment[]; message?: string };
    if (!response.ok) throw new Error(response.status === 403 ? "Управление доступно только куратору." : payload.message ?? "Не удалось загрузить задания.");
    const nextItems = payload.data ?? [];
    setItems(nextItems);
    const nextSelected = nextItems.find((item) => item.id === selectedId) ?? nextItems[0] ?? null;
    setSelectedId(nextSelected?.id ?? "");
    setTitle(nextSelected?.title ?? "");
    setDescription(nextSelected?.description ?? "");
  }, [selectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAssignments().catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Не удалось загрузить задания."));
    }, 0);
    const refreshAfterPublish = () => {
      void loadAssignments().catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Не удалось обновить список заданий."));
    };
    window.addEventListener(assignmentPublishedEvent, refreshAfterPublish);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(assignmentPublishedEvent, refreshAfterPublish);
    };
  }, [loadAssignments]);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !title.trim() || !description.trim()) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/assignments/${selected.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });
      const payload = await response.json() as { data?: Assignment; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить изменения.");
      setItems((current) => current.map((item) => item.id === selected.id ? { ...item, title: payload.data?.title ?? item.title, description: payload.data?.description ?? item.description } : item));
      setNotice("Изменения сохранены в базе.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить изменения.");
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!selected || !window.confirm("Архивировать это задание? Отправленные работы сохранятся.")) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/assignments/${selected.id}`, { method: "DELETE", credentials: "include" });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось архивировать задание.");
      setItems((current) => {
        const nextItems = current.filter((item) => item.id !== selected.id);
        const nextSelected = nextItems[0] ?? null;
        setSelectedId(nextSelected?.id ?? "");
        setTitle(nextSelected?.title ?? "");
        setDescription(nextSelected?.description ?? "");
        return nextItems;
      });
      setNotice("Задание архивировано. История отправок сохранена.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось архивировать задание.");
    } finally {
      setSaving(false);
    }
  };

  return <section className="content-panel assignment-admin-panel"><div className="section-heading"><div><span className="section-kicker">УПРАВЛЕНИЕ КОНТЕНТОМ</span><h2>Созданные задания</h2><p className="section-heading-note">Изменения применяются к данным в PostgreSQL. Архивирование не удаляет отправленные работы.</p></div><span className="progress-inline">{items.length} заданий</span></div><div className="assignment-admin-layout"><div className="assignment-admin-list">{items.length > 0 ? items.map((item) => <button className={`assignment-admin-item ${item.id === selected?.id ? "selected" : ""}`} key={item.id} onClick={() => { setSelectedId(item.id); setTitle(item.title); setDescription(item.description); setNotice(""); }}><span className="assignment-admin-number">{item.module}</span><strong>{item.title}</strong><small>{item.publicationStatus === "PUBLISHED" ? "Опубликовано" : item.publicationStatus}</small></button>) : <div className="empty-state"><FileCheck2 size={22} /><strong>Заданий пока нет</strong><span>Опубликованные задания появятся здесь после создания.</span></div>}</div>{selected && <form className="assignment-admin-editor" onSubmit={save}><label className="form-field"><span>Название</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="form-field"><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={6} /></label><div className="create-actions"><button type="button" className="secondary-button" onClick={() => void archive()} disabled={saving}>Архивировать</button><button type="submit" className="primary-button" disabled={saving || !title.trim() || !description.trim()}>Сохранить изменения <ChevronRight size={16} /></button></div>{notice && <div className="form-action-feedback"><Target size={16} /> {notice}</div>}</form>}</div></section>;
}

type AssignmentMaterialDraft = {
  title: string;
  url: string;
  file: File | null;
};

function useObjectUrl(file: File | null): string {
  const url = useMemo(() => file ? URL.createObjectURL(file) : "", [file]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

// Kept as a compatibility reference while the canonical creator is used by both entry points.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function LegacyCreateAssignmentForm({ materialDraft }: { materialDraft: AssignmentMaterialDraft }) {
  const [title, setTitle] = useState("");
  const [moduleId, setModuleId] = useState("zones");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState("2026-07-21");
  const [attempts, setAttempts] = useState("2");
  const [requirements, setRequirements] = useState(["", ""]);
  const [formats, setFormats] = useState<SubmissionFormat[]>(["comment", "image"]);
  const [published, setPublished] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");
  const selectedModule = studentDashboard.modules.find((module) => module.id === moduleId) ?? studentDashboard.modules[0];
  const canPublish = title.trim().length > 3 && description.trim().length > 0 && requirements.some((requirement) => requirement.trim().length > 0) && formats.length > 0;

  const updateRequirement = (index: number, value: string) => {
    setRequirements((current) => current.map((requirement, requirementIndex) => requirementIndex === index ? value : requirement));
    setPublished(false);
  };

  const toggleFormat = (format: SubmissionFormat) => {
    setFormats((current) => current.includes(format) ? current.filter((item) => item !== format) : [...current, format]);
    setPublished(false);
  };

  const publish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canPublish || published || publishing) return;
    setPublishError("");
    setPublishing(true);
    let uploadedFileId: string | undefined;
    try {
      if (materialDraft.file) uploadedFileId = await uploadPrivateFile(materialDraft.file);
      const materials = uploadedFileId
        ? [{ kind: "FILE" as const, title: materialDraft.title.trim() || materialDraft.file?.name || "Материал к заданию", fileId: uploadedFileId }]
        : materialDraft.url.trim()
          ? [{ kind: "LINK" as const, title: materialDraft.title.trim() || "Материал к заданию", url: materialDraft.url.trim() }]
          : [];
      const response = await fetch(`${API_ORIGIN}/api/assignments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          moduleNumber: selectedModule.number,
          moduleTitle: selectedModule.title,
          deadline: deadline || undefined,
          requirements: requirements.map((requirement) => requirement.trim()).filter(Boolean),
          allowedFormats: formats,
          maxAttempts: Number(attempts),
          materials,
        }),
      });
      const payload = await response.json() as { data?: Assignment; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось опубликовать задание.");
      setPublished(true);
      window.dispatchEvent(new CustomEvent<Assignment & { materialsHandled: true }>(assignmentPublishedEvent, { detail: { ...payload.data, materialsHandled: true } }));
    } catch (error) {
      if (uploadedFileId) void fetch(`${API_ORIGIN}/api/files/${uploadedFileId}`, { method: "DELETE", credentials: "include" });
      setPublishError(error instanceof Error ? error.message : "Не удалось опубликовать задание.");
    } finally {
      setPublishing(false);
    }
  };

  return <form className="create-assignment-layout" onSubmit={publish}><section className="content-panel create-assignment-form"><div className="section-heading"><div><span className="section-kicker">НОВЫЙ МАТЕРИАЛ</span><h2>Параметры задания</h2></div><span className="draft-status">{published ? "Опубликовано" : "Черновик"}</span></div><div className="form-body"><label className="form-field form-field-wide"><span>Название задания</span><input value={title} onChange={(event) => { setTitle(event.target.value); setPublished(false); }} placeholder="Например, Разметка зон на истории" /></label><div className="form-grid"><label className="form-field"><span>Модуль</span><select value={moduleId} onChange={(event) => { setModuleId(event.target.value); setPublished(false); }}>{studentDashboard.modules.map((module) => <option value={module.id} key={module.id}>{module.number} · {module.title}</option>)}</select></label><label className="form-field"><span>Поток</span><select defaultValue="practicum-04"><option value="practicum-04">Практикум 04 · 18 учеников</option></select></label></div><label className="form-field form-field-wide"><span>Описание и контекст</span><textarea value={description} onChange={(event) => { setDescription(event.target.value); setPublished(false); }} placeholder="Объясни, что ученик должен сделать и зачем это нужно в системе..." rows={5} /></label><div className="form-section"><div className="form-section-heading"><div><span>Критерии выполнения</span><small>По ним куратор будет проверять работу.</small></div><button type="button" className="quiet-button" aria-label="Добавить критерий" onClick={() => setRequirements((current) => [...current, ""])}><Plus size={16} /></button></div><div className="requirement-editor">{requirements.map((requirement, index) => <div className="requirement-input" key={index}><span>{String(index + 1).padStart(2, "0")}</span><input value={requirement} onChange={(event) => updateRequirement(index, event.target.value)} placeholder="Добавить критерий проверки" />{requirements.length > 1 && <button type="button" className="icon-button compact" aria-label={`Удалить критерий ${index + 1}`} onClick={() => setRequirements((current) => current.filter((_, requirementIndex) => requirementIndex !== index))}><X size={14} /></button>}</div>)}</div></div><div className="form-grid"><label className="form-field"><span>Срок сдачи</span><input type="date" value={deadline} onChange={(event) => { setDeadline(event.target.value); setPublished(false); }} /></label><label className="form-field"><span>Попытки</span><input type="number" min="1" max="5" value={attempts} onChange={(event) => { setAttempts(event.target.value); setPublished(false); }} /></label></div><div className="form-section"><div className="form-section-heading"><div><span>Формат ответа</span><small>Что ученик сможет приложить к работе.</small></div></div><div className="format-options"><label className={`format-option ${formats.includes("comment") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("comment")} onChange={() => toggleFormat("comment")} /><MessageSquareText size={16} /><span>Комментарий</span></label><label className={`format-option ${formats.includes("image") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("image")} onChange={() => toggleFormat("image")} /><FileCheck2 size={16} /><span>Изображение</span></label><label className={`format-option ${formats.includes("video") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("video")} onChange={() => toggleFormat("video")} /><Play size={16} /><span>Видео</span></label></div></div><div className="create-actions"><button type="button" className="secondary-button" onClick={() => { setTitle(""); setDescription(""); setRequirements(["", ""]); setFormats(["comment", "image"]); setPublished(false); setPublishError(""); }}>Очистить</button><button type="submit" className="primary-button" disabled={!canPublish || published}>{published ? "Задание опубликовано" : "Опубликовать задание"} <ChevronRight size={16} /></button></div>{publishError && <div className="file-error" role="alert">{publishError}</div>}{published && <div className="detail-feedback curator-decision"><Target size={17} /><div><strong>Задание опубликовано в потоке</strong><p>Ученики увидят его в разделе «Задания» и внутри связанного модуля.</p></div></div>}</div></section><aside className="content-panel assignment-preview"><div className="section-heading"><div><span className="section-kicker">ПРЕДПРОСМОТР</span><h2>Так увидит ученик</h2></div><EyeIcon /></div><div className="preview-body"><div className="preview-module">{selectedModule.number} · {selectedModule.title}</div><h3>{title || "Название нового задания"}</h3><p>{description || "Здесь появится описание задания и контекст, который увидит ученик перед началом работы."}</p><div className="preview-meta"><span><Clock3 size={14} /> {deadline || "Срок не выбран"}</span><span><FileCheck2 size={14} /> До {attempts || "0"} попыток</span></div><div className="preview-requirements"><span className="detail-label">ЧТО НУЖНО СДЕЛАТЬ</span>{requirements.filter((requirement) => requirement.trim()).length > 0 ? requirements.filter((requirement) => requirement.trim()).map((requirement) => <div key={requirement}><span />{requirement}</div>) : <div className="preview-empty">Критерии появятся после заполнения формы.</div>}</div></div></aside></form>;
}

function AssignmentCreatorForm({ materialDraft }: { materialDraft: AssignmentMaterialDraft }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState("2026-07-21");
  const [requirements, setRequirements] = useState(["", ""]);
  const [formats, setFormats] = useState<SubmissionFormat[]>(["comment", "image"]);
  const [courseModules, setCourseModules] = useState<CourseApiModule[]>([]);
  const [moduleId, setModuleId] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [courseLoading, setCourseLoading] = useState(true);
  const [courseError, setCourseError] = useState("");
  const [published, setPublished] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState("");

  useEffect(() => {
    let active = true;
    const loadCourse = async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/course/manage`, { credentials: "include", cache: "no-store" });
        const payload = await response.json() as CourseApiPayload;
        if (!response.ok) throw new Error(response.status === 403 ? "Управление программой доступно только куратору." : "Не удалось загрузить программу.");
        const modules = payload.data?.modules ?? [];
        if (modules.length === 0) throw new Error("В программе пока нет модулей и уроков.");

        const targetModuleId = window.sessionStorage.getItem(ASSIGNMENT_TARGET_MODULE_KEY);
        const targetLessonId = window.sessionStorage.getItem(ASSIGNMENT_TARGET_LESSON_KEY);
        const targetModule = modules.find((module) => module.id === targetModuleId)
          ?? modules.find((module) => module.lessons.some((lesson) => lesson.id === targetLessonId))
          ?? modules[0];
        const targetLesson = targetModule.lessons.find((lesson) => lesson.id === targetLessonId) ?? targetModule.lessons[0];

        if (!active) return;
        setCourseModules(modules);
        setModuleId(targetModule.id);
        setLessonId(targetLesson?.id ?? "");
      } catch (reason) {
        if (active) setCourseError(reason instanceof Error ? reason.message : "Не удалось загрузить программу.");
      } finally {
        if (active) setCourseLoading(false);
      }
    };
    void loadCourse();
    return () => { active = false; };
  }, []);

  const selectedModule = courseModules.find((module) => module.id === moduleId);
  const selectedLesson = selectedModule?.lessons.find((lesson) => lesson.id === lessonId);
  const canPublish = !courseLoading
    && Boolean(selectedModule && selectedLesson)
    && title.trim().length > 3
    && description.trim().length > 0
    && requirements.some((requirement) => requirement.trim().length > 0)
    && formats.length > 0;

  const updateRequirement = (index: number, value: string) => {
    setRequirements((current) => current.map((requirement, requirementIndex) => requirementIndex === index ? value : requirement));
    setPublished(false);
  };

  const toggleFormat = (format: SubmissionFormat) => {
    setFormats((current) => current.includes(format) ? current.filter((item) => item !== format) : [...current, format]);
    setPublished(false);
  };

  const publish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canPublish || !selectedModule || !selectedLesson || published || publishing) return;
    setPublishError("");
    setPublishing(true);
    let uploadedFileId: string | undefined;
    try {
      if (materialDraft.file) uploadedFileId = await uploadPrivateFile(materialDraft.file);
      const materials = uploadedFileId
        ? [{ kind: "FILE" as const, title: materialDraft.title.trim() || materialDraft.file?.name || "Материал к заданию", fileId: uploadedFileId }]
        : materialDraft.url.trim()
          ? [{ kind: "LINK" as const, title: materialDraft.title.trim() || "Материал к заданию", url: materialDraft.url.trim() }]
          : [];
      const response = await fetch(`${API_ORIGIN}/api/assignments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: selectedLesson.id,
          title: title.trim(),
          description: description.trim(),
          moduleNumber: selectedModule.number,
          moduleTitle: selectedModule.title,
          deadline: deadline || undefined,
          requirements: requirements.map((requirement) => requirement.trim()).filter(Boolean),
          allowedFormats: formats,
          materials,
        }),
      });
      const payload = await response.json() as { data?: Assignment; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось опубликовать задание.");
      setPublished(true);
      window.sessionStorage.removeItem(ASSIGNMENT_TARGET_MODULE_KEY);
      window.sessionStorage.removeItem(ASSIGNMENT_TARGET_LESSON_KEY);
      window.dispatchEvent(new CustomEvent<Assignment & { materialsHandled: true }>(assignmentPublishedEvent, { detail: { ...payload.data, materialsHandled: true } }));
    } catch (error) {
      if (uploadedFileId) void fetch(`${API_ORIGIN}/api/files/${uploadedFileId}`, { method: "DELETE", credentials: "include" });
      setPublishError(error instanceof Error ? error.message : "Не удалось опубликовать задание.");
    } finally {
      setPublishing(false);
    }
  };

  const clearForm = () => {
    setTitle("");
    setDescription("");
    setRequirements(["", ""]);
    setFormats(["comment", "image"]);
    setPublished(false);
    setPublishError("");
  };

  return <form className="create-assignment-layout" onSubmit={publish}>
    <section className="content-panel create-assignment-form">
      <div className="section-heading">
        <div><span className="section-kicker">НОВЫЙ МАТЕРИАЛ</span><h2>Параметры задания</h2></div>
        <span className="draft-status">{published ? "Опубликовано" : "Черновик"}</span>
      </div>
      <div className="form-body">
        {courseLoading && <div className="module-action-feedback">Загружаем актуальные модули и уроки программы…</div>}
        {courseError && <div className="file-error" role="alert">{courseError}</div>}
        <label className="form-field form-field-wide"><span>Название задания</span><input value={title} onChange={(event) => { setTitle(event.target.value); setPublished(false); }} placeholder="Например, Разметка зон на истории" /></label>
        <div className="form-grid">
          <label className="form-field"><span>Модуль</span><select value={moduleId} disabled={courseLoading || courseModules.length === 0} onChange={(event) => { const nextModule = courseModules.find((module) => module.id === event.target.value); setModuleId(event.target.value); setLessonId(nextModule?.lessons[0]?.id ?? ""); setPublished(false); }}>{courseModules.map((module) => <option value={module.id} key={module.id}>{module.number} · {module.title}</option>)}</select></label>
          <label className="form-field"><span>Урок</span><select value={lessonId} disabled={courseLoading || !selectedModule} onChange={(event) => { setLessonId(event.target.value); setPublished(false); }}>{selectedModule?.lessons.map((lesson) => <option value={lesson.id} key={lesson.id}>{String(lesson.position + 1).padStart(2, "0")} · {lesson.title}</option>)}</select></label>
        </div>
        {selectedModule && selectedLesson && <div className="module-action-feedback">Задание будет опубликовано именно в уроке «{selectedLesson.title}» модуля «{selectedModule.title}».</div>}
        <label className="form-field form-field-wide"><span>Описание и контекст</span><textarea value={description} onChange={(event) => { setDescription(event.target.value); setPublished(false); }} placeholder="Объясни, что ученик должен сделать и зачем это нужно в системе…" rows={5} /></label>
        <div className="form-section">
          <div className="form-section-heading"><div><span>Критерии выполнения</span><small>По ним куратор будет проверять работу.</small></div><button type="button" className="quiet-button" aria-label="Добавить критерий" onClick={() => setRequirements((current) => [...current, ""])}><Plus size={16} /></button></div>
          <div className="requirement-editor">{requirements.map((requirement, index) => <div className="requirement-input" key={index}><span>{String(index + 1).padStart(2, "0")}</span><input value={requirement} onChange={(event) => updateRequirement(index, event.target.value)} placeholder="Добавить критерий проверки" />{requirements.length > 1 && <button type="button" className="icon-button compact" aria-label={`Удалить критерий ${index + 1}`} onClick={() => setRequirements((current) => current.filter((_, requirementIndex) => requirementIndex !== index))}><X size={14} /></button>}</div>)}</div>
        </div>
        <label className="form-field"><span>Срок сдачи</span><input type="date" value={deadline} onChange={(event) => { setDeadline(event.target.value); setPublished(false); }} /></label>
        <div className="form-section"><div className="form-section-heading"><div><span>Формат ответа</span><small>Что ученик сможет приложить к работе.</small></div></div><div className="format-options"><label className={`format-option ${formats.includes("comment") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("comment")} onChange={() => toggleFormat("comment")} /><MessageSquareText size={16} /><span>Комментарий</span></label><label className={`format-option ${formats.includes("image") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("image")} onChange={() => toggleFormat("image")} /><FileCheck2 size={16} /><span>Изображение</span></label><label className={`format-option ${formats.includes("video") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("video")} onChange={() => toggleFormat("video")} /><Play size={16} /><span>Видео</span></label></div></div>
        <div className="create-actions"><button type="button" className="secondary-button" onClick={clearForm}>Очистить</button><button type="submit" className="primary-button" disabled={!canPublish || published || publishing}>{published ? "Задание опубликовано" : publishing ? "Публикуем…" : "Опубликовать задание"} <ChevronRight size={16} /></button></div>
        {publishError && <div className="file-error" role="alert">{publishError}</div>}
        {published && <div className="detail-feedback curator-decision"><Target size={17} /><div><strong>Задание опубликовано в выбранный урок</strong><p>Ученики увидят его в разделе «Задания» и внутри связанного урока.</p></div></div>}
      </div>
    </section>
    <aside className="content-panel assignment-preview"><div className="section-heading"><div><span className="section-kicker">ПРЕДПРОСМОТР</span><h2>Так увидит ученик</h2></div><EyeIcon /></div><div className="preview-body"><div className="preview-module">{selectedModule ? `${selectedModule.number} · ${selectedModule.title}` : "Модуль не выбран"}</div><div className="preview-lesson">{selectedLesson?.title ?? "Урок не выбран"}</div><h3>{title || "Название нового задания"}</h3><p>{description || "Здесь появится описание задания и контекст, который увидит ученик перед началом работы."}</p><div className="preview-meta"><span><Clock3 size={14} /> {deadline || "Срок не выбран"}</span></div><div className="preview-requirements"><span className="detail-label">ЧТО НУЖНО СДЕЛАТЬ</span>{requirements.filter((requirement) => requirement.trim()).length > 0 ? requirements.filter((requirement) => requirement.trim()).map((requirement) => <div key={requirement}><span />{requirement}</div>) : <div className="preview-empty">Критерии появятся после заполнения формы.</div>}</div></div></aside>
  </form>;
}

function CreateAssignmentMaterialPanel() {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("");
  const handled = useRef(new Set<string>());

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<AssignmentMaterialDraft>("assignment-material-draft", {
      detail: { title, url, file },
    }));
  }, [title, url, file]);

  useEffect(() => {
    const handlePublished = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isAssignment(event.detail) || Boolean((event.detail as Assignment & { materialsHandled?: boolean }).materialsHandled) || handled.current.has(event.detail.id)) return;
      if (!file && !url.trim()) return;
      handled.current.add(event.detail.id);
      void (async () => {
        try {
          const materials = [
            ...(url.trim() ? [{ kind: "LINK" as const, title: title.trim() || "Ссылка к заданию", url: url.trim() }] : []),
            ...(file ? [{ kind: "FILE" as const, title: file.name, fileId: await uploadPrivateFile(file) }] : []),
          ];
          if (materials.length === 0) return;
          const response = await fetch(`${API_ORIGIN}/api/assignments/${event.detail.id}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ materials }) });
          const payload = await response.json() as { data?: Assignment; message?: string };
          if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось прикрепить материал.");
          setStatus("Материал прикреплён к опубликованному заданию.");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Не удалось прикрепить материал.");
        }
      })();
    };
    window.addEventListener(assignmentPublishedEvent, handlePublished);
    return () => window.removeEventListener(assignmentPublishedEvent, handlePublished);
  }, [file, title, url]);

  return <section className="content-panel assignment-material-panel"><div className="section-heading"><div><span className="section-kicker">ДОПОЛНИТЕЛЬНЫЕ МАТЕРИАЛЫ</span><h2>Что увидит ученик перед ответом</h2><p className="section-heading-note">Можно добавить одновременно ссылку Vimeo/Notion и несколько файлов к одному заданию.</p></div></div><div className="assignment-material-editor"><div className="form-grid"><label className="form-field"><span>Название материала</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Запись разбора или пример" /></label><label className="form-field"><span>Ссылка Vimeo/Notion</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://vimeo.com/..." /></label></div><label className={`file-dropzone ${file ? "has-file" : ""}`} htmlFor="curator-assignment-material"><FileCheck2 size={17} /><span>{file?.name || "Прикрепить изображение, PDF или видео"}</span><small>PNG, JPG, PDF, MP4 или WebM · до 10 МБ</small><input id="curator-assignment-material" type="file" accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => { const next = event.target.files?.[0] ?? null; if (next && next.size > 10 * 1024 * 1024) { setStatus("Файл слишком большой. Максимальный размер — 10 МБ."); return; } setStatus(""); setFile(next); }} /></label>{status && <div className="detail-feedback"><Target size={17} /><div><strong>{status}</strong><p>Сначала опубликуй задание основной кнопкой выше. Материалы сохранятся в защищённом хранилище.</p></div></div>}</div></section>;
}

function AssignmentMaterialLivePreview({ draft }: { draft: AssignmentMaterialDraft }) {
  const previewUrl = useObjectUrl(draft.file);
  const embedUrl = draft.url.trim() ? assignmentMaterialEmbed(draft.url.trim()) : null;
  const host = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".assignment-preview .preview-body");

  if ((!draft.file && !draft.url.trim()) || !host) return null;

  return createPortal(<div className="assignment-material-live-preview">
    <div className="assignment-material-live-heading"><span className="section-kicker">МАТЕРИАЛ К ЗАДАНИЮ</span><strong>Предпросмотр для ученика</strong></div>
    <div className="assignment-material-live-body">
      <div className="assignment-material-live-head"><strong>{draft.title.trim() || draft.file?.name || "Материал к заданию"}</strong><span>{draft.file?.type || "Ссылка"}</span></div>
      {draft.file && previewUrl && draft.file.type.startsWith("image/") && <div className="assignment-material-live-image"><Image src={previewUrl} alt="Предпросмотр материала" fill sizes="(max-width: 900px) 100vw, 560px" unoptimized /></div>}
      {draft.file && previewUrl && draft.file.type.startsWith("video/") && <video className="assignment-material-live-video" src={previewUrl} controls preload="metadata" />}
      {draft.file && previewUrl && draft.file.type === "application/pdf" && <iframe className="assignment-material-live-pdf" src={previewUrl} title="Предпросмотр PDF" />}
      {embedUrl && <iframe className="assignment-material-live-embed" src={embedUrl} title="Предпросмотр ссылки" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
      {!embedUrl && draft.url.trim() && <a className="secondary-button" href={draft.url} target="_blank" rel="noreferrer">Открыть ссылку <ArrowUpRight size={15} /></a>}
    </div>
  </div>, host);
}

function CreateAssignmentForm() {
  const [materialDraft, setMaterialDraft] = useState<AssignmentMaterialDraft>({ title: "", url: "", file: null });

  useEffect(() => {
    const handleDraft = (event: Event) => {
      if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== "object") return;
      const draft = event.detail as Partial<AssignmentMaterialDraft>;
      if (typeof draft.title !== "string" || typeof draft.url !== "string" || !(draft.file === null || draft.file instanceof File)) return;
      setMaterialDraft({ title: draft.title, url: draft.url, file: draft.file });
    };
    window.addEventListener("assignment-material-draft", handleDraft);
    return () => window.removeEventListener("assignment-material-draft", handleDraft);
  }, []);

  return <><AssignmentCreatorForm materialDraft={materialDraft} /><CreateAssignmentMaterialPanel /><AssignmentMaterialLivePreview draft={materialDraft} /></>;
}

function EyeIcon() {
  return <span className="preview-eye" aria-hidden="true"><Target size={18} /></span>;
}

type ModuleContentItem = { id: string; kind: "Урок" | "Стрим" | "Задание"; tone: "lesson" | "stream" | "task"; title: string; meta: string };

function moduleContentFor(module: PracticumModule, lessons: readonly CourseLesson[] = []): ModuleContentItem[] {
  if (lessons.length > 0) {
    const fallback = moduleContentFor(module);
    return lessons.flatMap((lesson, index) => {
      const template = fallback[index] ?? fallback[fallback.length - 1];
      const safeLessonTitle = /\?{3,}/.test(lesson.title) ? `Урок ${String(index + 1).padStart(2, "0")}` : lesson.title;
      const lessonItems: ModuleContentItem[] = lesson.type === "STREAM" || lesson.type === "ASSIGNMENT" ? [] : [{ id: lesson.id, kind: template.kind, tone: template.tone, title: safeLessonTitle, meta: "Материал урока" }];
      const mediaItems: ModuleContentItem[] = lesson.media
        .filter((media) => media.status === "PUBLISHED")
        .map((media) => ({ id: media.id, kind: fallback[1]?.kind ?? template.kind, tone: "stream", title: media.title ?? safeLessonTitle, meta: `Запись · ${formatDuration(media.durationSec)}` }));
      const assignmentItems: ModuleContentItem[] = lesson.assignments
        .filter((assignment) => !/(тестов|тестов|урок\s*0[789]|\?{3,})/i.test(assignment.title))
        .map((assignment, assignmentIndex) => ({ id: assignment.id, kind: fallback[2]?.kind ?? template.kind, tone: "task", title: /\?{3,}/.test(assignment.title) ? `Домашнее задание ${assignmentIndex + 1}` : assignment.title, meta: "Отправка работы" }));
      return [...lessonItems, ...mediaItems, ...assignmentItems];
    });
  }

  return [
    { id: `${module.id}-lesson`, kind: "Урок", tone: "lesson", title: module.id === "week-1" ? "Market Logic: базовые принципы" : `Введение в блок «${module.title}»`, meta: "Видео · 18 мин" },
    { id: `${module.id}-stream`, kind: "Стрим", tone: "stream", title: "Практика с куратором", meta: "Запись · 42 мин" },
    { id: `${module.id}-task`, kind: "Задание", tone: "task", title: "Закрепить материал", meta: "Отправка работы" },
  ];
}

function CourseView({ unlockedModuleIds: initialUnlockedModuleIds, onOpenAssignment, onOpenDiscussion }: { unlockedModuleIds: ReadonlySet<string>; onOpenAssignment: (assignmentId: string) => void; onOpenDiscussion: (context: DiscussionContext) => void }) {
  const [liveCourse, setLiveCourse] = useState<CourseState | null>(null);
  const [liveUnlockedModuleIds, setLiveUnlockedModuleIds] = useState<ReadonlySet<string> | null>(null);
  const [courseLoadError, setCourseLoadError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refreshCourse = () => {
      void fetch(`${API_ORIGIN}/api/course`, { credentials: "include", cache: "no-store" })
        .then(async (response) => {
          if (cancelled) return;
          if (!response.ok) { setCourseLoadError("Не удалось загрузить практикум. Показаны демонстрационные данные."); return; }
          const nextCourse = normalizeCourse(await response.json() as CourseApiPayload);
          if (!nextCourse) return;
          setCourseLoadError("");
          setLiveCourse(nextCourse);
          setLiveUnlockedModuleIds(new Set(nextCourse.modules.filter((module) => !module.locked).map((module) => module.id)));
        })
        .catch(() => { if (!cancelled) setCourseLoadError("Не удалось загрузить практикум. Показаны демонстрационные данные."); });
    };
    refreshCourse();
    window.addEventListener("focus", refreshCourse);
    const refreshTimer = window.setInterval(refreshCourse, 60_000);
    return () => { cancelled = true; window.removeEventListener("focus", refreshCourse); window.clearInterval(refreshTimer); };
  }, []);

  const courseModules = liveCourse?.modules ?? defaultCourseModules;
  const courseLessons = liveCourse?.lessonsByModule ?? {};
  // During local visual QA keep every module interactive so the full course
  // composition can be reviewed without changing production access rules.
  const effectiveUnlockedModuleIds = process.env.NODE_ENV === "development"
    ? new Set(courseModules.map((module) => module.id))
    : (liveUnlockedModuleIds ?? initialUnlockedModuleIds);
  const practicumModules = courseModules;
  const unlockedModuleIds = effectiveUnlockedModuleIds;
  const [selectedId, setSelectedId] = useState("week-1");
  const [hasUserSelectedModule, setHasUserSelectedModule] = useState(false);
  const [continued, setContinued] = useState(false);
  const [selectedContentId, setSelectedContentId] = useState("week-1-lesson");
  const [openedModuleId, setOpenedModuleId] = useState<string | null>(null);
  const selectedModule = courseModules.find((module) => module.id === selectedId) ?? courseModules.find((module) => module.position === 1) ?? courseModules[0];
  const openedModule = courseModules.find((module) => module.id === openedModuleId);
  const moduleToOpen = continued ? (openedModule ?? selectedModule) : undefined;
  const practicumProgress = calculatePracticumProgress(courseModules);
  const sectionOrder: PracticumSection[] = ["Welcome", "Education", "Q&A", "Practice"];
  const moduleContents = moduleContentFor(selectedModule, courseLessons[selectedModule.id]);
  const selectedContent = moduleContents.find((item) => item.id === selectedContentId) ?? moduleContents[0];
  const moduleUnlocked = effectiveUnlockedModuleIds.has(selectedModule.id);

  useEffect(() => {
    const moduleCountNode = document.querySelector<HTMLElement>(".learner-course-view .course-map .progress-inline");
    moduleCountNode?.setAttribute("data-module-count", String(practicumModules.length));
  }, [practicumModules.length]);

  useEffect(() => {
    const moduleRows = document.querySelectorAll<HTMLButtonElement>(".learner-course-view .course-map .module-row");
    moduleRows.forEach((row) => {
      const title = row.querySelector<HTMLElement>(".module-copy strong")?.textContent?.trim() ?? "";
      const moduleRecord = practicumModules.find((item) => item.title === title);
      if (moduleRecord) {
        row.setAttribute("data-module-description", moduleRecord.description);
        row.setAttribute("data-module-number", moduleRecord.number);
        row.querySelector<HTMLElement>(".module-copy strong")?.setAttribute("data-module-number", moduleRecord.number);
      }
    });
  }, [practicumModules]);

  if (moduleToOpen) return <ModuleOverviewPage module={moduleToOpen} lessons={courseLessons[moduleToOpen.id]} onOpenAssignment={onOpenAssignment} onOpenDiscussion={onOpenDiscussion} onBack={() => { setOpenedModuleId(null); setContinued(false); }} />;

  const moduleSteps = [
    { label: "Уроки и материалы", description: `${selectedModule.lessons} уроков в модуле`, icon: <BookOpen size={16} />, complete: selectedModule.progress > 0 },
    { label: "Практическое задание", description: moduleUnlocked ? "Закрепи материал в своей работе" : "Откроется после предыдущего блока", icon: <Target size={16} />, complete: selectedModule.progress === 100 },
    { label: "Проверка куратора", description: selectedModule.progress === 100 ? "Модуль завершён" : "После отправки задания", icon: <FileCheck2 size={16} />, complete: selectedModule.progress === 100 },
  ];

  return <div className="course-page">
    {courseLoadError && <div className="file-error" role="alert">{courseLoadError}</div>}
    <section className="course-progress-panel content-panel">
      <div className="course-progress-copy"><span className="section-kicker">ПРОГРЕСС ПРАКТИКУМА</span><strong>{practicumProgress}%</strong><div className="course-progress-figma-bar" aria-hidden="true"><b style={{ width: `${practicumProgress}%` }} /></div><span>Завершённый прогресс по доступным блокам. Двигайся дальше в своём темпе.</span></div>
      <div className="course-progress-track"><div><span>Общий прогресс</span><strong>{practicumProgress}% выполнено</strong></div><i><b style={{ width: `${practicumProgress}%` }} /></i></div>
      <div className="course-progress-fact"><span>ДОСТУП</span><div className="course-progress-fact-highlight"><strong>Материалы останутся после завершения</strong><small>Записи, уроки и проверенные работы будут сохранены в профиле.</small></div></div>
    </section>

    <div className="course-workspace"><section className="content-panel course-map"><div className="section-heading"><div><h2>Структура курса</h2></div><span className="progress-inline">{practicumProgress}% пройдено</span></div><div className="module-sections">{sectionOrder.map((section) => { const sectionModules = practicumModules.filter((module) => module.section === section); return <section className="module-section" key={section}><div className="module-section-heading"><strong>{section}</strong><span>{sectionModules.length} {sectionModules.length === 1 ? "блок" : "блока"}</span></div><div className="module-list">{sectionModules.map((module) => { const unlocked = unlockedModuleIds.has(module.id); return <button className={`module-row ${hasUserSelectedModule && selectedModule.id === module.id ? "selected" : ""} ${unlocked ? "" : "locked"}`} key={module.id} onClick={() => { if (unlocked) { setSelectedId(module.id); setSelectedContentId(`${module.id}-lesson`); setOpenedModuleId(module.id); setHasUserSelectedModule(true); } }} aria-pressed={hasUserSelectedModule && selectedModule.id === module.id} disabled={!unlocked}><span className="module-number">{module.number}</span><div className="module-copy"><strong>{module.title}</strong><span>{unlocked ? module.status : "Закрыт"} · {module.lessons} {module.lessons === 1 ? "урок" : "урока"}</span></div><div className="module-progress"><span>{module.progress}%</span><i><b style={{ width: `${module.progress}%` }} /></i></div>{unlocked ? <ChevronRight size={16} /> : <LockKeyhole size={15} />}</button>; })}</div></section>; })}</div><div className="course-map-footer"><span>Закрытые блоки откроются после завершения предыдущего этапа и разблокировки куратором.</span><button className="text-button" onClick={() => { setSelectedId("week-1"); setSelectedContentId("week-1-lesson"); setHasUserSelectedModule(true); }}>Вернуться к текущему <ChevronRight size={15} /></button></div></section><section className="content-panel module-detail"><div className="module-detail-head"><div><span className="section-kicker">УРОК {selectedModule.number}</span><h2>{selectedModule.title}</h2></div>{moduleUnlocked ? <Target size={19} className="heading-icon" /> : <LockKeyhole size={19} className="heading-icon" />}</div><div className="module-detail-body"><div className="module-detail-summary"><div className="module-progress-large"><strong>{selectedModule.progress}%</strong><span>пройдено</span></div><p>{selectedModule.description}</p></div><div className="module-detail-meta"><span><BookOpen size={14} /> {selectedModule.lessons} {selectedModule.lessons === 1 ? "урок" : "урока"}</span><span><FileCheck2 size={14} /> {moduleUnlocked ? "Материалы доступны" : "Доступ ограничен"}</span></div><div className="module-content-block"><div className="module-content-heading"><span>СОДЕРЖАНИЕ УРОКА</span><small>{moduleContents.length} элемента</small></div><div className="module-content-list">{moduleContents.map((item) => <button className={`module-content-item ${item.tone} ${selectedContent.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedContentId(item.id)} disabled={!moduleUnlocked}><span className="module-content-kind">{item.kind}</span><span className="module-content-copy"><strong>{item.title}</strong><small>{item.meta}</small></span><ChevronRight size={16} /></button>)}</div><div className="module-content-preview"><span>ВЫБРАНО</span><strong>{selectedContent.title}</strong><small>{selectedContent.kind} · {selectedContent.meta} · Откроется внутри платформы</small></div></div><div className="module-steps"><span className="detail-label">КАК ПРОХОДИТ МОДУЛЬ</span>{moduleSteps.map((step, index) => <div className={`module-step ${step.complete ? "complete" : ""} ${moduleUnlocked ? "" : "locked"}`} key={step.label}><div className="module-step-icon">{moduleUnlocked ? step.icon : <LockKeyhole size={15} />}</div><div><strong>{String(index + 1).padStart(2, "0")} · {step.label}</strong><span>{step.description}</span></div><small>{moduleUnlocked ? (step.complete ? "Готово" : "Дальше") : "Закрыто"}</small></div>)}</div>{moduleUnlocked ? <><div className="next-lesson"><span className="section-kicker">СЛЕДУЮЩИЙ ШАГ</span><strong>{selectedModule.progress === 100 ? "Повторить ключевые уроки" : "Продолжить с последнего урока"}</strong><span>{continued ? "Шаг отмечен для продолжения" : "Материалы и прогресс сохранятся в профиле"}</span></div><button className="primary-button open-module-button" onClick={() => setContinued(true)}><span>{continued ? "Продолжение открыто" : selectedModule.progress === 100 ? "Открыть урок" : "Продолжить обучение"}</span><span className="open-module-button-arrow" aria-hidden="true"><ChevronRight size={17} /></span></button></> : <div className="locked-note"><LockKeyhole size={17} /><div><strong>Урок пока закрыт</strong><span>Дождись разблокировки блока куратором, чтобы открыть материалы.</span></div></div>}</div></section></div>
  </div>;
}

function modulePageContentFor(module: PracticumModule) {
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

function ModuleOverviewPageLegacy({ module, lessons = [], onOpenAssignment, onOpenDiscussion, onBack }: { module: PracticumModule; lessons?: readonly CourseLesson[]; onOpenAssignment: (assignmentId: string) => void; onOpenDiscussion: (context: DiscussionContext) => void; onBack: () => void }) {
  const baseContent = modulePageContentFor(module);
  const linkedAssignmentData = lessons.flatMap((lesson) => lesson.assignments)[0];
  const linkedAssignment: Assignment | undefined = linkedAssignmentData ? {
    ...linkedAssignmentData,
    module: `${module.number} · ${module.title}`,
    status: "Не начато",
    tone: "gray",
    date: "",
    deadline: linkedAssignmentData.deadline ? `Срок: ${linkedAssignmentData.deadline}` : "Срок не указан",
  } : undefined;
  const content = linkedAssignment && linkedAssignment.requirements.length > 0
    ? { ...baseContent, homework: linkedAssignment.requirements }
    : baseContent;
  const videoRef = useRef<HTMLVideoElement>(null);
  const modalVideoRef = useRef<HTMLVideoElement>(null);
  const modalEmbedRef = useRef<HTMLIFrameElement>(null);
  const [playing, setPlaying] = useState(false);
  const [playerOpen, setPlayerOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [discussionOpened, setDiscussionOpened] = useState(false);
  const mediaEntries = lessons.flatMap((lesson) => lesson.media
    .filter((media) => media.status === "PUBLISHED" && media.embedUrl)
    .map((media) => ({ ...media, lessonTitle: lesson.title })));
  const [selectedMediaId, setSelectedMediaId] = useState("");
  const selectedMedia = mediaEntries.find((media) => media.id === selectedMediaId) ?? mediaEntries[0];
  const lessonVideo: LessonVideo | undefined = selectedMedia?.embedUrl
    ? { title: selectedMedia.title ?? selectedMedia.lessonTitle, source: "vimeo", url: selectedMedia.embedUrl, duration: formatDuration(selectedMedia.durationSec) }
    : undefined;
  const openPlayer = () => {
    videoRef.current?.pause();
    setPlayerOpen(true);
  };
  const closePlayer = () => {
    modalVideoRef.current?.pause();
    setPlayerOpen(false);
    setPlaying(false);
  };
  const requestFullscreen = () => {
    const player = lessonVideo?.source === "vimeo" ? modalEmbedRef.current : modalVideoRef.current;
    if (!player) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void player.requestFullscreen();
  };
  useEffect(() => {
    if (!playerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePlayer();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playerOpen]);
  const openAssignment = () => {
    if (linkedAssignment) setAssignmentOpen(true);
    else onOpenAssignment("");
  };
  useEffect(() => {
    if (!discussionOpened) return;
    onOpenDiscussion({ module: `${module.number} · ${module.title}`, lesson: lessons[0]?.title ?? module.title, coverPath: module.coverPath, moduleId: module.id, lessonId: lessons[0]?.id });
  }, [discussionOpened, lessons, module.coverPath, module.id, module.number, module.title, onOpenDiscussion]);

  const streamTitle = lessonVideo?.title ?? content.streamTitle;
  const streamDuration = lessonVideo?.duration ?? content.streamMeta.replace("Р—Р°РїСЃСЊ СЃС‚СЂРёРјР° В· ", "");
  if (mediaEntries.length < 0) {
  const streamDuration = lessonVideo?.duration ?? content.streamMeta.replace("Запись стрима · ", "");

 return <div className="module-page"><div className="module-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к структуре</button><span className="module-page-breadcrumb">{module.section} / {module.title}</span></div><header className="module-page-header"><div><span className="eyebrow"><BookOpen size={14} /> МОДУЛЬ {module.number}</span><h2>{module.title}</h2><p>{module.description}</p></div><div className="module-page-progress"><strong>{module.progress}%</strong><span>пройдено</span><i><b style={{ width: `${module.progress}%` }} /></i></div></header><div className="module-resource-grid"><section className="module-resource-card module-description-card"><div className="module-resource-heading"><BookOpen size={17} /><h3>Описание</h3></div><p>{module.description} Здесь собраны основные идеи, которые нужно понять перед практикой.</p></section><section className="module-resource-card module-stream-card"><div className="module-resource-heading"><Play size={17} /><h3>Запись стрима</h3><span>{lessonVideo ? "Материал урока" : "Демо-плеер"}</span></div><div className="module-video-stage">{lessonVideo?.source === "vimeo" ? <iframe src={lessonVideo.url} title={streamTitle} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> : <video ref={videoRef} src={lessonVideo?.url ?? "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"} poster="/market-logic-cover.png" preload="metadata" controls onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}<span className="module-video-label">{streamTitle}</span><button className={`play-button ${playing ? "is-playing" : ""}`} aria-label="Открыть плеер" onClick={openPlayer}><Play size={18} fill="currentColor" /></button><span className="stream-duration">{playing ? "ВОСПРОИЗВЕДЕНИЕ" : streamDuration}</span></div></section><section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{content.homework.length} пункта</span></div><ol>{content.homework.map((item) => <li key={item}>{item}</li>)}</ol><p className="module-resource-note">К каждому вопросу требуется как текстовое описание, так и схема с графическим описанием вопроса.</p><button className="primary-button" onClick={openAssignment}>{assignmentOpen ? "Задание открыто" : "Открыть задание"} <ChevronRight size={16} /></button>{assignmentOpen && <div className="module-action-feedback">Форма задания открыта поверх модуля.</div>}</section><section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>Разобрано на стриме</span></div><ul>{content.questions.map((question) => <li key={question}>{question}</li>)}</ul><button className="secondary-button" onClick={() => setDiscussionOpened((current) => !current)}>{discussionOpened ? "Обсуждение открыто" : "Открыть обсуждение"} <ChevronRight size={16} /></button>{discussionOpened && <div className="module-action-feedback">Здесь появится ветка вопросов и ответов по модулю.</div>}</section></div>{playerOpen && <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Плеер: ${streamTitle}`} onMouseDown={(event) => { if (event.currentTarget === event.target) closePlayer(); }}><div className="video-modal"><div className="video-modal-head"><div><span className="section-kicker">ЗАПИСЬ СТРИМА</span><strong>{streamTitle}</strong></div><button className="icon-button" aria-label="Закрыть плеер" onClick={closePlayer}><X size={18} /></button></div>{lessonVideo?.source === "vimeo" ? <iframe ref={modalEmbedRef} src={lessonVideo.url} title={streamTitle} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> : <video ref={modalVideoRef} src={lessonVideo?.url ?? "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"} poster="/market-logic-cover.png" controls autoPlay playsInline onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />}<div className="video-modal-foot"><span>{lessonVideo ? "Запись доступна внутри урока" : "Демо-видео · будущая запись будет открываться здесь"}</span><button className="secondary-button" onClick={requestFullscreen}><Maximize2 size={15} /> На весь экран</button></div></div></div>}{assignmentOpen && linkedAssignment && <div className="assignment-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Задание: ${linkedAssignment.title}`} onMouseDown={(event) => { if (event.currentTarget === event.target) setAssignmentOpen(false); }}><div className="assignment-modal"><div className="assignment-modal-head"><div><span className="section-kicker">ЗАДАНИЕ К МОДУЛЮ</span><strong>{linkedAssignment.title}</strong></div><button className="icon-button" aria-label="Закрыть задание" onClick={() => setAssignmentOpen(false)}><X size={18} /></button></div><AssignmentDetail assignment={linkedAssignment} /></div></div>}</div>;
  }
  return <div className="module-page">
    <div className="module-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к структуре</button><span className="module-page-breadcrumb">{module.section} / {module.title}</span></div>
    <header className="module-page-header"><div><span className="eyebrow"><BookOpen size={14} /> МОДУЛЬ {module.number}</span><h2>{module.title}</h2><p>{module.description}</p></div><div className="module-page-progress"><strong>{module.progress}%</strong><span>пройдено</span><i><b style={{ width: `${module.progress}%` }} /></i></div></header>
    <div className="module-resource-grid">
      <section className="module-resource-card module-description-card"><div className="module-resource-heading"><BookOpen size={17} /><h3>Описание</h3></div><p>{module.description} Здесь собраны основные идеи, которые нужно понять перед практикой.</p></section>
      <section className="module-resource-card module-stream-card">
        <div className="module-resource-heading"><Play size={17} /><h3>Записи блока</h3><span>{mediaEntries.length} {mediaEntries.length === 1 ? "запись" : "записи"}</span></div>
        {lessonVideo ? <div className="module-video-stage"><iframe src={lessonVideo!.url} title={streamTitle} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /><span className="module-video-label">{streamTitle}</span><button className={`play-button ${playing ? "is-playing" : ""}`} aria-label="Открыть плеер" onClick={openPlayer}><Play size={18} fill="currentColor" /></button><span className="stream-duration">{playing ? "ВОСПРОИЗВЕДЕНИЕ" : streamDuration}</span></div> : <div className="module-media-empty"><Play size={20} /><strong>Записей пока нет</strong><span>Куратор опубликует их по ходу этого блока.</span></div>}
        {mediaEntries.length > 0 && <div className="module-media-playlist">{mediaEntries.map((media, index) => <button className={`module-media-item ${media.id === selectedMedia?.id ? "selected" : ""}`} key={media.id} onClick={() => { setSelectedMediaId(media.id); setPlaying(false); }}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{media.title ?? media.lessonTitle}</strong><small>{mediaKindLabel(media.kind)} · {media.lessonTitle} · {formatDuration(media.durationSec)}</small></div><Play size={15} /></button>)}</div>}
      </section>
      <section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{content.homework.length} пункта</span></div><ol>{content.homework.map((item) => <li key={item}>{item}</li>)}</ol><p className="module-resource-note">К каждому вопросу требуется как текстовое описание, так и схема с графическим описанием вопроса.</p><button className="primary-button" onClick={openAssignment}>{assignmentOpen ? "Задание открыто" : "Открыть задание"} <ChevronRight size={16} /></button>{assignmentOpen && <div className="module-action-feedback">Форма задания открыта поверх модуля.</div>}</section>
      <section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>Разобрано на стриме</span></div><ul>{content.questions.map((question) => <li key={question}>{question}</li>)}</ul><button className="secondary-button" onClick={() => setDiscussionOpened((current) => !current)}>{discussionOpened ? "Обсуждение открыто" : "Открыть обсуждение"} <ChevronRight size={16} /></button>{discussionOpened && <div className="module-action-feedback">Здесь появится ветка вопросов и ответов по модулю.</div>}</section>
    </div>
    {playerOpen && lessonVideo && <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Плеер: ${streamTitle}`} onMouseDown={(event) => { if (event.currentTarget === event.target) closePlayer(); }}><div className="video-modal"><div className="video-modal-head"><div><span className="section-kicker">ЗАПИСЬ БЛОКА</span><strong>{streamTitle}</strong></div><button className="icon-button" aria-label="Закрыть плеер" onClick={closePlayer}><X size={18} /></button></div><iframe ref={modalEmbedRef} src={lessonVideo!.url} title={streamTitle} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /><div className="video-modal-foot"><span>Запись доступна внутри урока</span><button className="secondary-button" onClick={requestFullscreen}><Maximize2 size={15} /> На весь экран</button></div></div></div>}
  </div>;
}

void ModuleOverviewPageLegacy;

function ModuleOverviewPage({ module, lessons = [], onOpenAssignment, onOpenDiscussion, onBack }: { module: PracticumModule; lessons?: readonly CourseLesson[]; onOpenAssignment: (assignmentId: string) => void; onOpenDiscussion: (context: DiscussionContext) => void; onBack: () => void }) {
  const baseContent = modulePageContentFor(module);
  const linkedAssignmentData = lessons.flatMap((lesson) => lesson.assignments)[0];
  const linkedAssignment: Assignment | undefined = linkedAssignmentData ? { ...linkedAssignmentData, module: `${module.number} · ${module.title}`, status: "Не начато", tone: "gray", date: "", deadline: linkedAssignmentData.deadline ? `Срок: ${linkedAssignmentData.deadline}` : "Срок не указан" } : undefined;
  const content = linkedAssignment && linkedAssignment.requirements.length > 0 ? { ...baseContent, homework: linkedAssignment.requirements } : baseContent;
  const modalEmbedRef = useRef<HTMLDivElement>(null);
  const [fullscreenMediaId, setFullscreenMediaId] = useState("");
  const [discussionOpened, setDiscussionOpened] = useState(false);
  const mediaEntries = lessons.flatMap((lesson) => lesson.media.filter((media) => media.status === "PUBLISHED" && media.embedUrl).map((media) => ({ ...media, lessonTitle: lesson.title })));
  const thematicMediaEntries = mediaEntries.filter((media) => media.kind !== "QA");
  const qaMediaEntries = mediaEntries.filter((media) => media.kind === "QA");
  const fullscreenMedia = [...thematicMediaEntries, ...qaMediaEntries].find((media) => media.id === fullscreenMediaId);
  const openPlayer = (mediaId: string) => setFullscreenMediaId(mediaId);
  const closePlayer = () => setFullscreenMediaId("");
  const requestFullscreen = () => { const player = modalEmbedRef.current; if (!player) return; if (document.fullscreenElement) void document.exitFullscreen(); else void player.requestFullscreen(); };
  // Keep assignment work on the dedicated page instead of opening a modal over the lesson.
  // Passing the id lets the assignments inbox select the exact assignment the student clicked.
  const openAssignment = () => onOpenAssignment(linkedAssignment?.id ?? "");
  useEffect(() => {
    if (!fullscreenMediaId) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closePlayer(); };
    window.addEventListener("keydown", handleKeyDown); return () => window.removeEventListener("keydown", handleKeyDown);
  }, [fullscreenMediaId]);
  useEffect(() => {
    if (!discussionOpened) return;
    onOpenDiscussion({ module: `${module.number} · ${module.title}`, lesson: lessons[0]?.title ?? module.title, coverPath: module.coverPath, moduleId: module.id, lessonId: lessons[0]?.id });
  }, [discussionOpened, lessons, module.coverPath, module.id, module.number, module.title, onOpenDiscussion]);

  return <div className="module-page">
    <div className="module-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к структуре</button><span className="module-page-breadcrumb">{module.section} / {module.title}</span></div>
    <header className="module-page-header"><div><span className="eyebrow"><BookOpen size={14} /> МОДУЛЬ {module.number}</span><h2>{module.title}</h2><p>{module.description}</p></div><div className="module-page-progress"><strong>{module.progress}%</strong><span>пройдено</span><i><b style={{ width: `${module.progress}%` }} /></i></div></header>
    <div className="module-resource-grid">
      <section className="module-resource-card module-stream-card"><div className="module-resource-heading"><Play size={17} /><h3>Тематические записи</h3><span>{thematicMediaEntries.length} {thematicMediaEntries.length === 1 ? "запись" : "записей"}</span></div>{thematicMediaEntries.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Тематических записей пока нет</strong><span>Куратор опубликует их по ходу этого блока.</span></div> : <div className="module-video-stack">{thematicMediaEntries.map((media) => <div className="module-video-stage" key={media.id}>{media.embedUrl && <TrackedVideo mediaId={media.id} src={media.embedUrl} title={media.title ?? media.lessonTitle} />}<span className="module-video-label">{media.title ?? media.lessonTitle}</span><button className="play-button" aria-label="Открыть на весь экран" onClick={() => openPlayer(media.id)}><Play size={18} fill="currentColor" /></button><span className="stream-duration">{formatDuration(media.durationSec)}</span></div>)}</div>}</section>
      <section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{content.homework.length} пункта</span></div><ol>{content.homework.map((item) => <li key={item}>{item}</li>)}</ol><p className="module-resource-note">К каждому вопросу требуется как текстовое описание, так и схема с графическим описанием вопроса.</p><button className="primary-button resource-action-button" onClick={openAssignment}><span>Открыть задание</span><span className="resource-action-button-arrow" aria-hidden="true"><ChevronRight size={16} /></span></button></section>
      <section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>{qaMediaEntries.length} {qaMediaEntries.length === 1 ? "запись" : "записей"}</span></div>{qaMediaEntries.length > 0 && <div className="module-video-stack">{qaMediaEntries.map((media) => <div className="module-qa-video-stage" key={media.id}>{media.embedUrl && <TrackedVideo mediaId={media.id} src={media.embedUrl} title={media.title ?? "Q&A с куратором"} />}<span>{media.title ?? "Q&A с куратором"}</span></div>)}</div>}<ul>{content.questions.map((question) => <li key={question}>{question}</li>)}</ul><button className="secondary-button resource-action-button" onClick={() => setDiscussionOpened((current) => !current)}><span>{discussionOpened ? "Обсуждение открыто" : "Открыть обсуждение"}</span><span className="resource-action-button-arrow" aria-hidden="true"><ChevronRight size={16} /></span></button>{qaMediaEntries.length === 0 && <div className="module-action-feedback">Здесь появится Q&A-запись, когда куратор добавит её к этому уроку.</div>}</section>
    </div>
    {fullscreenMedia?.embedUrl && <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Плеер: ${fullscreenMedia.title ?? fullscreenMedia.lessonTitle}`} onMouseDown={(event) => { if (event.currentTarget === event.target) closePlayer(); }}><div className="video-modal"><div className="video-modal-head"><div><span className="section-kicker">ЗАПИСЬ БЛОКА</span><strong>{fullscreenMedia.title ?? fullscreenMedia.lessonTitle}</strong></div><button className="icon-button" aria-label="Закрыть плеер" onClick={closePlayer}><X size={18} /></button></div><TrackedVideo ref={modalEmbedRef} mediaId={fullscreenMedia.id} src={fullscreenMedia.embedUrl} title={fullscreenMedia.title ?? fullscreenMedia.lessonTitle} /><div className="video-modal-foot"><span>Запись доступна внутри урока</span><button className="secondary-button" onClick={requestFullscreen}><Maximize2 size={15} /> На весь экран</button></div></div></div>}
  </div>;
}

function AssignmentsView({ requestedAssignmentId = "" }: { requestedAssignmentId?: string }) {
  const [filter, setFilter] = useState<"all" | AssignmentStatus>("all");
  const [createdAssignments, setCreatedAssignments] = useState<Assignment[]>([]);
  const [selectedId, setSelectedId] = useState(() => createdAssignments[0]?.id ?? "");
  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/assignments`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: Assignment[] };
      setCreatedAssignments(payload.data ?? []);
      setSelectedId(requestedAssignmentId && payload.data?.some((assignment) => assignment.id === requestedAssignmentId) ? requestedAssignmentId : payload.data?.[0]?.id ?? "");
    }).catch(() => undefined);
    const handlePublished = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isAssignment(event.detail)) return;
      setCreatedAssignments((current) => [event.detail, ...current.filter((item) => item.title !== event.detail.title || item.module !== event.detail.module)]);
      setSelectedId(event.detail.id);
    };
    const handleSubmitted = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isReviewQueueItem(event.detail)) return;
      setCreatedAssignments((current) => current.map((item) => item.title === event.detail.assignmentTitle && item.module === event.detail.module ? { ...item, status: "На проверке", date: "Отправлено сейчас" } : item));
    };

    window.addEventListener(assignmentPublishedEvent, handlePublished);
    window.addEventListener(assignmentSubmittedEvent, handleSubmitted);
    return () => {
      window.removeEventListener(assignmentPublishedEvent, handlePublished);
      window.removeEventListener(assignmentSubmittedEvent, handleSubmitted);
    };
  }, [requestedAssignmentId]);
  useEffect(() => {
    const reloadAssignments = () => {
      void fetch(`${API_ORIGIN}/api/assignments`, { credentials: "include", cache: "no-store" }).then(async (response) => {
        if (!response.ok) return;
        const payload = await response.json() as { data?: Assignment[] };
        setCreatedAssignments(payload.data ?? []);
      }).catch(() => undefined);
    };
    window.addEventListener(assignmentSubmittedEvent, reloadAssignments);
    return () => window.removeEventListener(assignmentSubmittedEvent, reloadAssignments);
  }, []);
  const allAssignments: Assignment[] = [...createdAssignments, ...visibleStudentAssignments];
  const selectedAssignment = allAssignments.find((assignment) => assignment.id === selectedId) ?? allAssignments[0] ?? emptyStudentAssignment;
  const filters: Array<{ id: "all" | AssignmentStatus; label: string }> = [
    { id: "all", label: "Все" },
    { id: "На проверке", label: "На проверке" },
    { id: "Нужна доработка", label: "Нужна доработка" },
    { id: "Принято", label: "Принято" },
  ];
  const filteredAssignments = filter === "all" ? allAssignments : allAssignments.filter((assignment) => assignment.status === filter);

  return <div className="assignment-workspace"><section className="content-panel assignment-inbox"><div className="section-heading"><div><span className="section-kicker">СТАТУСЫ РАБОТ</span><h2>Мои задания</h2><p className="section-heading-note">Следи за отправками и комментариями куратора в одном месте.</p></div></div><div className="assignment-filter">{filters.map((item) => { const count = item.id === "all" ? allAssignments.length : allAssignments.filter((assignment) => assignment.status === item.id).length; return <button className={`filter-chip ${filter === item.id ? "active" : ""}`} key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{count}</span></button>; })}</div><div className="assignment-list">{filteredAssignments.length > 0 ? filteredAssignments.map((assignment) => <AssignmentRow assignment={assignment} key={assignment.id} selected={assignment.id === selectedAssignment.id} onOpen={() => setSelectedId(assignment.id)} />) : <div className="empty-state"><FileCheck2 size={22} /><strong>В этом фильтре пока пусто</strong><span>Новые статусы появятся после отправки работы или проверки куратором.</span></div>}</div><div className="assignment-inbox-footer"><span>Новые задания открываются по мере прохождения модулей практикума.</span></div></section><AssignmentDetail assignment={selectedAssignment} key={selectedAssignment.id} /></div>;
}

type ScheduleApiEvent = CourseScheduleEvent;

function scheduleApiTypeToUi(type: ScheduleApiEvent["type"]): ScheduleEvent["type"] {
  if (type === "QA") return "Q&A";
  if (type === "BREAKDOWN") return "Разбор ДЗ";
  if (type === "BACKTEST") return "Бэктест";
  return "Практическая часть";
}

function scheduleApiToUi(event: ScheduleApiEvent): ScheduleEvent {
  const parsedDate = new Date(`${event.date}T12:00:00`);
  return { id: event.id, date: event.date, day: event.date.slice(-2), month: parsedDate.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase(), weekday: parsedDate.toLocaleDateString("ru-RU", { weekday: "long" }), type: scheduleApiTypeToUi(event.type), title: event.title, time: event.time, live: event.live, description: event.description, recordingAvailable: event.recordingAvailable, recordingIds: event.recordings.filter((recording) => recording.status === "PUBLISHED").map((recording) => recording.id), coverPath: event.coverPath ?? undefined, bookedByStudentId: event.bookedByStudentId, bookedByStudentName: event.bookedByStudentName, isBookedByActor: event.isBookedByActor };
}

function scheduleUiTypeToApi(type: ScheduleEvent["type"]): "PRACTICE" | "QA" | "BREAKDOWN" | "BACKTEST" {
  if (type === "Q&A") return "QA";
  if (type === "Разбор ДЗ") return "BREAKDOWN";
  if (type === "Бэктест") return "BACKTEST";
  return "PRACTICE";
}

function isEventLiveNow(event: ScheduleEvent, now: number): boolean {
  const [startLabel, endLabel] = event.time.split(/\s*[—–-]\s*/);
  if (!startLabel) return false;
  const start = new Date(`${event.date}T${startLabel.trim()}:00`).getTime();
  const end = endLabel ? new Date(`${event.date}T${endLabel.trim()}:00`).getTime() : start + 60 * 60 * 1000;
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return now >= start && now <= end;
}

function ScheduleView({ onOpenStreams, onJoinLive }: { onOpenStreams: (recordingId?: string) => void; onJoinLive: () => void }) {
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [bookingEventId, setBookingEventId] = useState("");
  const [bookingError, setBookingError] = useState("");
  const selectedEvent = events.find((event) => event.id === selectedId) ?? events[0];
  const detailsEvent = events.find((event) => event.id === detailsId);
  const hasBacktestBooking = events.some((event) => event.type === "Бэктест" && event.isBookedByActor);
  useEffect(() => {
    const load = async () => {
      const response = await fetch(`${API_ORIGIN}/api/schedule`, { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data?: ScheduleApiEvent[] };
      if (Array.isArray(payload.data)) setEvents(payload.data.map(scheduleApiToUi));
    };
    void load().catch(() => undefined);
  }, []);
  const openEvent = (eventId: string) => { setSelectedId(eventId); setDetailsId(eventId); };
  const runBooking = async (eventId: string, action: "book" | "cancel-booking") => {
    if (bookingEventId) return;
    setBookingEventId(eventId);
    setBookingError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/schedule/${eventId}/${action}`, { method: "POST", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { data?: ScheduleApiEvent; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось выполнить действие.");
      const updated = scheduleApiToUi(payload.data);
      setEvents((current) => current.map((event) => event.id === updated.id ? updated : event));
    } catch (error) {
      setBookingError(error instanceof Error ? error.message : "Не удалось выполнить действие.");
    } finally {
      setBookingEventId("");
    }
  };

  return <>{<div className="calendar-layout"><section className="content-panel calendar-panel"><CalendarGrid events={events} selectedId={selectedId} onSelect={openEvent} /></section><section className="content-panel calendar-events"><div className="section-heading"><div><span className="section-kicker">СОБЫТИЯ</span><h2>Участие</h2></div><CalendarDays size={18} className="heading-icon" /></div>{bookingError && <div className="file-error" role="alert">{bookingError}</div>}{events.length > 0 ? events.map((event) => <ScheduleEventCard event={event} selected={event.id === selectedEvent?.id} onOpen={() => openEvent(event.id)} onOpenStreams={onOpenStreams} onJoinLive={onJoinLive} onBook={() => void runBooking(event.id, "book")} onCancelBooking={() => void runBooking(event.id, "cancel-booking")} bookingBusy={bookingEventId === event.id} hasBacktestBooking={hasBacktestBooking} key={event.id} />) : <div className="empty-state"><CalendarDays size={22} /><strong>Событий пока нет</strong><span>Куратор ещё не опубликовал встречи потока — они появятся здесь.</span></div>}</section></div>}{detailsEvent && <RichScheduleEventDetails event={detailsEvent} onOpenStreams={onOpenStreams} onJoinLive={onJoinLive} onBook={() => void runBooking(detailsEvent.id, "book")} onCancelBooking={() => void runBooking(detailsEvent.id, "cancel-booking")} bookingBusy={bookingEventId === detailsEvent.id} hasBacktestBooking={hasBacktestBooking} onClose={() => setDetailsId(null)} />}</>;
}

function CalendarGrid({ events, selectedId, onSelect, onDateSelect }: { events: readonly ScheduleEvent[]; selectedId: string; onSelect: (eventId: string) => void; onDateSelect?: (date: string) => void }) {
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const days = buildCalendarDays(currentMonth);
  const todayKey = toDateKey(new Date());
  const eventsByDate = new Map(events.map((event) => [event.date, event]));
  const shiftMonth = (amount: number) => setCurrentMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));

  return <><div className="calendar-toolbar"><div><span className="section-kicker">РАСПИСАНИЕ ПОТОКА</span><h2>{formatCalendarMonth(currentMonth)}</h2></div><div className="calendar-controls"><button className="icon-button compact" aria-label="Предыдущий месяц" onClick={() => shiftMonth(-1)}><ChevronRight size={16} className="rotate-left" /></button><button className="today-button" onClick={() => setCurrentMonth(startOfMonth(new Date()))}>Сегодня</button><button className="icon-button compact" aria-label="Следующий месяц" onClick={() => shiftMonth(1)}><ChevronRight size={16} /></button></div></div><div className="calendar-weekdays"><span>ПН</span><span>ВТ</span><span>СР</span><span>ЧТ</span><span>ПТ</span><span>СБ</span><span>ВС</span></div><div className="calendar-grid">{days.map(({ date, isOutside }) => { const event = eventsByDate.get(toDateKey(date)); const dateKey = toDateKey(date); const isToday = dateKey === todayKey; return <div className={`calendar-day ${isToday ? "today" : ""} ${isOutside ? "outside" : ""} ${event ? "has-event" : ""}`} key={dateKey} aria-label={event ? `${formatEventDate(event.date)}: ${event.title}` : formatEventDate(dateKey)} onClick={() => onDateSelect?.(dateKey)}><span className="calendar-day-number">{date.getDate()}</span>{event && <button className={`calendar-event ${eventTone(event)} ${event.id === selectedId ? "selected" : ""}`} onClick={(clickEvent) => { clickEvent.stopPropagation(); onSelect(event.id); }}><span>{event.type}</span><strong>{event.title}</strong></button>}</div>; })}</div></>;
}

function RichScheduleEventDetails({ event, onOpenStreams: navigateToStreams, onJoinLive, onBook, onCancelBooking, bookingBusy, hasBacktestBooking, onClose }: { event: ScheduleEvent; onOpenStreams: (recordingId?: string) => void; onJoinLive: () => void; onBook: () => void; onCancelBooking: () => void; bookingBusy: boolean; hasBacktestBooking: boolean; onClose: () => void }) {
  const formattedDate = formatEventDate(event.date);
  const coverPath = eventCoverPath(event);
  const isBacktest = event.type === "Бэктест";
  const [now] = useState(() => Date.now());
  const liveNow = isEventLiveNow(event, now);
  const onOpenStreams = () => {
    const recordingId = event.recordingIds?.[0];
    if (recordingId && typeof window !== "undefined") window.sessionStorage.setItem("fix-target-stream", recordingId);
    navigateToStreams(recordingId);
  };
  useEffect(() => { const handleKeyDown = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === "Escape") onClose(); }; window.addEventListener("keydown", handleKeyDown); return () => window.removeEventListener("keydown", handleKeyDown); }, [onClose]);
  let footerAction: ReactNode;
  if (event.recordingAvailable) {
    footerAction = <button className="primary-button" onClick={() => { onClose(); onOpenStreams(); }}>Открыть запись <Play size={15} /></button>;
  } else if (isBacktest) {
    if (event.isBookedByActor) footerAction = <button className="primary-button is-joined" onClick={onCancelBooking} disabled={bookingBusy}>{bookingBusy ? "Отменяем…" : "Вы записаны · отменить"}</button>;
    else if (event.bookedByStudentId) footerAction = <button className="primary-button" disabled>Слот уже занят</button>;
    else if (hasBacktestBooking) footerAction = <button className="primary-button" disabled>Бэктест уже использован</button>;
    else footerAction = <button className="primary-button" onClick={onBook} disabled={bookingBusy}>{bookingBusy ? "Записываем…" : "Записаться"}</button>;
  } else {
    footerAction = <button className={`primary-button ${liveNow ? "is-joined" : ""}`} onClick={() => { onClose(); onJoinLive(); }} disabled={!liveNow}>{liveNow ? "Присоединиться" : "Эфир ещё не начался"}</button>;
  }
  return <div className="event-details-overlay" role="presentation" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}><section className="event-details-modal rich-event-modal" role="dialog" aria-modal="true" aria-labelledby="rich-schedule-event-title"><div className="rich-event-topbar"><h2 id="rich-schedule-event-title">{event.title}</h2><button className="icon-button compact" aria-label="Закрыть детали события" onClick={onClose}><X size={20} /></button></div>{coverPath && <div className="rich-event-cover" role="img" aria-label={`Обложка события: ${event.title}`} style={{ backgroundImage: `url("${coverPath}")` }} />}<div className="rich-event-tabs"><span className="active">Сведения о событии</span><span>Участники потока</span></div><div className="rich-event-body"><div className="rich-event-date"><Clock3 size={17} /><strong>{event.weekday} · {event.time}</strong></div><h3>{event.title}</h3><div className="rich-event-line"><span>◉</span><span>Project FIX</span></div><div className="rich-event-line"><CalendarDays size={16} /><span>{formattedDate}</span></div><div className="rich-event-description">{event.description}</div>{isBacktest && event.isBookedByActor && <div className="event-recording-note"><Target size={16} /><div><strong>Слот забронирован за вами</strong><span>Куратор свяжется с вами по расписанному времени.</span></div></div>}{event.recordingAvailable && <div className="event-recording-note"><Play size={16} /><div><strong>Запись уже добавлена</strong><span>Запись доступна в разделе «Стримы» и останется там после завершения события.</span></div></div>}</div><div className="rich-event-footer">{footerAction}</div></section></div>;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function toDateKey(date: Date | string) {
  const value = typeof date === "string" ? new Date(`${date}T12:00:00`) : date;
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function formatCalendarMonth(date: Date) {
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(date).replace(/^./, (letter) => letter.toUpperCase());
}

function formatEventDate(date: Date | string) {
  const value = typeof date === "string" ? new Date(`${date}T12:00:00`) : date;
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(value);
}

function buildCalendarDays(month: Date) {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const mondayFirstOffset = (firstDay.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(month.getFullYear(), month.getMonth(), index - mondayFirstOffset + 1);
    return { date, isOutside: date.getMonth() !== month.getMonth() };
  });
}

function ScheduleEventCard({ event, selected, mode = "student", onOpen, onOpenStreams: navigateToStreams, onJoinLive, onBook, onCancelBooking, bookingBusy = false, hasBacktestBooking = false }: {
  event: ScheduleEvent;
  selected: boolean;
  mode?: "student" | "curator";
  onOpen: () => void;
  onOpenStreams?: (recordingId?: string) => void;
  onJoinLive?: () => void;
  onBook?: () => void;
  onCancelBooking?: () => void;
  bookingBusy?: boolean;
  hasBacktestBooking?: boolean;
}) {
  const coverPath = eventCoverPath(event);
  const coverStyle = coverPath ? { backgroundImage: `linear-gradient(90deg, #030303 0%, rgba(3,3,3,.97) 58%, rgba(3,3,3,.82) 78%, rgba(3,3,3,.35) 100%), url("${coverPath}")` } : undefined;
  const onOpenStreams = navigateToStreams ? () => {
    const recordingId = event.recordingIds?.[0];
    if (recordingId && typeof window !== "undefined") window.sessionStorage.setItem("fix-target-stream", recordingId);
    navigateToStreams(recordingId);
  } : undefined;
  const isBacktest = event.type === "Бэктест";
  const [now] = useState(() => Date.now());
  const liveNow = isEventLiveNow(event, now);
  const stop = (handler?: () => void) => (clickEvent: ReactMouseEvent<HTMLButtonElement>) => { clickEvent.stopPropagation(); handler?.(); };

  let actionButton: ReactNode;
  if (mode === "curator") {
    actionButton = <button className="event-action" aria-label={`Открыть событие: ${event.title}`} onClick={onOpen}><ArrowUpRight size={17} /></button>;
  } else if (event.recordingAvailable) {
    actionButton = <button className="event-register joined" onClick={onOpen}>Смотреть запись</button>;
  } else if (isBacktest) {
    if (event.isBookedByActor) actionButton = <button className="event-register joined" onClick={stop(onCancelBooking)} disabled={bookingBusy}>{bookingBusy ? "…" : "Вы записаны"}</button>;
    else if (event.bookedByStudentId) actionButton = <button className="event-register" disabled>Занято</button>;
    else if (hasBacktestBooking) actionButton = <button className="event-register" disabled>Использовано</button>;
    else actionButton = <button className="event-register" onClick={stop(onBook)} disabled={bookingBusy}>{bookingBusy ? "…" : "Записаться"}</button>;
  } else {
    actionButton = <button className={`event-register ${liveNow ? "joined" : ""}`} onClick={stop(onJoinLive)} disabled={!liveNow}>{liveNow ? "Присоединиться" : "Скоро"}</button>;
  }

  return <div className={`event-card schedule-event-card ${coverPath ? "has-cover" : ""} ${selected ? "selected" : ""}`} style={coverStyle}><button className="event-card-main" onClick={onOpen}><div className={`event-date ${eventTone(event)}`}><strong>{event.day}</strong><span>{event.month}</span></div><div className="event-info"><div className="event-type">{event.live && <span className="live-dot" />} {event.type.toUpperCase()}</div><h3>{event.title}</h3><p><Clock3 size={14} /> {event.weekday} · {event.time}</p>{isBacktest && mode === "curator" && <p className="event-backtest-status">{event.bookedByStudentName ? `Записан: ${event.bookedByStudentName}` : "Слот свободен"}</p>}</div></button>{actionButton}{mode === "student" && event.recordingAvailable && onOpenStreams && <button className="event-recording-link" onClick={(clickEvent) => { clickEvent.stopPropagation(); onOpenStreams(); }}><Play size={14} /> Запись добавлена · смотреть в «Стримах»</button>}</div>;
}

function eventCoverPath(event: ScheduleEvent): string | undefined {
  if (event.coverPath) return event.coverPath;
  if (event.type === "Q&A") return "/event-covers/QA.png";
  if (event.type === "Бэктест") return "/event-covers/BACKTEST.png";
  if (event.type === "Практическая часть") return "/event-covers/pre-session-cover.jpg";
  return undefined;
}

function eventTone(event: ScheduleEvent) {
  return event.type === "Практическая часть" ? "blue" : event.type === "Q&A" ? "cyan" : "amber";
}

function StudentLiveStreamView({ onNavigate }: { onNavigate: (nextNav: DashboardNav) => void }) {
  const [upcoming, setUpcoming] = useState<ScheduleEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const liveWrapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ isLive: boolean; playbackIframeUrl: string | null } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/schedule`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: ScheduleApiEvent[] };
      if (cancelled || !Array.isArray(payload.data)) return;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const events = payload.data.map(scheduleApiToUi)
        .filter((event) => new Date(`${event.date}T12:00:00`) >= today)
        .sort((a, b) => eventStartDate(a).getTime() - eventStartDate(b).getTime());
      setUpcoming(events);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data?: { isLive: boolean; playbackIframeUrl: string | null } };
      if (payload.data) setStatus(payload.data);
    } catch { /* keep last known state */ }
  }, []);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: { isLive: boolean; playbackIframeUrl: string | null } };
      if (payload.data) setStatus(payload.data);
    }).catch(() => undefined).finally(() => setStatusLoading(false));
  }, []);

  useEffect(() => {
    const poll = window.setInterval(() => { void refreshStatus(); }, 15_000);
    return () => window.clearInterval(poll);
  }, [refreshStatus]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void liveWrapRef.current?.requestFullscreen();
    }
  };

  const nextEvent = upcoming[0];
  const msToNextEvent = nextEvent ? eventStartDate(nextEvent).getTime() - now : null;

  return <div className="live-room">
    <div className="curator-schedule-toolbar">
      <div><span className="section-kicker">ПРЯМОЙ ЭФИР</span><strong>{status?.isLive ? "Эфир идёт прямо сейчас" : "Эфир не начат"}</strong><span>Куратор запускает трансляцию здесь — она появится автоматически, без обновления страницы.</span></div>
    </div>

    <div className="live-room-live" ref={liveWrapRef}>
      <section className="content-panel live-room-player">
        <div className="section-heading">
          <div><span className="section-kicker">ЭФИР</span><h2>Окно трансляции</h2></div>
          <div className="live-room-player-actions">
            {status?.isLive ? <span className="live-room-live-badge"><span className="live-dot" /> В эфире</span> : <span className="live-room-soon-badge">Офлайн</span>}
            <button className="icon-button compact" type="button" aria-label={isFullscreen ? "Свернуть" : "На весь экран"} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          </div>
        </div>
        {status?.isLive && status.playbackIframeUrl ? (
          <div className="live-room-player-frame">
            <TrackedVideo src={status.playbackIframeUrl} title="Прямой эфир" />
          </div>
        ) : (
          <div className="live-room-player-placeholder">
            <Radio size={26} />
            {statusLoading ? <strong>Проверяем статус эфира…</strong> : <>
              <strong>Эфир пока не начался</strong>
              {msToNextEvent !== null && msToNextEvent > 0 ? <>
                <span className="live-room-countdown">{formatCountdown(msToNextEvent)}</span>
                <span>До «{nextEvent.title}» · {nextEvent.weekday}, {formatEventDate(nextEvent.date)} · {nextEvent.time}</span>
              </> : <span>Видео появится здесь автоматически, как только куратор выйдет в эфир.</span>}
            </>}
          </div>
        )}
      </section>

      <ChatPanel isFullscreen={isFullscreen} />
    </div>

    <section className="content-panel live-room-upcoming">
      <div className="section-heading"><div><span className="section-kicker">РАСПИСАНИЕ</span><h2>Ближайшие эфиры</h2></div><CalendarDays size={18} className="heading-icon" /></div>
      {upcoming.length > 0 ? <div className="live-room-upcoming-list">{upcoming.map((event) => <button className="live-room-upcoming-row" type="button" key={event.id} onClick={() => onNavigate("Расписание")}><div><strong>{event.title}</strong><span>{event.weekday}, {formatEventDate(event.date)} · {event.time}</span></div><ChevronRight size={16} /></button>)}</div> : <div className="empty-state compact"><CalendarDays size={20} /><strong>Эфиров пока не запланировано</strong><span>Загляни в «Расписание» — там появятся ближайшие встречи.</span></div>}
    </section>
  </div>;
}

function StreamsView() {
  const [filter, setFilter] = useState<"all" | StreamKind>("all");
  const [moduleFilter, setModuleFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [courseStreams, setCourseStreams] = useState<StreamItem[] | null>(null);
  const [streamsLoadError, setStreamsLoadError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/course`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (cancelled) return;
      if (!response.ok) { setStreamsLoadError("Не удалось загрузить записи. Показаны демонстрационные данные."); return; }
       const payload = await response.json() as { data?: { modules?: CourseApiModule[]; media?: CourseLessonMedia[]; scheduleEvents?: CourseScheduleEvent[] } };
       const lessonStreams: StreamItem[] = (payload.data?.modules ?? []).flatMap((module) => module.lessons.flatMap((lesson) => lesson.media.filter((media) => media.status === "PUBLISHED" && media.embedUrl).map((media) => ({
         id: media.id,
         title: media.title ?? lesson.title,
         kind: (media.kind === "BREAKDOWN" ? "Разбор" : media.kind === "TALKS" ? "Talks" : "Стрим") as StreamKind,
        module: `${String(module.position).padStart(2, "0")} · ${module.title}`,
        lesson: lesson.title,
        date: media.publishedAt ? new Date(media.publishedAt).toLocaleDateString("ru-RU") : "Опубликовано",
        duration: formatDuration(media.durationSec),
        progress: 0,
        description: media.description ?? `Запись урока «${lesson.title}».`,
        cover: media.thumbnailUrl,
        isNew: Boolean(media.publishedAt && Date.now() - new Date(media.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000),
        embedUrl: media.embedUrl,
       }))));
       const globalStreams: StreamItem[] = (payload.data?.media ?? []).filter((media) => media.status === "PUBLISHED" && media.embedUrl).map((media) => ({
         id: media.id,
         title: media.title ?? "Talks",
         kind: "Talks",
         module: "Общая медиатека",
         lesson: "Общение",
         date: media.publishedAt ? new Date(media.publishedAt).toLocaleDateString("ru-RU") : "Опубликовано",
         duration: formatDuration(media.durationSec),
         progress: 0,
         description: media.description ?? "Свободная встреча и общение с командой.",
         cover: media.thumbnailUrl,
         isNew: Boolean(media.publishedAt && Date.now() - new Date(media.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000),
         embedUrl: media.embedUrl,
       }));
       const scheduleStreams: StreamItem[] = (payload.data?.scheduleEvents ?? []).flatMap((event) => event.recordings.filter((recording) => recording.status === "PUBLISHED" && recording.embedUrl).map((recording) => ({
         id: recording.id,
         title: recording.title ?? event.title,
         kind: (event.type === "BREAKDOWN" ? "Разбор" : "Стрим") as StreamKind,
         module: "Расписание",
         lesson: event.title,
         date: new Date(`${event.date}T12:00:00`).toLocaleDateString("ru-RU"),
         duration: "Видео",
         progress: 0,
         description: event.description || `Запись события «${event.title}».`,
         cover: recording.thumbnailUrl,
         isNew: false,
         embedUrl: recording.embedUrl,
       })));
       const nextStreams = [...lessonStreams, ...globalStreams, ...scheduleStreams];
      setStreamsLoadError("");
      setCourseStreams(nextStreams);
    }).catch(() => { if (!cancelled) setStreamsLoadError("Не удалось загрузить записи. Показаны демонстрационные данные."); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const targetId = window.sessionStorage.getItem("fix-target-stream");
    if (!targetId || !courseStreams?.some((stream) => stream.id === targetId)) return;
    const timer = window.setTimeout(() => {
      setFilter("all");
      setModuleFilter("all");
      setSelectedId(targetId);
      window.sessionStorage.removeItem("fix-target-stream");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [courseStreams]);
  const allStreams: readonly StreamItem[] = courseStreams ?? studentDashboard.streams;
  const moduleOptions = Array.from(new Set(allStreams.map((stream) => stream.module)));
  const streams = allStreams.filter((stream) => (filter === "all" || stream.kind === filter) && (moduleFilter === "all" || stream.module === moduleFilter));
  const selectedStream = streams.find((stream) => stream.id === selectedId) ?? streams[0];
  const openStream = (streamId: string) => { setSelectedId(streamId); setPlayerOpen(true); };
  const closePlayer = () => setPlayerOpen(false);
  useEffect(() => {
    if (!playerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closePlayer(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playerOpen]);

  return <div className="stream-library">{streamsLoadError && <div className="file-error" role="alert">{streamsLoadError}</div>}<div className="stream-library-toolbar"><div className="assignment-filter"><button className={`filter-chip ${filter === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>Все <span>{allStreams.length}</span></button><button className={`filter-chip ${filter === "Разбор" ? "active" : ""}`} onClick={() => setFilter("Разбор")}>Разборы <span>{allStreams.filter((stream) => stream.kind === "Разбор").length}</span></button><button className={`filter-chip ${filter === "Стрим" ? "active" : ""}`} onClick={() => setFilter("Стрим")}>Стримы <span>{allStreams.filter((stream) => stream.kind === "Стрим").length}</span></button><button className={`filter-chip ${filter === "Talks" ? "active" : ""}`} onClick={() => setFilter("Talks")}>Talks <span>{allStreams.filter((stream) => stream.kind === "Talks").length}</span></button></div><label className="stream-module-filter"><span>Модуль</span><select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}><option value="all">Все модули</option>{moduleOptions.map((module) => <option value={module} key={module}>{module}</option>)}</select></label><span className="stream-count">{streams.length} записи</span></div><section className="stream-grid">{streams.length > 0 ? streams.map((stream) => <StreamCard stream={stream} selected={stream.id === selectedStream?.id} key={stream.id} onOpen={() => openStream(stream.id)} />) : <div className="empty-state"><Play size={22} /><strong>В этом модуле пока нет записей</strong><span>Выбери другой модуль или сбрось фильтр.</span></div>}</section>{playerOpen && selectedStream && <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Плеер: ${selectedStream.title}`} onMouseDown={(event) => { if (event.currentTarget === event.target) closePlayer(); }}><div className="video-modal"><div className="video-modal-head"><div><span className="section-kicker">{selectedStream.kind.toUpperCase()} · {selectedStream.module}</span><strong>{selectedStream.title}</strong></div><button className="icon-button" aria-label="Закрыть плеер" onClick={closePlayer}><X size={18} /></button></div>{selectedStream.embedUrl ? <TrackedVideo mediaId={selectedStream.id} src={selectedStream.embedUrl} title={selectedStream.title} /> : <div className="stream-player-unavailable"><Play size={22} /><span>Видео для этой записи ещё не подключено.</span></div>}<div className="video-modal-foot"><span>{selectedStream.description}</span></div></div></div>}</div>;
}

function StreamCard({ stream, selected, onOpen }: { stream: StreamItem; selected: boolean; onOpen: () => void }) {
  return <article className={`stream-card ${selected ? "selected" : ""}`}><button className="stream-card-button" onClick={onOpen} aria-pressed={selected}><div className={`stream-preview ${stream.cover ? "has-cover" : ""}`}>{stream.cover ? <div className="stream-cover" role="img" aria-label={`Обложка: ${stream.title}`} style={{ backgroundImage: `url("${stream.cover}")` }} /> : <div className="mini-candles"><i /><i /><i /><i /><i /></div>}<div className="stream-preview-label">{stream.isNew ? "НОВАЯ ЗАПИСЬ" : stream.kind.toUpperCase()}</div><span className="play-button" aria-hidden="true"><Play size={17} fill="currentColor" /></span><span className="stream-duration">{stream.duration}</span></div><div className="stream-card-copy"><span>{stream.module} · {stream.date}</span><h3>{stream.title}</h3><p className="stream-lesson-label">Урок: {stream.lesson}</p><p>{stream.description}</p><div className="stream-progress"><i><b style={{ width: `${stream.progress}%` }} /></i><small>{stream.progress > 0 ? `${stream.progress}% просмотрено` : "Не начато"}</small></div></div></button></article>;
}

function discussionCoverForModule(position?: number, coverPath?: string | null): string {
  if (coverPath) return coverPath;
  const number = typeof position === "number" ? String(position).padStart(2, "0") : "01";
  const covers: Record<string, string> = {
    "00": "/welcome-cover.png",
    "01": "/market-logic-cover.png",
    "02": "/eq-point-narrative-cover.png",
    "03": "/delivery-ab-part-12-cover.png",
    "04": "/delivery-ab-part-3-cover.png",
    "05": "/entry-models-qa-cover.png",
    "06": "/qa-cover.png",
    "07": "/pre-session-cover.jpg",
  };
  return covers[number] ?? "/market-logic-cover.png";
}

function discussionCoverForContext(context: DiscussionContext): string {
  if (context.coverPath) return context.coverPath;
  const position = Number.parseInt(context.module.slice(0, 2), 10);
  return discussionCoverForModule(Number.isNaN(position) ? undefined : position);
}

function DiscussionCreatedState({ thread, context, onOpenHistory }: { thread: DiscussionApiThread; context: DiscussionContext; onOpenHistory: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const firstMessage = thread.messages[0];
  const attachment = firstMessage?.attachments[0];
  const attachmentUrl = attachment?.contentUrl ? `${API_ORIGIN}${attachment.contentUrl}` : "";
  const statusLabel = thread.status === "ANSWERED" ? "Ответ куратора" : thread.status === "CLOSED" ? "Тема закрыта" : "Ожидает ответа куратора";
  return <section className="content-panel discussion-created-state"><div className="discussion-created-heading"><div className="section-kicker">ВОПРОС СОЗДАН</div><h2>Вопрос отправлен куратору</h2></div><button className={`discussion-created-card ${detailsOpen ? "expanded" : ""}`} type="button" onClick={() => setDetailsOpen((current) => !current)}><span className="discussion-created-cover" role="img" aria-label={`Обложка ${context.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(7,14,23,.9), rgba(7,14,23,.25)), url("${discussionCoverForContext(context)}")` }} /><span className="discussion-created-copy"><small>{context.module} · {context.lesson}</small><strong>{thread.title}</strong><span className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{statusLabel}</span></span><ChevronDown size={20} className="discussion-created-chevron" /></button>{detailsOpen && <div className="discussion-created-details"><div className="discussion-created-status"><Clock3 size={16} /><strong>{statusLabel}</strong><span>Куратор увидит вопрос в очереди обсуждений.</span></div><div className="discussion-created-message"><span className="detail-label">ТЕКСТ ВОПРОСА</span><p>{firstMessage?.body}</p>{attachmentUrl && attachment?.mimeType.startsWith("image/") && <div className="discussion-created-attachment-image" role="img" aria-label={attachment.originalName} style={{ backgroundImage: `url("${attachmentUrl}")` }} />}{attachment && <a href={attachment.sourceUrl ? attachment.sourceUrl : (attachmentUrl || undefined)} target="_blank" rel="noreferrer"><FileCheck2 size={15} /> {attachment.originalName} <ArrowUpRight size={14} /></a>}</div></div>}<div className="discussion-created-actions"><button className="secondary-button" type="button" onClick={onOpenHistory}>Задать ещё вопрос</button></div></section>;
}

function DiscussionContextBanner({ context, onOpenHistory }: { context: DiscussionContext; onOpenHistory: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [attachmentName, setAttachmentName] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [attachmentPreviewUrl, setAttachmentPreviewUrl] = useState("");
  const [attachmentType, setAttachmentType] = useState<"image" | "video" | "file" | "">("");
  const [attachmentError, setAttachmentError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [createdThread, setCreatedThread] = useState<DiscussionApiThread | null>(null);
  const canSubmit = title.trim().length > 0 && body.trim().length > 0;

  useEffect(() => () => {
    if (attachmentPreviewUrl) URL.revokeObjectURL(attachmentPreviewUrl);
  }, [attachmentPreviewUrl]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setSubmitError("");
    let uploadedFileId = "";
    try {
      if (selectedFile) {
        const createResponse = await fetch(`${API_ORIGIN}/api/files`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ originalName: selectedFile.name, mimeType: selectedFile.type, byteSize: selectedFile.size }) });
        const createPayload = await createResponse.json().catch(() => ({})) as { message?: string; data?: { id: string; uploadUrl: string } };
        if (!createResponse.ok || !createPayload.data?.id || !createPayload.data.uploadUrl) throw new Error(createPayload.message ?? "Не удалось подготовить файл.");
        uploadedFileId = createPayload.data.id;
        const uploadResponse = await fetch(createPayload.data.uploadUrl, { method: "PUT", credentials: "include", headers: { "Content-Type": selectedFile.type }, body: selectedFile });
        if (!uploadResponse.ok) throw new Error("Не удалось загрузить файл.");
      }
      const response = await fetch(`${API_ORIGIN}/api/discussions`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, body, moduleId: context.moduleId, lessonId: context.lessonId, assignmentId: context.assignmentId, attachments: selectedFile && uploadedFileId ? [{ fileId: uploadedFileId, originalName: selectedFile.name, mimeType: selectedFile.type, byteSize: selectedFile.size }] : [] }) });
      const payload = await response.json().catch(() => ({})) as { message?: string; data?: DiscussionApiThread };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать тему.");
      setCreatedThread(payload.data);
      setSubmitted(true);
    } catch (error: unknown) {
      if (uploadedFileId) void fetch(`${API_ORIGIN}/api/files/${uploadedFileId}`, { method: "DELETE", credentials: "include" });
      setSubmitError(error instanceof Error ? error.message : "Не удалось создать тему.");
    } finally {
      setSaving(false);
    }
  };

  const selectAttachment = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setAttachmentError("Файл слишком большой. Максимальный размер — 10 МБ.");
      return;
    }
    setAttachmentError("");
    setAttachmentName(file.name);
    setSelectedFile(file);
    setAttachmentType(file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file");
    setAttachmentPreviewUrl(URL.createObjectURL(file));
  };

  const handleBodyPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    const extension = imageItem.type.split("/")[1] || "png";
    selectAttachment(new File([file], `screenshot-${Date.now()}.${extension}`, { type: imageItem.type }));
  };

  if (createdThread) return <DiscussionCreatedState thread={createdThread} context={context} onOpenHistory={onOpenHistory} />;

  return <section className="content-panel discussion-context-banner"><div className="discussion-context-heading"><h2>Задать вопрос куратору</h2></div><div className="discussion-context-chips"><span><BookOpen size={14} /> {context.module}</span>{context.lesson && <span><Play size={14} /> {context.lesson}</span>}</div><form className="discussion-composer" onSubmit={submit}><label className="form-field"><span>Тема вопроса</span><input value={title} onChange={(event) => { setTitle(event.target.value); setSubmitted(false); }} placeholder="Например: Как определить точку входа в этом сценарии?" /></label><label className="form-field"><span>Вопрос и описание</span><textarea value={body} onChange={(event) => { setBody(event.target.value); setSubmitted(false); }} onPaste={handleBodyPaste} rows={6} placeholder="Опиши, что именно непонятно. Можно добавить уровни, таймфрейм и свои наблюдения… Скриншот можно вставить сюда через Ctrl+V" /></label><label className={`discussion-attachment-picker ${attachmentName ? "has-file" : ""}`} htmlFor="discussion-attachment"><FileCheck2 size={17} /><span>{attachmentName || "Прикрепить скриншот, график, PDF или видео"}</span><small>PNG, JPG, PDF, MP4, WebM · до 10 МБ · или вставь скриншот через Ctrl+V в поле вопроса</small><input id="discussion-attachment" type="file" accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => selectAttachment(event.target.files?.[0])} /></label>{attachmentError && <div className="file-error" role="alert">{attachmentError}</div>}{attachmentPreviewUrl && <div className="discussion-selected-preview">{attachmentType === "image" && <div className="discussion-selected-image" role="img" aria-label={`Предпросмотр файла ${attachmentName}`} style={{ backgroundImage: `url("${attachmentPreviewUrl}")` }} />}{attachmentType === "video" && <video src={attachmentPreviewUrl} controls playsInline preload="metadata" />}{attachmentType === "file" && <div className="discussion-file-preview"><FileCheck2 size={18} /><span>{attachmentName}</span></div>}</div>}<div className="discussion-composer-actions"><button className="support-card" type="submit" disabled={!canSubmit || submitted || saving}><span className="support-card-label">{saving ? "Сохраняем…" : submitted ? "Вопрос отправлен" : "Задать вопрос"}</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button></div>{submitError && <div className="file-error" role="alert">{submitError}</div>}{submitted && <div className="detail-feedback accepted"><Target size={16} /><div><strong>Тема сохранена</strong><p>Вопрос записан в базу и появится у куратора.</p></div></div>}</form></section>;
}

function DiscussionViewDb({ onOpenDiscussion }: { onOpenDiscussion: (context: DiscussionContext) => void }) {
  const [threads, setThreads] = useState<CuratorDiscussion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [courseModules, setCourseModules] = useState<CourseApiModule[]>([]);
  const [pickerModuleId, setPickerModuleId] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/course`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({})) as CourseApiPayload;
      if (!cancelled) setCourseModules((payload.data?.modules ?? []).filter((module) => !module.locked));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // The picker asks "which lesson/block", meaning the top-level module (Welcome,
  // Контекст и структура рынка…) — not the VIDEO sub-record living inside it.
  const startPicked = () => {
    const courseModule = courseModules.find((item) => item.id === pickerModuleId);
    if (!courseModule) return;
    onOpenDiscussion({ module: `${courseModule.number} · ${courseModule.title}`, lesson: "", coverPath: courseModule.coverPath, moduleId: courseModule.id });
  };

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/discussions`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread[]; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось загрузить обсуждения.");
      if (!cancelled) {
        const nextThreads = (payload.data ?? []).map(mapDiscussionApiThread);
        setThreads(nextThreads);
        setSelectedId((current) => current && nextThreads.some((thread) => thread.id === current) ? current : "");
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось загрузить обсуждения.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selectedThread = threads.find((thread) => thread.id === selectedId);
  return <div className={`student-discussions ${selectedThread ? "has-selection" : ""}`}>
    <section className="content-panel discussion-new-question-card">
      <div className="section-heading discussion-new-question-heading"><h2>Задать вопрос куратору</h2></div>
      <div className="discussion-new-question-picker">
        <label className="form-field"><select value={pickerModuleId} onChange={(event) => setPickerModuleId(event.target.value)}><option value="">Выбери урок…</option>{courseModules.map((courseModule) => <option value={courseModule.id} key={courseModule.id}>{courseModule.number} · {courseModule.title}</option>)}</select></label>
        <button className="support-card" type="button" disabled={!pickerModuleId} onClick={startPicked}><span className="support-card-label">Задать вопрос</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button>
      </div>
    </section>
    <div className="student-discussion-layout">
      <section className="content-panel student-discussion-list-panel">
        <div className="section-heading"><div><span className="section-kicker">ПОТОК 04</span><h2>Мои обсуждения</h2></div><span className="progress-inline">{threads.length} тем</span></div>
        {loading ? <div className="empty-state"><MessageSquareText size={22} /><strong>Загружаем обсуждения…</strong><span>Проверяем сохранённые вопросы.</span></div> : error ? <div className="empty-state"><MessageSquareText size={22} /><strong>Не удалось загрузить обсуждения</strong><span>{error}</span></div> : threads.length === 0 ? <div className="empty-state"><MessageSquareText size={22} /><strong>Обсуждений пока нет</strong><span>Выбери урок выше и задай первый вопрос куратору.</span></div> : <div className="discussion-list">{threads.map((thread) => <button className={`discussion-row student-discussion-row ${thread.id === selectedId ? "selected" : ""}`} type="button" key={thread.id} onClick={() => setSelectedId(thread.id)}><div className="discussion-row-cover" role="img" aria-label={`Обложка ${thread.module}`} style={{ backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.4), rgba(8,17,27,.82)), url("${thread.coverPath ?? discussionCoverForContext({ module: thread.module, lesson: thread.lesson })}")` }} /><div><strong>{thread.title}</strong><span>{thread.module}{thread.lesson ? ` · ${thread.lesson}` : ""}</span><small>{thread.updatedAt} · {thread.messages.length} сообщений</small></div><b className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(thread.status)}</b><ChevronRight size={16} /></button>)}</div>}
      </section>
      {selectedThread ? <StudentDiscussionDetail thread={selectedThread} onClose={() => setSelectedId("")} onUpdate={(nextThread) => setThreads((current) => current.map((item) => item.id === nextThread.id ? nextThread : item))} /> : <section className="content-panel discussion-note"><div className="section-heading"><div><span className="section-kicker">ИСТОРИЯ ВОПРОСА</span><h2>Выбери тему</h2></div><MessageSquareText size={18} className="heading-icon" /></div><p>Нажми на вопрос слева, чтобы открыть всю переписку с куратором, вложения и контекст урока.</p></section>}
    </div>
    <CohortDiscussionFeed />
  </div>;
}

function CohortDiscussionFeed() {
  const [threads, setThreads] = useState<CuratorDiscussion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/discussions/cohort`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread[]; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось загрузить вопросы потока.");
      if (!cancelled) setThreads((payload.data ?? []).map(mapDiscussionApiThread));
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Не удалось загрузить вопросы потока.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (!loading && !error && threads.length === 0) return null;

  return <section className="content-panel cohort-discussion-panel">
    <div className="section-heading discussion-answered-heading"><h2>Отвечено ранее</h2><span className="progress-inline">{threads.length} тем</span></div>
    {loading ? <div className="empty-state"><MessageSquareText size={22} /><strong>Загружаем вопросы потока…</strong></div>
      : error ? <div className="empty-state"><MessageSquareText size={22} /><strong>Не удалось загрузить</strong><span>{error}</span></div>
      : <div className="discussion-list cohort-discussion-list">{threads.map((thread) => {
          const isOpen = thread.id === openId;
          return <div className="cohort-discussion-item" key={thread.id}>
            <button className="discussion-row student-discussion-row" type="button" onClick={() => setOpenId((current) => current === thread.id ? "" : thread.id)} aria-expanded={isOpen}>
              <div className="discussion-row-cover" role="img" aria-label={`Обложка ${thread.module}`} style={{ backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.4), rgba(8,17,27,.82)), url("${thread.coverPath ?? discussionCoverForContext({ module: thread.module, lesson: thread.lesson })}")` }} />
              <div><strong>{thread.title}</strong><span>{thread.module}{thread.lesson ? ` · ${thread.lesson}` : ""}</span><small>{thread.messages.length} {thread.messages.length === 1 ? "сообщение" : "сообщений"}</small></div>
              <ChevronRight size={16} className={isOpen ? "rotate-down" : ""} />
            </button>
            {isOpen && <div className="cohort-discussion-thread">{thread.messages.map((message) => <article className={`student-discussion-message ${message.author}`} key={message.id}><div className="student-discussion-message-meta"><strong>{message.name}</strong></div><p>{message.body}</p><DiscussionMessageAttachments message={message} /></article>)}</div>}
          </div>;
        })}</div>}
  </section>;
}

function StudentDiscussionDetail({ thread, onClose, onUpdate }: { thread: CuratorDiscussion; onClose: () => void; onUpdate: (thread: CuratorDiscussion) => void }) {
  const [reply, setReply] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState("");
  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!reply.trim() || saving || closing || thread.status === "CLOSED") return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/discussions/${thread.id}/messages`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: reply.trim() }) });
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось отправить ответ.");
      onUpdate(mapDiscussionApiThread(payload.data));
      setReply("");
      setReplyOpen(false);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Не удалось отправить ответ.");
    } finally {
      setSaving(false);
    }
  };
  const closeThread = async () => {
    if (closing || saving || thread.status === "CLOSED") return;
    setClosing(true);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/discussions/${thread.id}/close`, { method: "POST", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось закрыть вопрос.");
      onUpdate(mapDiscussionApiThread(payload.data));
      setReplyOpen(false);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : "Не удалось закрыть вопрос.");
    } finally {
      setClosing(false);
    }
  };
  return <section className="content-panel student-discussion-detail">
    <div className="student-discussion-detail-head"><div><span className="section-kicker">{thread.module}</span><h2>{thread.title}</h2><p>{thread.lesson ? `${thread.lesson} · ` : ""}{thread.updatedAt}</p></div><button className="icon-button compact" type="button" aria-label="Закрыть историю вопроса" onClick={onClose}><X size={17} /></button></div>
    <div className="student-discussion-messages">{thread.messages.map((message) => <article className={`student-discussion-message ${message.author}`} key={message.id}><div className="student-discussion-message-meta"><strong>{message.name}</strong><span>{message.time}</span></div><p>{message.body}</p><DiscussionMessageAttachments message={message} /></article>)}</div>
    <div className="student-discussion-status-note"><span className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(thread.status)}</span><span>{thread.status === "CLOSED" ? "Вопрос закрыт. Для нового обращения создай отдельную тему." : "История сохраняется, а диалог можно продолжить или закрыть."}</span></div>
    {thread.status !== "CLOSED" && <div className="student-discussion-actions"><button className="secondary-button danger-button" type="button" onClick={() => void closeThread()} disabled={closing || saving}>{closing ? "Закрываем…" : "Закрыть вопрос"}</button><button className="primary-button" type="button" onClick={() => setReplyOpen((current) => !current)}>{replyOpen ? "Скрыть ответ" : "Ответить ещё"}</button></div>}
    {replyOpen && thread.status !== "CLOSED" && <form className="student-discussion-reply" onSubmit={sendReply}><label htmlFor="student-discussion-reply">ОТВЕТ В ЭТОЙ ТЕМЕ</label><textarea id="student-discussion-reply" value={reply} onChange={(event) => setReply(event.target.value)} rows={4} placeholder="Напиши уточнение или следующий вопрос куратору…" /><div><span>Ответ добавится в историю и снова передаст тему куратору.</span><button className="primary-button" type="submit" disabled={!reply.trim() || saving}>{saving ? "Отправляем…" : "Отправить ответ"} <ChevronRight size={15} /></button></div></form>}
    {error && <div className="file-error student-discussion-error" role="alert">{error}</div>}
  </section>;
}

// Legacy demo markup kept temporarily for visual reference; it is no longer rendered.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function DiscussionView({ hideDemo = false }: { hideDemo?: boolean }) {
  if (hideDemo) return null;
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

function assignmentStatusIcon(status: AssignmentStatus, tone: AssignmentTone) {
  if (status === "Принято") return <CheckCircle2 size={16} />;
  if (status === "На проверке") return <FileCheck2 size={16} />;
  return tone === "amber" ? <ArrowUpRight size={17} /> : <Clock3 size={15} />;
}

function AssignmentRow({ assignment, onOpen, selected = false }: { assignment: Assignment; onOpen?: () => void; selected?: boolean }) {
  const modulePosition = Number.parseInt(assignment.module.slice(0, 2), 10);
  const coverPath = assignment.coverPath ?? discussionCoverForModule(Number.isNaN(modulePosition) ? undefined : modulePosition);
  const effectiveTone = assignment.status === "Принято" ? "green" : assignment.tone;
  return <button className={`assignment-row ${selected ? "selected" : ""}`} onClick={onOpen} aria-pressed={selected}><div className={`assignment-status assignment-status-cover ${effectiveTone}`} role="img" aria-label={`Обложка: ${assignment.module}`} style={{ backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.28), rgba(8,17,27,.78)), url("${coverPath}")` }}><span className="assignment-status-cover-icon">{assignmentStatusIcon(assignment.status, assignment.tone)}</span></div><div className="assignment-copy"><strong>{assignment.title}</strong><span>{assignment.module}</span><small className="assignment-hint">{assignment.status === "Принято" && <CheckCircle2 size={12} aria-hidden="true" />}{assignmentHint(assignment.status)}</small></div><div className={`assignment-badge ${effectiveTone}`}><span className="assignment-badge-icon">{assignmentStatusIcon(assignment.status, assignment.tone)}</span>{assignment.status}</div><span className="assignment-date">{assignment.date}</span><ChevronRight size={16} className="assignment-chevron" /></button>;
}

function assignmentHint(status: AssignmentStatus) {
  return status === "На проверке" ? "Отправлено сегодня" : status === "Нужна доработка" ? "Есть комментарий куратора" : status === "Не начато" ? "Ещё не отправлено" : "Работа принята";
}

function LegacyAssignmentDetail({ assignment }: { assignment: Assignment }) {
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
  useEffect(() => {
    if (!submitted || !assignment.id) return;
    let cancelled = false;
    void (async () => {
      try {
        let fileIds: string[] = [];
        if (selectedFile) {
          const createResponse = await fetch(`${API_ORIGIN}/api/files`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ originalName: selectedFile.name, mimeType: selectedFile.type, byteSize: selectedFile.size }),
          });
          const createPayload = await createResponse.json() as { message?: string; data?: { id: string; uploadUrl: string } };
          if (!createResponse.ok || !createPayload.data?.id || !createPayload.data.uploadUrl) throw new Error(createPayload.message ?? "Не удалось подготовить файл.");
          const uploadUrl = createPayload.data.uploadUrl.startsWith("http") ? createPayload.data.uploadUrl : `${API_ORIGIN}${createPayload.data.uploadUrl}`;
          const uploadResponse = await fetch(uploadUrl, { method: "PUT", credentials: "include", headers: { "Content-Type": selectedFile.type }, body: selectedFile });
          if (!uploadResponse.ok) {
            const uploadPayload = await uploadResponse.json().catch(() => ({})) as { message?: string };
            throw new Error(uploadPayload.message ?? "Не удалось загрузить файл.");
          }
          fileIds = [createPayload.data.id];
        }
        const response = await fetch(`${API_ORIGIN}/api/assignments/${assignment.id}/submissions`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answerText: draft.trim(), fileIds }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({})) as { message?: string };
          throw new Error(payload.message ?? "Не удалось отправить работу.");
        }
        if (!cancelled) window.dispatchEvent(new Event(assignmentSubmittedEvent));
      } catch (error: unknown) {
        if (!cancelled) setSubmitted(false);
        if (!cancelled) setFileError(error instanceof Error ? error.message : "Не удалось отправить работу.");
      }
    })();
    return () => { cancelled = true; };
  }, [assignment.id, draft, selectedFile, submitted]);
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
  const handleAnswerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItem = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    const extension = imageItem.type.split("/")[1] || "png";
    handleFileChange(new File([file], `screenshot-${Date.now()}.${extension}`, { type: imageItem.type }));
  };

  if (!assignment.id) {
    return <section className="content-panel assignment-detail directory-empty"><div className="empty-state"><FileCheck2 size={24} /><strong>Выбери опубликованное задание</strong><span>Когда куратор опубликует ДЗ, оно появится в этом списке.</span></div></section>;
  }

  return <section className="content-panel assignment-detail"><div className="detail-header"><div><span className="section-kicker">{assignment.module}</span><h2>{assignment.title}</h2></div><div className={`assignment-badge ${assignment.status === "Принято" ? "green" : assignment.tone}`}>{submitted ? "На проверке" : assignment.status}</div></div><div className="detail-meta"><span><Clock3 size={14} /> {assignment.deadline}</span><span><FileCheck2 size={14} /> {isAccepted ? "Проверено куратором" : "Можно отправлять заново после доработки"}</span></div><div className="detail-body"><p className="detail-description">{assignment.description}</p><div className="detail-section"><span className="detail-label">ЧТО НУЖНО СДЕЛАТЬ</span><ul className="detail-checklist">{assignment.requirements.map((requirement) => <li key={requirement}><span />{requirement}</li>)}</ul></div>{isAccepted ? <div className="detail-feedback accepted"><Target size={17} /><div><strong>Задание принято</strong><p>Куратор подтвердил работу. Материал сохранён в истории практикума.</p></div></div> : assignment.blockedByModuleTitle ? <div className="detail-feedback locked"><LockKeyhole size={17} /><div><strong>Пока недоступно</strong><p>Сначала сдайте ДЗ модуля «{assignment.blockedByModuleTitle}» — вернитесь туда и отправьте работу, тогда это задание откроется.</p></div></div> : <><div className="detail-section"><label className="detail-label" htmlFor="assignment-answer">ТВОЙ КОММЕНТАРИЙ</label><textarea id="assignment-answer" value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); setSubmitted(false); }} onPaste={handleAnswerPaste} placeholder="Опиши логику решения или добавь контекст к файлу... Скриншот можно вставить сюда через Ctrl+V" rows={5} /></div><label className={`file-dropzone ${fileName ? "has-file" : ""}`} htmlFor="assignment-file"><FileCheck2 size={19} /><span>{fileName || "Прикрепить разметку, PDF или видео"}</span><small>PNG, JPG, PDF, MP4 или WebM · до 10 МБ · или вставь скриншот через Ctrl+V в поле комментария</small><input id="assignment-file" type="file" accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => handleFileChange(event.target.files?.[0])} /></label>{fileError && <div className="file-error" role="alert">{fileError}</div>}{filePreviewUrl && <div className="assignment-preview"><div className="assignment-preview-heading"><span>ПРЕДПРОСМОТР</span><strong>{fileName}</strong></div>{fileType.startsWith("image/") && <div className="assignment-preview-image-wrap"><Image src={filePreviewUrl} alt={`Предпросмотр файла ${fileName}`} fill sizes="(max-width: 700px) 100vw, 420px" unoptimized className="assignment-preview-image" /></div>}{fileType === "application/pdf" && <iframe src={filePreviewUrl} title={`Предпросмотр PDF ${fileName}`} />}{fileType.startsWith("video/") && <video src={filePreviewUrl} controls preload="metadata" />}</div>}{(saved || submitted) && <div className="detail-feedback"><Target size={17} /><div><strong>{submitted ? "Работа отправлена куратору" : "Черновик сохранён в этой сессии"}</strong><p>{submitted ? "Ответ и вложение сохранены. Куратор увидит их в очереди проверки." : "Можно вернуться к заданию и продолжить подготовку ответа."}</p></div></div>}<div className="detail-actions"><button className="secondary-button" onClick={() => setSaved(true)} disabled={!draft.trim() && !fileName}>Сохранить черновик</button><button className="primary-button" onClick={() => setSubmitted(true)} disabled={!draft.trim() && !fileName}>Отправить на проверку <ChevronRight size={16} /></button></div></>}</div></section>;
}

function assignmentMaterialEmbed(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (/(^|\.)vimeo\.com$/i.test(parsed.hostname)) {
      const id = parsed.pathname.split("/").filter(Boolean).pop();
      const hash = parsed.searchParams.get("h");
      return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}${hash ? `?h=${encodeURIComponent(hash)}` : ""}` : null;
    }
    if (parsed.hostname === "www.youtube.com" && parsed.searchParams.get("v")) return `https://www.youtube.com/embed/${parsed.searchParams.get("v")}`;
    if (parsed.hostname === "youtu.be") return `https://www.youtube.com/embed${parsed.pathname}`;
  } catch {
    return null;
  }
  return null;
}

function AssignmentMaterials({ materials }: { materials: Assignment["materials"] }) {
  if (!materials || materials.length === 0) return null;
  return <section className="content-panel assignment-materials-panel"><div className="section-heading"><div><span className="section-kicker">МАТЕРИАЛ К ЗАДАНИЮ</span><h2>Перед началом работы</h2><p className="section-heading-note">Материалы, которые добавил куратор к этому заданию.</p></div></div><div className="assignment-materials-list">{materials.map((material) => { const url = material.url?.startsWith("http") ? material.url : material.url ? `${API_ORIGIN}${material.url}` : ""; const embedUrl = material.kind === "LINK" && material.url ? assignmentMaterialEmbed(material.url) : null; return <article className="assignment-material-card" key={material.id}><div className="assignment-material-card-head"><strong>{material.title}</strong><span>{material.kind === "LINK" ? "Ссылка" : material.mimeType ?? "Файл"}</span></div>{embedUrl && <iframe src={embedUrl} title={material.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}{!embedUrl && material.kind === "FILE" && material.mimeType?.startsWith("image/") && <div className="assignment-material-image"><Image src={url} alt={material.title} fill sizes="(max-width: 950px) 100vw, 50vw" unoptimized /></div>}{!embedUrl && material.kind === "FILE" && material.mimeType?.startsWith("video/") && <video src={url} controls preload="metadata" />}{!embedUrl && material.kind === "FILE" && material.mimeType === "application/pdf" && <iframe src={url} title={material.title} />}{!embedUrl && material.kind === "LINK" && <a className="secondary-button" href={material.url} target="_blank" rel="noreferrer">Открыть материал <ArrowUpRight size={15} /></a>}</article>; })}</div></section>;
}

function AssignmentModuleCover({ assignment }: { assignment: Assignment }) {
  const modulePosition = Number.parseInt(assignment.module.slice(0, 2), 10);
  const coverPath = assignment.coverPath ?? discussionCoverForModule(Number.isNaN(modulePosition) ? undefined : modulePosition);
  return <section className="content-panel assignment-module-cover-panel"><div className="assignment-module-cover" role="img" aria-label={`Обложка ${assignment.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(7,14,23,.94), rgba(7,14,23,.42)), url("${coverPath}")` }}><strong>{assignment.module}</strong><span>{assignment.lessonTitle ?? "Материал урока"}</span></div></section>;
}

function AssignmentDetail({ assignment }: { assignment: Assignment }) {
  return <div className="assignment-detail-stack">{assignment.id && <AssignmentModuleCover assignment={assignment} />}<AssignmentSubmissionSummary assignment={assignment} /><LegacyAssignmentDetail assignment={assignment} /><AssignmentMaterials materials={assignment.materials} /></div>;
}

function AssignmentSubmissionSummary({ assignment }: { assignment: Assignment }) {
  const submission = assignment.submission;
  if (!submission) return null;
  const history = assignment.submissionHistory?.length
    ? [...assignment.submissionHistory].sort((left, right) => left.attempt - right.attempt)
    : [{ attempt: submission.attempt, status: assignment.status, answerText: submission.answerText, submittedAt: submission.submittedAt, feedback: submission.feedback, files: submission.files }];
  return <section className={`content-panel assignment-history-card ${assignment.status === "Принято" ? "is-accepted" : assignment.status === "Нужна доработка" ? "needs-revision" : "is-pending"}`}>
    <div className="assignment-history-head"><div><span className="section-kicker">ИСТОРИЯ ОТВЕТА</span><h3>{assignment.status === "Принято" ? "Работа проверена" : assignment.status === "Нужна доработка" ? "Нужна доработка" : "Ответ отправлен"}</h3></div><span className="assignment-history-status">{formatAttemptCount(history.length)}</span></div>
    <div className="assignment-history-attempts">{history.map((attempt) => {
      const isCurrent = attempt.attempt === submission.attempt;
      const dotTone = attempt.status === "Принято" ? "done" : isCurrent ? "current" : "muted";
      return <div className="assignment-history-attempt" key={attempt.attempt}>
        <div className="assignment-history-attempt-head"><span className={`attempt-dot ${dotTone}`} /><strong>Попытка {attempt.attempt}{isCurrent ? " · текущая" : ""}</strong><span className="assignment-history-attempt-status">{attempt.status}</span></div>
        <div className="assignment-history-grid">
          <div><span className="detail-label">ТВОЙ ОТВЕТ</span><p>{attempt.answerText || "Ответ отправлен вложением."}</p>{attempt.submittedAt && <small>Отправлено {new Date(attempt.submittedAt).toLocaleString("ru-RU")}</small>}</div>
          {attempt.feedback.length > 0 && <div className="assignment-history-feedback"><span className="detail-label">ОТВЕТ КУРАТОРА</span>{attempt.feedback.map((item) => <p key={item.id}>{item.text}<br /><small>{new Date(item.createdAt).toLocaleString("ru-RU")}</small></p>)}</div>}
        </div>
      </div>;
    })}</div>
  </section>;
}

function EventCard({ event, onOpen }: { event: (typeof studentDashboard.events)[number]; onOpen?: () => void }) {
  return <div className={`event-card ${event.live ? "" : "muted-event"}`}><div className="event-date"><strong>{event.day}</strong><span>{event.month}</span></div><div className="event-info"><div className="event-type">{event.live && <span className="live-dot" />} {event.type}</div><h3>{event.title}</h3><p><Clock3 size={14} /> {event.time}</p></div><button className="event-action" aria-label={`Открыть событие: ${event.title}`} onClick={onOpen}><ArrowUpRight size={17} /></button></div>;
}
