"use client";

import { createContext, forwardRef, Fragment, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import { Room, RoomEvent, Track, VideoQuality, type RemoteTrackPublication } from "livekit-client";
import {
  AlertTriangle,
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
  Download,
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
  Pause,
  Play,
  Plus,
  Copy,
  Pencil,
  Radio,
  Volume2,
  VolumeX,
  RotateCcw,
  Save,
  Search,
  Trash2,
  UserPlus,
  ShieldCheck,
  MonitorSmartphone,
  Settings2,
  Sparkles,
  Target,
  TrendingUp,
  X,
} from "lucide-react";
import { curatorDashboard, type CuratorNav, type ReviewQueueItem } from "./data/curator-dashboard";
import { practicumModules, studentDashboard, type Assignment, type AssignmentStatus, type AssignmentTone, type DashboardNav, type PracticumModule, type PracticumSection, type ScheduleEvent, type StreamItem, type StreamKind } from "./data/student-dashboard";
import { calculatePracticumProgress } from "./domain/progress";
import { isDiscordUserId } from "./domain/discord";
import { EVENT_TIMEZONE, zonedTimeToUtc } from "./domain/schedule-time";
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
// The browser connects directly to the self-hosted LiveKit server (its own TLS/Caddy), bypassing
// the app's own nginx/proxy entirely — no path-rewrite story needed here, unlike Socket.IO above.
const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL?.trim() || "";
const ASSIGNMENT_TARGET_MODULE_KEY = "curator-assignment-target-module";
const OPEN_MODULE_AFTER_PUBLISH_KEY = "curator-open-module-after-publish";
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

/** A student's name as staff see it — Advanced-tier students get an orange name plus an "ADV"
 * tag, so a curator can tell at a glance whose ДЗ/message/card this is. Only staff views pass
 * `advanced`; students never see each other's tier. */
function StudentName({ name, advanced, className }: { name: string; advanced?: boolean; className?: string }) {
  return <strong className={[className, advanced ? "student-name-advanced" : ""].filter(Boolean).join(" ") || undefined}>{name}{advanced && <em className="adv-tag" title="Advanced">ADV</em>}</strong>;
}

function pluralizeStudents(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} ученик`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} ученика`;
  return `${count} учеников`;
}

function pluralizeLessons(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} урок`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} урока`;
  return `${count} уроков`;
}

function pluralizeMaterials(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} материал`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} материала`;
  return `${count} материалов`;
}

type UserRole = "student" | "curator";
type AppNav = DashboardNav | CuratorNav | "Профиль";
type DiscussionContext = { module: string; coverPath?: string | null; moduleId?: string; assignmentId?: string; practicumCompleted?: boolean };

// Identifies the current viewer on the on-screen video watermark (see TrackedVideo below).
const ViewerLabelContext = createContext<string>("");

/** Assigns one DOM node to several refs at once (a callback ref plus TrackedVideo's own internal ref). */
function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else (ref as { current: T | null }).current = node;
    }
  };
}

type LiveKitPlaybackProps = { token: string; roomName: string };

const QUALITY_OPTIONS: Array<{ value: VideoQuality | "auto"; label: string }> = [
  { value: "auto", label: "Авто" },
  { value: VideoQuality.HIGH, label: "Высокое (1440p)" },
  { value: VideoQuality.MEDIUM, label: "Среднее (720p)" },
  { value: VideoQuality.LOW, label: "Низкое (360p)" },
];

/**
 * The actual WebRTC connection for a LiveKit-backed <TrackedVideo>. Chrome/Safari block audio
 * autoplay without either a prior user gesture or starting muted — starts muted with a visible
 * "Включить звук" affordance rather than risk a silently-frozen player.
 *
 * `token` is read through a ref, not a effect dependency: the caller's status poll mints a fresh
 * JWT every ~15s (same viewer, same room, just a new token string), and reconnecting the whole
 * WebRTC peer connection on every poll tick caused a full drop/reconnect glitch every 15 seconds
 * in production — the intermittent audio stutter this was meant to fix. The room is connected
 * once per mount and just keeps using whichever token was current at that moment (it doesn't
 * expire mid-broadcast, see mintViewerToken's 6h ttl).
 *
 * `fullscreenRef` points at TrackedVideo's own outer wrapper (not a div local to this component)
 * so the watermark overlay — a sibling of this component, not a child — is included when
 * fullscreened; requesting fullscreen on just the <video> would leave it behind.
 */
type FullscreenCapableElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenCapableDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type LockableOrientation = ScreenOrientation & { lock?: (orientation: "landscape") => Promise<void> };

function nativeFullscreenElement(): Element | null {
  const doc = document as FullscreenCapableDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/**
 * Fullscreen for a video wrapper that also works on iPhone. iOS Safari has no Fullscreen API for
 * arbitrary elements (only <video>.webkitEnterFullscreen, which would drop our watermark and
 * custom controls), so the button used to do nothing there and the page kept scrolling. Where the
 * real API exists (desktop, Android, iPad) it's used as before, plus a best-effort landscape lock
 * on phones; otherwise the wrapper gets a CSS "pseudo-fullscreen" class (fixed, covers the
 * viewport) and the page underneath is scroll-locked until exit.
 */
function useVideoFullscreen(ref: RefObject<HTMLDivElement | null>) {
  const [native, setNative] = useState(false);
  const [pseudo, setPseudo] = useState(false);

  useEffect(() => {
    const handleChange = () => {
      const active = nativeFullscreenElement() === ref.current;
      setNative(active);
      if (!active) (screen.orientation as LockableOrientation | undefined)?.unlock?.();
    };
    document.addEventListener("fullscreenchange", handleChange);
    document.addEventListener("webkitfullscreenchange", handleChange);
    return () => { document.removeEventListener("fullscreenchange", handleChange); document.removeEventListener("webkitfullscreenchange", handleChange); };
  }, [ref]);

  useEffect(() => {
    const element = ref.current;
    if (!pseudo || !element) return;
    element.classList.add("is-pseudo-fullscreen");
    document.documentElement.classList.add("pseudo-fullscreen-lock");
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setPseudo(false); };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      element.classList.remove("is-pseudo-fullscreen");
      document.documentElement.classList.remove("pseudo-fullscreen-lock");
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [pseudo, ref]);

  const exit = () => {
    if (pseudo) { setPseudo(false); return; }
    const doc = document as FullscreenCapableDocument;
    if (!nativeFullscreenElement()) return;
    if (doc.exitFullscreen) void doc.exitFullscreen().catch(() => undefined);
    else void doc.webkitExitFullscreen?.();
  };

  const enter = () => {
    const element = ref.current as FullscreenCapableElement | null;
    if (!element) return;
    const request = element.requestFullscreen ? () => element.requestFullscreen() : element.webkitRequestFullscreen ? () => Promise.resolve(element.webkitRequestFullscreen!()) : null;
    if (!request) { setPseudo(true); return; }
    void request()
      // Phones only — desktop browsers reject the lock, which is fine to ignore.
      .then(() => (screen.orientation as LockableOrientation | undefined)?.lock?.("landscape").catch(() => undefined))
      .catch(() => setPseudo(true));
  };

  const fullscreen = native || pseudo;
  return { fullscreen, toggle: () => (fullscreen ? exit() : enter()), exit };
}

const VOLUME_KEY = "fix-volume";

/** Last volume the viewer picked (0..1), shared by the live and recording players. */
function readSavedVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    const saved = raw === null ? NaN : Number(raw);
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 1;
  } catch {
    return 1;
  }
}

function saveVolume(volume: number) {
  try { window.localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* private mode — just not remembered */ }
}

/**
 * Volume slider next to the mute button (added 2026-10-04 — before, sound was only on/off).
 * Dragging up from zero unmutes, dragging to zero mutes. On iPhone/iPad the browser ignores
 * page volume (hardware buttons only), so there it simply has no effect.
 */
function VolumeSlider({ volume, muted, onChange }: { volume: number; muted: boolean; onChange: (volume: number) => void }) {
  const shown = muted ? 0 : volume;
  return <input
    type="range"
    className="video-volume-slider"
    min={0}
    max={1}
    step={0.05}
    value={shown}
    onChange={(event) => onChange(Number(event.target.value))}
    aria-label={`Громкость: ${Math.round(shown * 100)}%`}
    title={`Громкость: ${Math.round(shown * 100)}%`}
    style={{ "--volume-fill": `${Math.round(shown * 100)}%` } as CSSProperties}
  />;
}

function LiveKitVideoSurface({ token, roomName, fullscreenRef }: LiveKitPlaybackProps & { fullscreenRef: RefObject<HTMLDivElement | null> }) {
  const videoElRef = useRef<HTMLVideoElement>(null);
  const videoPublicationRef = useRef<RemoteTrackPublication | null>(null);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(() => (typeof window === "undefined" ? 1 : readSavedVolume()));
  const volumeRef = useRef(volume);
  const { fullscreen, toggle: toggleFullscreen } = useVideoFullscreen(fullscreenRef);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [quality, setQuality] = useState<VideoQuality | "auto">("auto");
  const tokenRef = useRef(token);
  useEffect(() => { tokenRef.current = token; }, [token]);
  // livekit-client's own attach() forces element.muted = (no audio track yet) every time it
  // (re)builds the element's srcObject — see attachToElement() in livekit-client. That fires once
  // per subscribed track (video, then audio, arrival order isn't guaranteed), so whichever one
  // attaches once BOTH are present always snaps the element back to unmuted behind React's back —
  // the mute button and the actual audio state silently disagree until the viewer happens to
  // toggle it twice. Track the desired state in a ref (not a TrackSubscribed dependency, so the
  // listener doesn't need to be re-registered on every toggle) and reassert it after each attach.
  const mutedRef = useRef(muted);
  useEffect(() => { mutedRef.current = muted; }, [muted]);

  useEffect(() => {
    // adaptiveStream: pick a resolution matching this <video>'s actual rendered size instead of
    // always pulling the full 720p layer — less bandwidth/CPU pressure on the viewer, which is
    // also where audio stutter under constrained connections tends to come from.
    // dynacast: stop encoding simulcast layers nobody is currently watching (saves the curator's
    // upload bandwidth too).
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.TrackSubscribed, (track, publication) => {
      if (track.kind === Track.Kind.Video) videoPublicationRef.current = publication;
      if ((track.kind === Track.Kind.Video || track.kind === Track.Kind.Audio) && videoElRef.current) {
        track.attach(videoElRef.current);
        // Undo attachToElement's own muted heuristic (see mutedRef comment above) so the element
        // always matches what the mute button is actually showing.
        videoElRef.current.muted = mutedRef.current;
        videoElRef.current.volume = volumeRef.current;
      }
    });
    void room.connect(LIVEKIT_URL, tokenRef.current).catch((error: unknown) => console.error("LiveKit connect failed", error));
    return () => { void room.disconnect(); };
  }, [roomName]);

  // Separate from the one-shot "Включить звук" overlay above (which exists only to satisfy the
  // browser's unmuted-autoplay gesture requirement) — this is the ongoing toggle a curator uses to
  // mute their own broadcast's playback mid-stream (avoiding mic/speaker feedback) while still
  // watching the video and reading chat, then unmute again without needing to reload anything.
  const toggleMute = () => {
    const video = videoElRef.current;
    if (!video) return;
    video.muted = !video.muted;
    // Unmuting from a slider left at zero would still be silent — bring it back to audible.
    if (!video.muted && video.volume === 0) { video.volume = 0.5; volumeRef.current = 0.5; setVolume(0.5); saveVolume(0.5); }
    setMuted(video.muted);
  };
  const changeVolume = (next: number) => {
    const video = videoElRef.current;
    volumeRef.current = next;
    setVolume(next);
    saveVolume(next);
    if (!video) return;
    video.volume = next;
    const nextMuted = next === 0;
    if (video.muted !== nextMuted) { video.muted = nextMuted; setMuted(nextMuted); }
  };

  // "Авто" hands control back to adaptiveStream's own resize-driven quality selection; picking a
  // specific tier sets an explicit ceiling (still capped further by real bandwidth if needed).
  // adaptiveStream may re-assert itself on the next resize/visibility change — this is a
  // best-effort override, not a hard lock, since livekit-client exposes no "disable adaptiveStream
  // for this one track" toggle short of reconnecting the whole room.
  const selectQuality = (next: VideoQuality | "auto") => {
    setQuality(next);
    setQualityMenuOpen(false);
    videoPublicationRef.current?.setVideoQuality(next === "auto" ? VideoQuality.HIGH : next);
  };

  return <>
    <video ref={videoElRef} autoPlay playsInline muted={muted} />
    {muted && (
      <button type="button" className="tracked-video-unmute" onClick={() => { setMuted(false); if (videoElRef.current) videoElRef.current.muted = false; }}>
        Включить звук
      </button>
    )}
    <div className="livekit-video-controls">
      <div className="livekit-quality-menu">
        <button type="button" className="livekit-video-control-button" aria-label="Качество" onClick={() => setQualityMenuOpen((current) => !current)}><Settings2 size={15} /></button>
        {qualityMenuOpen && <div className="livekit-quality-options" role="menu">
          {QUALITY_OPTIONS.map((option) => <button type="button" key={option.label} role="menuitemradio" aria-checked={quality === option.value} className={quality === option.value ? "active" : ""} onClick={() => selectQuality(option.value)}>{option.label}</button>)}
        </div>}
      </div>
      <div className="video-volume-group"><button type="button" className="livekit-video-control-button" aria-label={muted ? "Включить звук" : "Выключить звук"} onClick={toggleMute}>{muted ? <VolumeX size={15} /> : <Volume2 size={15} />}</button><VolumeSlider volume={volume} muted={muted} onChange={changeVolume} /></div>
      <button type="button" className="livekit-video-control-button" aria-label={fullscreen ? "Свернуть" : "На весь экран"} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
    </div>
  </>;
}

function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * A recorded LiveKit broadcast, played back with our own minimal controls instead of the
 * browser's native `<video controls>` bar — deliberately narrower than the native set (no
 * download, no picture-in-picture) to keep the player visually quiet and consistent with the rest
 * of the UI. Playback speed was added 2026-10-03 at students' request for rewatching (Vimeo
 * embeds have their own speed control).
 */
const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;
const PLAYBACK_RATE_KEY = "fix-playback-rate";

/** Where a student stopped in a recording, per recording URL — see RecordedVideoSurface. */
function positionKey(src: string): string {
  return `fix-video-pos:${src}`;
}

function readSavedPosition(src: string): number {
  try {
    const saved = Number(window.localStorage.getItem(positionKey(src)));
    return Number.isFinite(saved) && saved > 0 ? saved : 0;
  } catch {
    return 0;
  }
}

function readSavedPlaybackRate(): number {
  try {
    const saved = Number(window.localStorage.getItem(PLAYBACK_RATE_KEY));
    return (PLAYBACK_RATES as readonly number[]).includes(saved) ? saved : 1;
  } catch {
    return 1;
  }
}
/**
 * Which recording player the keyboard controls — the one last clicked/played. A lesson page can
 * hold several recordings, and only one should react to an arrow key.
 */
let activeRecordedPlayer: symbol | null = null;

/** Keystrokes meant for a text field (chat, ДЗ answer, search…) never reach the player. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "submit", "reset", "file", "color", "image"].includes(type);
}

function RecordedVideoSurface({ src, fullscreenRef }: { src: string; fullscreenRef: RefObject<HTMLDivElement | null> }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // YouTube-style keys (asked for by students 2026-10-04): ←/→ ±5 s, space play/pause, M mute,
  // F fullscreen — for the player last interacted with, and never while typing in a text field.
  const playerId = useRef(Symbol("recorded-player"));
  const [keyHint, setKeyHint] = useState<{ text: string; at: number } | null>(null);
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => undefined);
  useEffect(() => {
    const id = playerId.current;
    if (activeRecordedPlayer === null) activeRecordedPlayer = id;
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => {
      window.removeEventListener("keydown", listener);
      if (activeRecordedPlayer === id) activeRecordedPlayer = null;
    };
  }, []);
  useEffect(() => {
    if (!keyHint) return;
    const timer = window.setTimeout(() => setKeyHint((current) => (current?.at === keyHint.at ? null : current)), 700);
    return () => window.clearTimeout(timer);
  }, [keyHint]);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(() => (typeof window === "undefined" ? 1 : readSavedVolume()));
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // A click on the seek bar before the recording's length is known (stream recordings are large
  // MP4s with their index at the end, so this can take a few seconds) used to be silently ignored —
  // "I click on minute 20 and nothing happens" (2026-10-04). Remember it and apply on load.
  const pendingSeekRef = useRef<number | null>(null);
  const [seekPending, setSeekPending] = useState(false);
  // Resume where the student stopped last time (saved every few seconds while playing).
  const lastSavedRef = useRef(0);
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  // Remembered per browser, so the next recording starts at the speed the student last picked.
  const [playbackRate, setPlaybackRate] = useState(() => (typeof window === "undefined" ? 1 : readSavedPlaybackRate()));
  const { fullscreen, toggle: toggleFullscreen } = useVideoFullscreen(fullscreenRef);
  const applyPlaybackRate = (rate: number) => {
    const video = videoRef.current;
    if (!video) return;
    // defaultPlaybackRate too — the browser resets playbackRate to it whenever the source reloads.
    video.defaultPlaybackRate = rate;
    video.playbackRate = rate;
  };
  const cyclePlaybackRate = () => {
    const next = PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(playbackRate as (typeof PLAYBACK_RATES)[number]) + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
    applyPlaybackRate(next);
    try { window.localStorage.setItem(PLAYBACK_RATE_KEY, String(next)); } catch { /* private mode — speed just isn't remembered */ }
  };

  const togglePlay = () => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play(); else video.pause(); };
  // A click is play/pause in fullscreen too, like YouTube — it used to exit fullscreen, which
  // students kept doing by accident when they only wanted to pause (2026-10-06). Double-click
  // toggles fullscreen; the control-bar button and Escape still exit.
  const handleVideoClick = () => togglePlay();
  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) { video.volume = 0.5; setVolume(0.5); saveVolume(0.5); }
    setMuted(video.muted);
  };
  const changeVolume = (next: number) => {
    const video = videoRef.current;
    setVolume(next);
    saveVolume(next);
    if (!video) return;
    video.volume = next;
    const nextMuted = next === 0;
    if (video.muted !== nextMuted) { video.muted = nextMuted; setMuted(nextMuted); }
  };
  const seekTo = (event: ReactMouseEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setResumedFrom(null);
    if (duration && Number.isFinite(duration)) {
      video.currentTime = fraction * duration;
      // Paused video fires no timeupdate, so the time label and progress bar used to stay at 0:00
      // after a click — the seek had happened, it just looked like it hadn't.
      setCurrentTime(fraction * duration);
      return;
    }
    pendingSeekRef.current = fraction;
    setSeekPending(true);
    video.preload = "auto";
    if (video.readyState === 0) video.load();
  };
  const handleLoadedMetadata = (video: HTMLVideoElement) => {
    setDuration(video.duration);
    applyPlaybackRate(playbackRate);
    video.volume = volume;
    if (pendingSeekRef.current !== null) {
      video.currentTime = pendingSeekRef.current * video.duration;
      setCurrentTime(pendingSeekRef.current * video.duration);
      pendingSeekRef.current = null;
      setSeekPending(false);
      return;
    }
    // Pick up where they left off — unless that was the very start or the very end.
    const saved = readSavedPosition(src);
    if (saved > 30 && saved < video.duration - 30) {
      video.currentTime = saved;
      setCurrentTime(saved);
      setResumedFrom(saved);
    }
  };
  const handleTimeUpdate = (video: HTMLVideoElement) => {
    setCurrentTime(video.currentTime);
    if (Math.abs(video.currentTime - lastSavedRef.current) < 5) return;
    lastSavedRef.current = video.currentTime;
    try { window.localStorage.setItem(positionKey(src), String(Math.floor(video.currentTime))); } catch { /* private mode */ }
  };
  const restartFromBeginning = () => {
    const video = videoRef.current;
    if (video) video.currentTime = 0;
    setResumedFrom(null);
  };

  const handleKey = (event: KeyboardEvent) => {
    const video = videoRef.current;
    if (!video || activeRecordedPlayer !== playerId.current) return;
    if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
    const showHint = (text: string) => setKeyHint({ text, at: Date.now() });
    const key = event.key.toLowerCase();
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const delta = event.key === "ArrowLeft" ? -5 : 5;
      const limit = Number.isFinite(video.duration) ? video.duration : Infinity;
      const next = Math.min(limit, Math.max(0, video.currentTime + delta));
      video.currentTime = next;
      setCurrentTime(next);
      setResumedFrom(null);
      showHint(delta < 0 ? "−5 с" : "+5 с");
    } else if (event.key === " " || key === "k" || key === "л") {
      // Space on a focused button would also "click" it — handle it here once instead.
      event.preventDefault();
      showHint(video.paused ? "▶" : "❚❚");
      togglePlay();
    } else if (key === "m" || key === "ь") {
      toggleMute();
      showHint(video.muted ? "Звук выкл" : "Звук вкл");
    } else if (key === "f" || key === "а") {
      toggleFullscreen();
    }
  };
  const claimKeyboard = () => { activeRecordedPlayer = playerId.current; };
  // Latest-handler ref: the window listener (registered once) always calls this render's handler.
  useEffect(() => { keyHandlerRef.current = handleKey; });

  return <div className="recorded-video-surface" onPointerDown={claimKeyboard} onFocusCapture={claimKeyboard} title="Клавиши: ← → — 5 секунд назад/вперёд, пробел — пауза, M — звук, F — весь экран">
    {keyHint && <div className="recorded-video-key-hint" key={keyHint.at}>{keyHint.text}</div>}
    <video
      ref={videoRef}
      src={src}
      playsInline
      onClick={handleVideoClick}
      onDoubleClick={toggleFullscreen}
      onPlay={() => { setPlaying(true); claimKeyboard(); }}
      onPause={() => setPlaying(false)}
      onTimeUpdate={(event) => handleTimeUpdate(event.currentTarget)}
      onSeeked={(event) => setCurrentTime(event.currentTarget.currentTime)}
      onLoadedMetadata={(event) => handleLoadedMetadata(event.currentTarget)}
    />
    {resumedFrom !== null && <div className="recorded-video-resume">Продолжаем с {formatVideoTime(resumedFrom)} · <button type="button" onClick={restartFromBeginning}>С начала</button></div>}
    <div className="recorded-video-controls">
      <button type="button" onClick={togglePlay} aria-label={playing ? "Пауза" : "Воспроизвести"}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
      <span className="recorded-video-time">{seekPending ? "Загрузка…" : `${formatVideoTime(currentTime)} / ${formatVideoTime(duration)}`}</span>
      <div className="recorded-video-seek" onClick={seekTo}><i style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} /></div>
      <button type="button" className="recorded-video-speed" onClick={cyclePlaybackRate} aria-label={`Скорость воспроизведения: ${playbackRate}x. Нажмите, чтобы изменить`} title="Скорость воспроизведения">{String(playbackRate).replace(".", ",")}x</button>
      <div className="video-volume-group"><button type="button" onClick={toggleMute} aria-label={muted ? "Включить звук" : "Выключить звук"}>{muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button><VolumeSlider volume={volume} muted={muted} onChange={changeVolume} /></div>
      <button type="button" onClick={toggleFullscreen} aria-label={fullscreen ? "Свернуть" : "На весь экран"}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
    </div>
  </div>;
}

/**
 * Drop-in replacement for a plain video <iframe>: overlays the viewer's name and a live
 * clock on top of the player (deters casual screen-recording redistribution — a frozen
 * screenshot still carries a real, current timestamp) and logs the open server-side via
 * `mediaId` so a leaked recording can be traced back to who actually opened it and when.
 * Pass either `src` (recorded media: Vimeo embed or our own recording route) or `livekit` (live broadcast) —
 * never both. Sizing is intentionally generic (fills its container) so it drops into any
 * existing video-stage CSS unchanged.
 */
const TrackedVideo = forwardRef<HTMLDivElement, { mediaId?: string | null; src?: string; livekit?: LiveKitPlaybackProps | null; title: string; className?: string }>(
  function TrackedVideo({ mediaId, src, livekit, title, className = "" }, forwardedRef) {
    const viewerLabel = useContext(ViewerLabelContext);
    const [clock, setClock] = useState(() => new Date().toLocaleString("ru-RU"));
    const loggedMediaId = useRef<string | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      const timer = window.setInterval(() => setClock(new Date().toLocaleString("ru-RU")), 5_000);
      return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
      if (!mediaId || loggedMediaId.current === mediaId) return;
      loggedMediaId.current = mediaId;
      void fetch(`${API_ORIGIN}/api/course/media/${mediaId}/access`, { method: "POST", credentials: "include" }).catch(() => undefined);
    }, [mediaId]);

    // wrapperRef (not the iframe/video) is what gets fullscreened, so requesting fullscreen
    // still shows the watermark overlay instead of leaving it behind — also merged onto
    // forwardedRef so a future caller that actually passes a ref still gets the DOM node.
    // Our own recorded-media redirect route (see streams.controller.ts) resolves to a raw video
    // file, unlike Vimeo's `src` which is an actual embed-player page — loading a raw
    // file in an <iframe> makes the browser render its own native "media document" viewer, whose
    // built-in controls include a Download option and (being cross-origin, after the redirect)
    // an unreliable fullscreen button. A same-origin <video> avoids both: controlsList hides the
    // download affordance, and fullscreen on an element in our own document just works.
    return <div className={`tracked-video ${className}`} ref={mergeRefs(wrapperRef, forwardedRef)}>
      {livekit
        ? <LiveKitVideoSurface key={livekit.roomName} token={livekit.token} roomName={livekit.roomName} fullscreenRef={wrapperRef} />
        : src?.startsWith("/api/streams/recordings/")
          ? <RecordedVideoSurface src={src} fullscreenRef={wrapperRef} />
          : <iframe src={src} title={title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
      {viewerLabel && <div className="tracked-video-watermark" aria-hidden="true"><span>{viewerLabel}</span><span>{clock}</span></div>}
    </div>;
  },
);

type AppNotification = {
  id: string;
  type: "NEW_ASSIGNMENT" | "NEW_SUBMISSION" | "NEW_MEDIA" | "NEW_EVENT" | "NEW_MODULE" | "MODULE_OPENED" | "DISCUSSION_REPLY" | "REVIEW_DECISION" | "STREAM_LIVE" | "SCHEDULE_REMINDER" | "SECURITY_ALERT" | "CURATOR_REMINDER";
  title: string;
  body: string | null;
  entityId: string | null;
  read: boolean;
  createdAt: string;
};

// Keep in sync with the NotificationType enum in prisma/schema.prisma. A value missing here used
// to crash the whole bell popover (NOTIFICATION_ICON[item.type] resolved to undefined, then
// `.icon` threw) for every notification list that happened to include it — openNotification()
// below falls back to a default entry now, but keeping this in sync is still what keeps the icon
// and tone meaningful instead of the fallback.
const DEFAULT_NOTIFICATION_ICON = { icon: Bell, tone: "blue" };
export const NOTIFICATION_ICON: Record<AppNotification["type"], { icon: typeof Bell; tone: string }> = {
  NEW_ASSIGNMENT: { icon: FileCheck2, tone: "blue" },
  NEW_SUBMISSION: { icon: FileCheck2, tone: "amber" },
  NEW_MEDIA: { icon: Play, tone: "blue" },
  NEW_EVENT: { icon: CalendarDays, tone: "amber" },
  NEW_MODULE: { icon: BookOpen, tone: "blue" },
  MODULE_OPENED: { icon: GraduationCap, tone: "amber" },
  DISCUSSION_REPLY: { icon: MessageSquareText, tone: "blue" },
  REVIEW_DECISION: { icon: CheckCircle2, tone: "amber" },
  STREAM_LIVE: { icon: Radio, tone: "amber" },
  SCHEDULE_REMINDER: { icon: Clock3, tone: "amber" },
  SECURITY_ALERT: { icon: ShieldCheck, tone: "red" },
  CURATOR_REMINDER: { icon: TrendingUp, tone: "amber" },
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
  workingPracticumId: string | null;
  profile: {
    email: string | null;
    emailVerifiedAt: string | null;
    timeZone?: string | null;
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

type CourseLessonMedia = {
  id: string;
  scheduleEventId?: string | null;
  groupId?: string | null;
  provider: string;
  kind: "LESSON_VIDEO" | "STREAM" | "QA" | "BREAKDOWN" | "TALKS";
  // Independent of kind — see the schema comment on MediaAudience. Who can see this recording,
  // not what it is.
  audience: "ALL" | "ADVANCED";
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  title: string | null;
  description: string | null;
  durationSec: number | null;
  byteSize: number | null;
  position: number;
  libraryPosition: number;
  publishedAt: string | null;
  createdAt: string;
  embedUrl: string | null;
  thumbnailUrl: string | null;
};

type CourseAssignmentSummary = {
  id: string;
  title: string;
  description: string;
  requirements: string[];
  allowedFormats: string[];
  deadline: string | null;
  materials: NonNullable<Assignment["materials"]>;
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
  media: CourseLessonMedia[];
  mediaGroups: CourseMediaGroup[];
  assignments: CourseAssignmentSummary[];
  qaQuestions: string[];
};

// Curator-named section inside a lesson ("Бектест", "Пресессия"...) — see MediaGroup and the
// Практика "Блоки урока" picker. Теория modules always have an empty array here.
type CourseMediaGroup = { id: string; title: string; position: number; media: CourseLessonMedia[] };

type CourseModule = PracticumModule & { position: number; coverPath: string | null };

type CourseScheduleEvent = { id: string; type: "PRACTICE" | "QA" | "BREAKDOWN" | "BACKTEST" | "LECTURE" | "PRE_SESSION"; title: string; date: string; time: string; description: string; live: boolean; coverPath: string | null; recordingAvailable: boolean; recordings: Array<CourseLessonMedia>; bookedByStudentId: string | null; bookedByStudentName: string | null; isBookedByActor: boolean; slotLimit: number | null; streamEndedAt?: string | null };
type CourseApiPayload = { data?: { modules?: CourseApiModule[]; media?: CourseLessonMedia[]; scheduleEvents?: CourseScheduleEvent[]; isAdvanced?: boolean; practicumCompleted?: boolean } };

type CourseState = {
  modules: readonly CourseModule[];
  contentByModule: Readonly<Record<string, CourseApiModule>>;
  globalMedia: CourseLessonMedia[];
  scheduleEvents: CourseScheduleEvent[];
  // Whether the current viewer can see the "Advanced" track/filters at all — always true for a
  // curator/owner (see course-service.ts#getForUser), only true for a student granted the tier.
  isAdvanced: boolean;
  // "Завершить поток" — read access (below) is untouched; this only tells the UI to hide the ДЗ
  // submission form/"Выполнено" button and the discussion compose box. Always false for
  // curator/owner. See course-service.ts#getForUser.
  practicumCompleted: boolean;
};

// A block-layout lesson (its own named record folders instead of the fixed
// stream/homework/Q&A template) — Практика and Advanced share the exact same editor/viewer
// layout, see CuratorLessonPage and ModuleOverviewPage.
function isBlockLayoutSection(section: string): boolean {
  return section === "Practice" || section === "Advanced";
}

// Теория, Практика and Advanced each get their own 00, 01, 02… display numbering, independent
// of the others — Module.position itself stays one shared sequence per practicum (that's what
// actually drives unlock order), this only overrides the number shown to curator/student.
function withTrackNumbers<T extends { section: string; number: string }>(items: readonly T[]): T[] {
  let theoryIndex = 0;
  let practiceIndex = 0;
  let advancedIndex = 0;
  return items.map((item) => {
    const index = item.section === "Practice" ? practiceIndex++ : item.section === "Advanced" ? advancedIndex++ : theoryIndex++;
    return { ...item, number: String(index).padStart(2, "0") };
  });
}

function normalizeCourse(payload: CourseApiPayload): CourseState | null {
  const records = payload.data?.modules;
  if (!Array.isArray(records) || records.length === 0) return null;
  const modules = withTrackNumbers(records.map((module): CourseModule => ({
    id: module.id,
    section: ["Welcome", "Education", "Q&A", "Practice", "Advanced"].includes(module.section) ? module.section as PracticumSection : "Education",
    number: module.number,
    title: module.title,
    status: module.status,
    progress: module.progress,
    lessons: module.media.length + module.assignments.length,
    description: module.description ?? "",
    locked: module.locked,
    position: module.position,
    coverPath: module.coverPath,
  })));
  const contentByModule = Object.fromEntries(records.map((module) => [module.id, module]));
  return { modules, contentByModule, globalMedia: payload.data?.media ?? [], scheduleEvents: payload.data?.scheduleEvents ?? [], isAdvanced: payload.data?.isAdvanced ?? false, practicumCompleted: payload.data?.practicumCompleted ?? false };
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds < 1) return "Видео";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${remainingSeconds}` : `${minutes}:${remainingSeconds}`;
}

function formatFileSize(bytes: number | null): string {
  if (!bytes || bytes < 1) return "";
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} ГБ`;
  const mb = bytes / 1_000_000;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} МБ`;
}

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
  { label: "Прогресс", icon: TrendingUp },
  { label: "Программа", icon: BookOpen },
  { label: "Приглашения", icon: UserPlus },
  { label: "Расписание", icon: CalendarDays },
  { label: "Стримы", icon: Radio },
  { label: "Медиатека", icon: Play },
  { label: "Обсуждения", icon: MessageSquareText },
  { label: "Команда", icon: ShieldCheck },
];

// What each section is called in the address bar (`?tab=…`). Short Latin slugs instead of the
// Cyrillic UI labels, so a copied link reads `?tab=schedule` rather than `%D0%A0%D0%B0…`. The
// UI labels themselves are unchanged; this is only the URL spelling. Covers every value
// activeNav can hold: sidebar items plus the destinations reached only programmatically
// ("Профиль", the student's "Обзор" landing).
const NAV_SLUGS: Record<AppNav, string> = {
  "Мой практикум": "practicum",
  "Задания": "tasks",
  "Расписание": "schedule",
  "Стрим": "stream",
  "Записи": "recordings",
  "Обсуждение": "discussion",
  "Кабинет куратора": "curator",
  "Очередь проверки": "review",
  "Создать задание": "new-task",
  "Ученики": "students",
  "Прогресс": "progress",
  "Программа": "program",
  "Приглашения": "invitations",
  "Стримы": "streams",
  "Медиатека": "media",
  "Обсуждения": "discussions",
  "Команда": "team",
  "Профиль": "profile",
  "Обзор": "overview",
};
const NAV_BY_SLUG = new Map<string, AppNav>((Object.keys(NAV_SLUGS) as AppNav[]).map((nav) => [NAV_SLUGS[nav], nav]));
function navToSlug(nav: AppNav): string {
  return NAV_SLUGS[nav];
}
// Resolves a `?tab=` value back to a section. Accepts the slug, and also the old Cyrillic
// label so links/bookmarks saved before the slugs existed keep working. Anything else (a
// hand-edited or stale URL) is ignored rather than trusted.
function navFromTabParam(value: string): AppNav | null {
  const bySlug = NAV_BY_SLUG.get(value);
  if (bySlug) return bySlug;
  return value in NAV_SLUGS ? (value as AppNav) : null;
}

// useSearchParams() (used below to sync activeNav with a `?tab=` URL param, so Back/Forward
// walk through in-app tabs — see the comment above that effect) requires a Suspense boundary
// around whatever calls it, or Next's build fails prerendering "/" with a CSR-bailout error.
export default function Home() {
  return <Suspense fallback={null}><HomeContent /></Suspense>;
}

function HomeContent() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [sessionProfile, setSessionProfile] = useState<SessionProfile | null>(null);
  const [role, setRole] = useState<UserRole>("student");
  // Everyone (students and, since 2026-10-03, curators — they live in different countries too)
  // sees schedule times in their own zone: Профиль choice, else the browser's. Events are still
  // stored in Kyiv time; curators' form input is converted back (see CuratorScheduleView#saveEvent).
  // Set during render, before children fetch the schedule.
  setViewerTimeZone(sessionProfile ? (sessionProfile.profile.timeZone || browserTimeZone()) : null);
  // Curator-only: which practicum's title to show next to the breadcrumb, so a curator never has
  // to guess or remember where new content is actually landing — see PracticumManagerCard for the
  // same "workingPracticumId set → that one, else the active one" resolution done server-side.
  const [headerPracticums, setHeaderPracticums] = useState<PracticumSummary[]>([]);
  // Global "private stream" switch — hides "Стрим"/"Стримы" from a student's own nav (see
  // getPlaybackStatus for the actual access gate, which doesn't depend on this client-side
  // value at all). Needed for both roles: students to filter their own nav, curators/owners to
  // show the toggle's current state.
  const [streamsPrivate, setStreamsPrivateState] = useState(false);
  const [activeNav, setActiveNav] = useState<AppNav>("Мой практикум");
  // The sidebar tabs never changed the URL, so the browser's Back button had nothing of
  // ours to step through — it jumped straight past the whole app to whatever page the user
  // was on before. Mirroring activeNav into a `?tab=` query param (through Next's own
  // router, not raw history.pushState — App Router owns popstate itself and a foreign
  // history.state shape makes it fall back to a full reload) gives Back something to walk
  // through first, and only leaves the site once that's exhausted.
  //
  // The two effects below are deliberately one-directional and gate on a single ref rather
  // than cross-comparing activeNav against searchParams: a URL change (Back/Forward) updates
  // both in the same render pass, but only ONE of React's state updates (activeNav) has
  // landed by the time the other effect re-runs — comparing the fresh searchParams against
  // the still-stale activeNav in that window reads as "out of sync" and pushes right back to
  // where we just navigated away from. lastSyncedNavRef always holds the nav value already
  // reflected in the URL, updated by whichever effect acts first, so the other one sees
  // "already in sync" and no-ops instead of fighting it.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const hasSeededNavUrlRef = useRef(false);
  const lastSyncedNavRef = useRef<AppNav | null>(null);
  useEffect(() => {
    // Before sign-in there is no section to remember, and the very first address a new
    // student sees should be the bare domain — so the URL is only touched once authenticated.
    if (authenticated !== true) return;
    if (activeNav === lastSyncedNavRef.current) return;
    lastSyncedNavRef.current = activeNav;
    const params = new URLSearchParams(window.location.search);
    params.set("tab", navToSlug(activeNav));
    const url = `${pathname}?${params.toString()}`;
    if (!hasSeededNavUrlRef.current) {
      hasSeededNavUrlRef.current = true;
      router.replace(url, { scroll: false });
    } else {
      router.push(url, { scroll: false });
    }
  }, [activeNav, authenticated, pathname, router]);
  useEffect(() => {
    const tab = searchParams.get("tab");
    const nav = tab ? navFromTabParam(tab) : null;
    if (!nav || nav === lastSyncedNavRef.current) return;
    lastSyncedNavRef.current = nav;
    setActiveNav(nav);
  }, [searchParams]);
  const [requestedAssignmentId, setRequestedAssignmentId] = useState("");
  const [requestedDiscussionContext, setRequestedDiscussionContext] = useState<DiscussionContext | null>(null);
  const [requestedStudentId, setRequestedStudentId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const notificationWrapRef = useRef<HTMLDivElement>(null);
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [pendingDiscussionCount, setPendingDiscussionCount] = useState(0);
  const [pendingReviewCount, setPendingReviewCount] = useState(0);
  const [revisionAssignmentIds, setRevisionAssignmentIds] = useState<string[]>([]);
  const [seenRevisionIds, setSeenRevisionIds] = useState<Set<string>>(new Set());
  const pendingRevisionCount = revisionAssignmentIds.filter((id) => !seenRevisionIds.has(id)).length;
  const [unlockedModuleIds] = useState(() => new Set(practicumModules.filter((module) => !module.locked).map((module) => module.id)));
  // Same "unread count next to the tab" pattern as "Задания" (revision count), reusing the
  // notification bell's already-fetched list instead of polling separately. Student side:
  // "Обсуждение" counts unread DISCUSSION_REPLY, "Записи" counts NEW_MEDIA, "Расписание"
  // counts NEW_EVENT. Curator side: "Расписание" counts SCHEDULE_REMINDER — the only
  // notification type the backend ever sends to curators (stream-live-notifier and
  // course-service's NEW_MEDIA/NEW_EVENT broadcasts are student-only; a curator's own
  // "Обсуждения"/"Очередь проверки" badges above already use their own dedicated polls,
  // not the notification feed). Clearing happens on tab visit, same as "Задания" below.
  const unreadNotificationsByType = (type: AppNotification["type"]) => notifications.filter((notification) => notification.type === type && !notification.read).length;
  const isOwner = sessionProfile?.role === "OWNER";
  // Same fallback as getWorkingPracticumId server-side: personal pick if set, else whichever
  // practicum is active — so this always names where a curator's next click actually lands.
  const headerPracticumTitle = role === "curator"
    ? (headerPracticums.find((practicum) => practicum.id === sessionProfile?.workingPracticumId)
      ?? headerPracticums.find((practicum) => practicum.isActive))?.title ?? null
    : null;
  const currentNavItems = (role === "student" ? navItems : curatorNavItems)
    .filter((item) => !(role === "student" && streamsPrivate && item.label === "Стрим"))
    .map((item) => {
    if (item.label === "Обсуждения" && pendingDiscussionCount > 0) return { ...item, badge: String(pendingDiscussionCount) };
    if (item.label === "Очередь проверки" && pendingReviewCount > 0) return { ...item, badge: String(pendingReviewCount) };
    // pendingRevisionCount only covers the "нужна доработка" cycle — a freshly published
    // assignment (regular or practice) never touches it, so it's combined with the same
    // unread-NEW_ASSIGNMENT-notification signal every other nav badge already uses below.
    if (item.label === "Задания" && (pendingRevisionCount + unreadNotificationsByType("NEW_ASSIGNMENT")) > 0) return { ...item, badge: String(pendingRevisionCount + unreadNotificationsByType("NEW_ASSIGNMENT")) };
    if (role === "student" && item.label === "Обсуждение" && unreadNotificationsByType("DISCUSSION_REPLY") > 0) return { ...item, badge: String(unreadNotificationsByType("DISCUSSION_REPLY")) };
    if (role === "student" && item.label === "Записи" && unreadNotificationsByType("NEW_MEDIA") > 0) return { ...item, badge: String(unreadNotificationsByType("NEW_MEDIA")) };
    if (role === "student" && item.label === "Расписание" && unreadNotificationsByType("NEW_EVENT") > 0) return { ...item, badge: String(unreadNotificationsByType("NEW_EVENT")) };
    if (role === "curator" && item.label === "Расписание" && unreadNotificationsByType("SCHEDULE_REMINDER") > 0) return { ...item, badge: String(unreadNotificationsByType("SCHEDULE_REMINDER")) };
    return item;
  });
  // Real logged-in identity (Discord displayName/username) for whoever is viewing — used
  // for both roles now. It used to only replace the student fixture's name; the curator
  // side kept the static "Мария К." fixture regardless of who was actually logged in.
  const liveDisplayName = sessionProfile?.profile.displayName ?? sessionProfile?.profile.username ?? (role === "student" ? "Ученик" : "Куратор");
  // Gated to actual STUDENT accounts (not the curator/owner "preview as student" view-mode
  // toggle) — the watermark exists to trace a leaked recording back to a viewer, which only
  // makes sense for students. Showing a curator their own email back at themselves just leaks
  // it into whatever they're screen-recording (OBS, etc.) while hosting.
  const viewerWatermarkLabel = sessionProfile && sessionProfile.role === "STUDENT"
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
            // Land on the section named in `?tab=` (a reload, a shared link, an old Cyrillic
            // bookmark) when it exists for this role; otherwise on the role's home section.
            // Resetting lastSyncedNavRef makes the URL-sync effect rewrite the param in its
            // canonical slug form via replace(), so a legacy `?tab=Задания` becomes `?tab=tasks`.
            const tabParam = new URLSearchParams(window.location.search).get("tab");
            const requestedNav = tabParam ? navFromTabParam(tabParam) : null;
            const allowedNavs: AppNav[] = nextRole === "student"
              ? [...navItems.map((item) => item.label), "Профиль", "Обзор"]
              : [...curatorNavItems.map((item) => item.label), "Профиль"];
            lastSyncedNavRef.current = null;
            setActiveNav(requestedNav && allowedNavs.includes(requestedNav) ? requestedNav : nextRole === "student" ? "Мой практикум" : "Кабинет куратора");
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
    void fetch(`${API_ORIGIN}/api/streams/visibility`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: { streamsPrivate: boolean } }> : null)
      .then((payload) => { if (!cancelled && payload?.data) setStreamsPrivateState(payload.data.streamsPrivate); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [authenticated]);

  // Cosmetic only — "Стрим" landing directly via a stale/copied `?tab=stream` link when it's
  // hidden from the nav (streamsPrivate) isn't a security gap (getPlaybackStatus/chat are the
  // real, server-side gate, scoped to the caller's own practicum regardless of this), but it
  // confusingly rendered a "no stream, ever" page with no matching sidebar entry. Bounce to the
  // dashboard instead, same as any other section that isn't actually available right now.
  useEffect(() => {
    if (role === "student" && streamsPrivate && activeNav === "Стрим") setActiveNav("Мой практикум");
  }, [role, streamsPrivate, activeNav]);

  useEffect(() => {
    if (!authenticated || role !== "curator") { setHeaderPracticums([]); return; }
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/course/practicums`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: PracticumSummary[] }> : null)
      .then((payload) => { if (!cancelled && payload?.data) setHeaderPracticums(payload.data); })
      .catch(() => { /* breadcrumb just omits the poток name if this fails */ });
    return () => { cancelled = true; };
    // Re-fetches when workingPracticumId changes too — covers both switching (title already
    // known) and creating a brand-new practicum (title not in the list yet until this refetch).
  }, [authenticated, role, sessionProfile?.workingPracticumId]);

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
    // The "Очередь проверки" badge means "how many submissions are actually waiting on a
    // curator decision right now" — "На проверке" only, not "Нужна доработка" (that's
    // waiting on the student, same distinction the dashboard's own stat cards already make).
    if (!authenticated || role !== "curator") return;
    let cancelled = false;
    const refresh = () => {
      void fetchReviewQueue()
        .then((queue) => { if (!cancelled) setPendingReviewCount(queue.filter((item) => item.status === "На проверке").length); })
        .catch(() => undefined);
    };
    refresh();
    const poll = window.setInterval(refresh, 30_000);
    return () => { cancelled = true; window.clearInterval(poll); };
  }, [authenticated, role]);

  useEffect(() => {
    // The "Задания" badge means "a curator sent this back for revision and you haven't
    // opened the tab since" — it clears the moment the student visits, not when the
    // assignment itself changes state (that still requires an actual resubmission).
    if (!authenticated || role !== "student") return;
    let cancelled = false;
    const refresh = () => {
      void fetch(`${API_ORIGIN}/api/assignments`, { credentials: "include", cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ data?: Assignment[] }> : null)
        .then((payload) => {
          if (cancelled || !payload?.data) return;
          setRevisionAssignmentIds(payload.data.filter((assignment) => assignment.status === "Нужна доработка").map((assignment) => assignment.id));
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

  const markNotificationsReadByType = (...types: AppNotification["type"][]) => {
    const targets = notifications.filter((notification) => types.includes(notification.type) && !notification.read);
    if (targets.length === 0) return;
    setNotifications((current) => current.map((notification) => types.includes(notification.type) ? { ...notification, read: true } : notification));
    setUnreadCount((current) => Math.max(0, current - targets.length));
    targets.forEach((notification) => void fetch(`${API_ORIGIN}/api/notifications/${notification.id}/read`, { method: "POST", credentials: "include" }).catch(() => undefined));
  };

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
    } else if (item.type === "NEW_SUBMISSION") {
      setActiveNav("Очередь проверки");
    } else if (item.type === "NEW_MEDIA") {
      setActiveNav("Записи");
    } else if (item.type === "NEW_MODULE" || item.type === "MODULE_OPENED" || item.type === "CURATOR_REMINDER") {
      setActiveNav("Мой практикум");
    } else if (item.type === "NEW_EVENT" || item.type === "SCHEDULE_REMINDER") {
      setActiveNav("Расписание");
    } else if (item.type === "DISCUSSION_REPLY") {
      setActiveNav(role === "student" ? "Обсуждение" : "Обсуждения");
    } else if (item.type === "STREAM_LIVE") {
      setActiveNav(role === "student" ? "Стрим" : "Стримы");
    } else if (item.type === "SECURITY_ALERT") {
      if (item.entityId) setRequestedStudentId(item.entityId);
      setActiveNav("Ученики");
    }
  };

  const markAllNotificationsRead = () => {
    if (unreadCount === 0) return;
    setNotifications((current) => current.map((notification) => ({ ...notification, read: true })));
    setUnreadCount(0);
    void fetch(`${API_ORIGIN}/api/notifications/read-all`, { method: "POST", credentials: "include" }).catch(() => undefined);
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
                  if (role === "student" && item.label === "Обсуждение") { setRequestedDiscussionContext(null); markNotificationsReadByType("DISCUSSION_REPLY"); }
                  if (role === "student" && item.label === "Задания") { setSeenRevisionIds((current) => new Set([...current, ...revisionAssignmentIds])); markNotificationsReadByType("NEW_ASSIGNMENT"); }
                  if (role === "student" && item.label === "Записи") markNotificationsReadByType("NEW_MEDIA");
                  if (role === "student" && item.label === "Расписание") markNotificationsReadByType("NEW_EVENT");
                  if (role === "curator" && item.label === "Расписание") markNotificationsReadByType("SCHEDULE_REMINDER");
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
          {role === "student" && <button className="support-card" type="button" onClick={() => { setActiveNav("Обсуждение"); setRequestedDiscussionContext(null); setMenuOpen(false); }}>
            <span className="support-card-label">НАПИСАТЬ КУРАТОРУ</span>
            <span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span>
          </button>}
        </div>
      </aside>

      <section className="content-area">
        <header className="topbar">
          <button className="icon-button menu-button" aria-label="Открыть меню" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumbs"><strong>{activeNav}</strong>{headerPracticumTitle && <span className="breadcrumb-practicum">· {headerPracticumTitle}</span>}</div>
          <div className="topbar-actions">
            <div className="notification-wrap" ref={notificationWrapRef}>
              <button className="icon-button notification-button" aria-label="Уведомления" onClick={() => setShowNotifications((value) => !value)}>
                <Bell size={18} />{unreadCount > 0 && <span className="notification-dot" />}
              </button>
              {showNotifications && (
                <div className="notification-popover">
                  <div className="popover-heading"><strong>Уведомления</strong><div className="popover-heading-actions">{unreadCount > 0 && <button type="button" className="popover-mark-all" onClick={markAllNotificationsRead}>Прочитать все</button>}<span>{unreadCount > 0 ? `${unreadCount} новых` : "Всё прочитано"}</span></div></div>
                  {notifications.length === 0 && <div className="notification-empty">Пока нет уведомлений</div>}
                  {notifications.map((item) => {
                    const meta = NOTIFICATION_ICON[item.type] ?? DEFAULT_NOTIFICATION_ICON;
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
                        {!item.read && <span className="notification-item-unread-dot" aria-hidden="true" />}
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
          {role === "curator" && activeNav !== "Профиль" && <CuratorSectionView activeNav={activeNav as CuratorNav} requestedStudentId={requestedStudentId} isOwner={isOwner} workingPracticumId={sessionProfile?.workingPracticumId ?? null} onWorkingPracticumChange={(nextId) => setSessionProfile((current) => current ? { ...current, workingPracticumId: nextId } : current)} onNavigate={(nextNav) => setActiveNav(nextNav)} />}
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
              <div className="focus-copy"><div className="focus-context"><span>УРОК 03</span><span>ПРАКТИКА · EUR/USD</span></div><h2>{studentDashboard.focus.title}</h2><p>{studentDashboard.focus.subtitle}</p><div className="focus-guidance"><strong>Осталось {100 - studentDashboard.focus.progress}%</strong><span>Добавь объяснение сценария и отправь работу куратору.</span></div></div>
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
  onProfileUpdated: (profile: Partial<Pick<SessionProfile["profile"], "email" | "emailVerifiedAt" | "timeZone">>) => void;
  onLogout: () => void;
}) {
  const [email, setEmail] = useState(profile.email ?? "");
  const [timeZoneSaving, setTimeZoneSaving] = useState(false);
  const [timeZoneFeedback, setTimeZoneFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const autoZone = browserTimeZone();
  const saveTimeZone = async (next: string) => {
    setTimeZoneSaving(true); setTimeZoneFeedback(null);
    try {
      const response = await fetch(`${API_ORIGIN}/api/auth/profile/timezone`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeZone: next || null }) });
      const payload = await response.json().catch(() => ({})) as { data?: { timeZone: string | null }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить часовой пояс");
      onProfileUpdated({ timeZone: payload.data.timeZone });
      setTimeZoneFeedback({ tone: "success", text: "Сохранено — расписание показывается в выбранном поясе." });
    } catch (error) {
      setTimeZoneFeedback({ tone: "error", text: error instanceof Error ? error.message : "Не удалось сохранить часовой пояс" });
    } finally {
      setTimeZoneSaving(false);
    }
  };
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [backtestBooking, setBacktestBooking] = useState<ScheduleEvent | null | undefined>(undefined);
  const [preSessionBooking, setPreSessionBooking] = useState<ScheduleEvent | null | undefined>(undefined);
  const connectedIdentity = profile.identities.find((identity) => identity.provider === "DISCORD") ?? profile.identities[0];
  // Mirrors layout.tsx's THEME_INIT_SCRIPT: same localStorage key, same "light" is the only
  // non-default value stored — reading the already-applied DOM attribute on mount instead of
  // localStorage directly keeps this in sync with whatever the blocking init script decided.
  const [theme, setThemeState] = useState<"dark" | "light">(() => (typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"));
  const applyTheme = (next: "dark" | "light") => {
    setThemeState(next);
    if (next === "light") {
      document.documentElement.setAttribute("data-theme", "light");
      window.localStorage.setItem("fix-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
      window.localStorage.removeItem("fix-theme");
    }
  };

  useEffect(() => {
    if (role !== "student") return;
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/schedule`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: ScheduleApiEvent[] };
      if (cancelled || !Array.isArray(payload.data)) return;
      const events = payload.data.map(scheduleApiToUi);
      setBacktestBooking(events.find((event) => event.type === "Бэктест" && event.isBookedByActor) ?? null);
      setPreSessionBooking(events.find((event) => event.type === "Пресессия" && event.isBookedByActor) ?? null);
    }).catch(() => { if (!cancelled) { setBacktestBooking(null); setPreSessionBooking(null); } });
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
            <div><span className="section-kicker">ОФОРМЛЕНИЕ</span><h2>Тема интерфейса</h2></div>
            <Sparkles size={19} className="profile-card-icon" />
          </div>
          <div className="assignment-filter theme-toggle" role="tablist" aria-label="Тема интерфейса">
            <button type="button" role="tab" aria-selected={theme === "dark"} className={`filter-chip ${theme === "dark" ? "active" : ""}`} onClick={() => applyTheme("dark")}>Тёмная</button>
            <button type="button" role="tab" aria-selected={theme === "light"} className={`filter-chip ${theme === "light" ? "active" : ""}`} onClick={() => applyTheme("light")}>Светлая</button>
          </div>
          <p className="profile-help">Выбор сохраняется в этом браузере и применяется сразу.</p>
        </section>

        <section className="content-panel profile-card">
          <div className="section-heading">
            <div><span className="section-kicker">РАСПИСАНИЕ</span><h2>Часовой пояс</h2></div>
            <Clock3 size={19} className="profile-card-icon" />
          </div>
          <label className="form-field"><span>Показывать время эфиров и событий</span>
            <select value={profile.timeZone ?? ""} disabled={timeZoneSaving} onChange={(event) => void saveTimeZone(event.target.value)}>
              <option value="">Автоматически — {timeZoneTitle(autoZone)} ({timeZoneOffsetLabel(autoZone)})</option>
              <optgroup label="Страна — город">
                {COMMON_TIME_ZONES.map((zone) => <option value={zone.id} key={zone.id}>{zone.label} ({timeZoneOffsetLabel(zone.id)})</option>)}
              </optgroup>
              {profile.timeZone && !COMMON_TIME_ZONES.some((zone) => zone.id === profile.timeZone) && <option value={profile.timeZone}>{profile.timeZone} ({timeZoneOffsetLabel(profile.timeZone)})</option>}
              <optgroup label="Все часовые пояса">
                {allTimeZones().filter((zone) => !COMMON_TIME_ZONES.some((common) => common.id === zone)).map((zone) => <option value={zone} key={zone}>{zone.replace(/_/g, " ")} ({timeZoneOffsetLabel(zone)})</option>)}
              </optgroup>
            </select>
          </label>
          <p className="profile-help">{role === "student"
            ? "Эфиры создаются по киевскому времени — платформа сама пересчитывает их в ваш пояс, с учётом перехода на зимнее и летнее время в вашей стране. «Автоматически» берёт пояс из настроек вашего устройства."
            : "Расписание и время в форме создания события — в выбранном поясе. Платформа хранит всё по киевскому времени и сама пересчитывает для каждого ученика и куратора, с учётом перехода на зимнее и летнее время."}</p>
          {timeZoneFeedback && <div className={timeZoneFeedback.tone === "error" ? "file-error" : "form-action-feedback"}>{timeZoneFeedback.text}</div>}
        </section>

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

        {role !== "student" && <CuratorEmailPreferencesCard />}

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

        {role === "student" && preSessionBooking !== undefined && (
          <section className="content-panel profile-card">
            <div className="section-heading">
              <div><span className="section-kicker">ИНДИВИДУАЛЬНЫЙ ЗВОНОК</span><h2>Пресессия с куратором</h2></div>
              <Target size={19} className="profile-card-icon" />
            </div>
            <div className="identity-row">
              <div className="identity-mark">{preSessionBooking ? "1" : "0"}</div>
              <div className="identity-copy">
                <strong>{preSessionBooking ? "1 из 1 использовано" : "0 из 1 использовано"}</strong>
                <span>{preSessionBooking ? `Записан на ${formatEventDate(preSessionBooking.date)}, ${preSessionBooking.time}` : "Свободный слот можно выбрать в разделе «Расписание»."}</span>
              </div>
              <span className={`profile-status ${preSessionBooking ? "success" : ""}`}>{preSessionBooking ? "Забронировано" : "Не использован"}</span>
            </div>
            <p className="profile-help">На весь практикум доступна одна индивидуальная пресессия с куратором.</p>
          </section>
        )}
      </div>

      <div className="profile-actions"><button className="secondary-button" type="button" onClick={onLogout}>Выйти из аккаунта <ArrowUpRight size={16} /></button></div>
    </div>
  );
}

type CuratorEmailPreferences = { notifyNewSubmission: boolean; notifyNewQuestion: boolean };

/**
 * Curator/owner only, personal — which categories additionally email this specific curator (see
 * notification-service.ts#getEmailPreferences). Distinct from NotificationSettingsCard's global
 * switch on the dashboard: that one silences everyone for everyone, this one is per-person and
 * only ever affects the extra email channel — the in-app bell always fires either way.
 */
function CuratorEmailPreferencesCard() {
  const [prefs, setPrefs] = useState<CuratorEmailPreferences | null>(null);
  const [saving, setSaving] = useState<keyof CuratorEmailPreferences | "">("");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/notifications/email-preferences`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: CuratorEmailPreferences }> : null)
      .then((payload) => { if (!cancelled && payload?.data) setPrefs(payload.data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const toggle = async (key: keyof CuratorEmailPreferences) => {
    if (!prefs || saving) return;
    setSaving(key);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/notifications/email-preferences`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: !prefs[key] }),
      });
      const payload = await response.json().catch(() => ({})) as { data?: CuratorEmailPreferences; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить настройку.");
      setPrefs(payload.data);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить настройку.");
    } finally {
      setSaving("");
    }
  };

  const row = (key: keyof CuratorEmailPreferences, label: string, description: string) => (
    <div className="profile-notification-toggle-row">
      <div><strong>{label}</strong><span>{description}</span></div>
      <button type="button" className={`notification-settings-switch ${prefs?.[key] ? "on" : ""}`} role="switch" aria-checked={prefs?.[key] ?? false} aria-label={label} disabled={!prefs || saving !== ""} onClick={() => void toggle(key)}>
        <span className="notification-settings-switch-knob" />
      </button>
    </div>
  );

  return (
    <section className="content-panel profile-card">
      <div className="section-heading">
        <div><span className="section-kicker">ЛИЧНЫЕ УВЕДОМЛЕНИЯ</span><h2>Письма на почту</h2></div>
        <Bell size={19} className="profile-card-icon" />
      </div>
      <p className="profile-help">Колокольчик в интерфейсе приходит всегда. Здесь выбираешь, что из этого дополнительно продублировать письмом лично тебе.</p>
      {row("notifyNewSubmission", "Новое ДЗ на проверку", "Письмо, когда ученик отправляет работу и она ещё никем не взята.")}
      {row("notifyNewQuestion", "Новый вопрос от ученика", "Письмо, когда ученик открывает новое обсуждение.")}
      {error && <div className="file-error" role="alert">{error}</div>}
    </section>
  );
}

function SectionView({ activeNav, unlockedModuleIds, requestedAssignmentId, requestedDiscussionContext, onNavigate, onOpenAssignment, onOpenDiscussion, onCloseDiscussionContext }: { activeNav: string; unlockedModuleIds: ReadonlySet<string>; requestedAssignmentId: string; requestedDiscussionContext: DiscussionContext | null; onNavigate: (nextNav: DashboardNav) => void; onOpenAssignment: (assignmentId: string) => void; onOpenDiscussion: (context: DiscussionContext) => void; onCloseDiscussionContext: () => void }) {
  const viewContent = {
    "Мой практикум": {
      kicker: "ПРОГРАММА ОБУЧЕНИЯ",
      title: "Мой практикум",
      description: "Двигайся по урокам в своём темпе. Все записи и материалы останутся доступны после завершения.",
    },
    "Задания": {
      kicker: "ПРОВЕРКА И ПРОГРЕСС",
      title: "Задания",
      description: "Здесь собраны все отправленные, ожидающие проверки и требующие доработки работы.",
    },
    "Расписание": {
      kicker: "СОБЫТИЯ ПОТОКА",
      title: "Расписание",
      description: "Записывайся на практические части и возвращайся к записям конференций в удобное время. Всё время в расписании — киевское (EET/EEST).",
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
    {activeNav === "Задания" && <AssignmentsView requestedAssignmentId={requestedAssignmentId} onOpenDiscussion={onOpenDiscussion} />}
    {activeNav === "Расписание" && <ScheduleView onOpenStreams={(recordingId) => { if (typeof window !== "undefined" && recordingId) window.sessionStorage.setItem("fix-target-stream", recordingId); onNavigate("Записи"); }} onJoinLive={() => onNavigate("Стрим")} />}
    {activeNav === "Стрим" && <StudentLiveStreamView onNavigate={onNavigate} />}
    {activeNav === "Записи" && <StreamsView />}
    {activeNav === "Обсуждение" && (requestedDiscussionContext ? <DiscussionContextBanner context={requestedDiscussionContext} onOpenHistory={onCloseDiscussionContext} /> : <DiscussionViewDb onOpenDiscussion={onOpenDiscussion} />)}
  </div>;
}

function CuratorSectionView({ activeNav, requestedStudentId, isOwner, workingPracticumId, onWorkingPracticumChange, onNavigate }: { activeNav: CuratorNav; requestedStudentId: string; isOwner: boolean; workingPracticumId: string | null; onWorkingPracticumChange: (nextId: string | null) => void; onNavigate: (nextNav: CuratorNav) => void }) {
  // Owner-only "просмотр архива": browse a non-active practicum's Программа/Медиатека/Расписание
  // read-only, without ever touching which one is active — see PracticumManagerCard#onView and
  // course-service.ts/schedule-service.ts's viewPracticumId option. Deliberately lives here (not
  // lifted to HomeContent) so leaving the curator section at all — role toggle, logout — resets
  // it; there's no reason a stale "viewing an old stream" flag should survive that.
  const [viewingPracticum, setViewingPracticum] = useState<{ id: string; title: string } | null>(null);
  const viewPracticum = (practicum: { id: string; title: string }) => {
    setViewingPracticum(practicum);
    onNavigate("Программа");
  };
  const headings: Record<CuratorNav, { kicker: string; title: string; description: string }> = {
    "Кабинет куратора": { kicker: "РАБОЧИЙ ЦЕНТР", title: "Кабинет куратора", description: "Все работы, ученики и обратная связь по потоку собраны в одном рабочем контуре." },
    "Очередь проверки": { kicker: "ПРОВЕРКА ДЗ", title: "Очередь проверки", description: "" },
    "Создать задание": { kicker: "НОВАЯ РАБОТА", title: "Создать задание", description: "" },
    "Ученики": { kicker: "ПОТОК 04", title: "Ученики", description: "Прогресс, активность и история обратной связи по каждому участнику практикума." },
    "Прогресс": { kicker: "СВОДКА ПОТОКА", title: "Прогресс", description: "Кто где остановился, у кого есть ДЗ на проверке и кому нужно внимание — одним списком." },
    "Программа": { kicker: "ДОСТУП К ПРОГРАММЕ", title: "Программа", description: "" },
    "Приглашения": { kicker: "ДОСТУП К ПОТОКУ", title: "Приглашения", description: "Создавай персональные ссылки для новых участников и контролируй срок их действия." },
    "Расписание": { kicker: "СОБЫТИЯ ПОТОКА", title: "Расписание", description: "Стримы, групповые проверки и встречи, которые нужно подготовить для потока." },
    "Стримы": { kicker: "ЭФИРЫ ПОТОКА", title: "Стримы", description: "Ближайшие эфиры и записи, которые видят ученики этого потока." },
    "Медиатека": { kicker: "МАТЕРИАЛЫ", title: "Медиатека", description: "Записи эфиров и видеоразборы, привязанные к урокам и работам учеников." },
    "Обсуждения": { kicker: "ОБРАТНАЯ СВЯЗЬ", title: "Обсуждения", description: "Вопросы учеников, ответы куратора и контекст уроков собраны в одном рабочем inbox." },
    "Команда": { kicker: "БЕЗОПАСНОСТЬ КОМАНДЫ", title: "Команда", description: "Устройства и входы кураторов — здесь же одобряется третье устройство, которое некому подтвердить со стороны ученика." },
  };
  const heading = headings[activeNav] ?? headings["Кабинет куратора"];

  const headingClass = activeNav === "Обсуждения" ? "curator-discussion-page-heading" : activeNav === "Медиатека" ? "media-page-heading" : activeNav === "Расписание" ? "schedule-page-heading" : activeNav === "Стримы" ? "curator-streams-page-heading" : activeNav === "Кабинет куратора" ? "curator-dashboard-page-heading" : activeNav === "Очередь проверки" ? "curator-queue-page-heading" : activeNav === "Создать задание" ? "curator-create-page-heading" : activeNav === "Ученики" ? "curator-students-page-heading" : activeNav === "Прогресс" ? "curator-students-page-heading" : activeNav === "Команда" ? "curator-students-page-heading" : activeNav === "Приглашения" ? "curator-invite-page-heading" : activeNav === "Программа" ? "curator-program-page-heading" : "";
  const archivedNavs: CuratorNav[] = ["Программа", "Медиатека", "Расписание"];
  return <div className="workspace-view learner-course-view"><div className={`workspace-view-heading ${headingClass}`}><div><span className="eyebrow"><Sparkles size={14} /> {heading.kicker}</span><h1>{heading.title}</h1>{heading.description && <p>{heading.description}</p>}</div></div>
    {viewingPracticum && archivedNavs.includes(activeNav) && <div className="archive-view-banner"><div className="archive-view-banner-copy"><ShieldCheck size={16} /><span>Вы просматриваете архив: <strong>{viewingPracticum.title}</strong>. Новый урок, событие или приглашение отсюда не создать — это всегда уходит в ваш рабочий поток.</span></div><button className="secondary-button" type="button" onClick={() => setViewingPracticum(null)}>Закрыть просмотр</button></div>}
    {activeNav === "Кабинет куратора" && <CuratorDashboardOverview onNavigate={onNavigate} isOwner={isOwner} onViewPracticum={viewPracticum} workingPracticumId={workingPracticumId} onWorkingPracticumChange={onWorkingPracticumChange} />} {activeNav === "Очередь проверки" && <CuratorReviewWorkspace onNavigate={onNavigate} />} {activeNav === "Создать задание" && <CreateAssignmentView onNavigate={onNavigate} />} {activeNav === "Ученики" && <CuratorStudentsView requestedStudentId={requestedStudentId} onInvite={() => onNavigate("Приглашения")} isOwner={isOwner} />} {activeNav === "Прогресс" && <CuratorProgressView onNavigate={onNavigate} />} {activeNav === "Программа" && <CuratorModuleAccessView onNavigate={onNavigate} viewingPracticumId={viewingPracticum?.id ?? null} />} {activeNav === "Приглашения" && <CuratorInvitationsView workingPracticumId={workingPracticumId} />} {activeNav === "Расписание" && <CuratorScheduleView onNavigate={onNavigate} viewingPracticumId={viewingPracticum?.id ?? null} />} {activeNav === "Стримы" && <CuratorStreamsView onNavigate={onNavigate} />} {activeNav === "Медиатека" && <CuratorMediaLibraryView viewingPracticumId={viewingPracticum?.id ?? null} />} {activeNav === "Обсуждения" && <CuratorDiscussionsView />} {activeNav === "Команда" && <CuratorTeamView isOwner={isOwner} />} {activeNav !== "Кабинет куратора" && activeNav !== "Очередь проверки" && activeNav !== "Создать задание" && activeNav !== "Расписание" && activeNav !== "Стримы" && activeNav !== "Ученики" && activeNav !== "Прогресс" && activeNav !== "Программа" && activeNav !== "Приглашения" && activeNav !== "Медиатека" && activeNav !== "Обсуждения" && activeNav !== "Команда" && <CuratorPlaceholder title={heading.title} />}</div>;
}

async function fetchReviewQueue(): Promise<ReviewQueueItem[]> {
  const response = await fetch(`${API_ORIGIN}/api/review/submissions`, { credentials: "include", cache: "no-store" });
  if (!response.ok) return [];
  const payload = await response.json() as { data?: ReviewQueueItem[] };
  return payload.data ?? [];
}

type CuratorDiscussionStatus = "NEW" | "WAITING" | "ANSWERED" | "CLOSED";

type CuratorDiscussionMessageAttachment = {
  originalName: string;
  mimeType: string;
  contentUrl?: string;
  sourceUrl?: string;
  embedUrl?: string;
};

type CuratorDiscussionMessage = {
  id: string;
  author: "student" | "curator";
  name: string;
  time: string;
  body: string;
  attachments: CuratorDiscussionMessageAttachment[];
};

type CuratorDiscussion = {
  id: string;
  title: string;
  student: string;
  studentIsAdvanced?: boolean;
  initials: string;
  avatarUrl?: string | null;
  module: string;
  coverPath?: string | null;
  assignment?: string;
  status: CuratorDiscussionStatus;
  updatedAt: string;
  messages: CuratorDiscussionMessage[];
  // "Завершить поток" — the student's own practicum has been marked completed: history stays
  // readable, but the reply box (student side only — see discussion-service.ts#reply) hides.
  // Always false on the curator side (they're never blocked).
  practicumCompleted: boolean;
};

type DiscussionApiThread = {
  id: string;
  title: string;
  status: "NEW" | "WAITING" | "ANSWERED" | "CLOSED";
  module: { title: string; position: number; coverPath: string | null } | null;
  assignment: { title: string } | null;
  student: { name: string | null; email: string | null; avatarUrl: string | null; isAdvanced?: boolean };
  messages: Array<{ id: string; authorRole: "STUDENT" | "CURATOR" | "OWNER"; authorName: string | null; body: string; createdAt: string; attachments: Array<{ originalName: string; mimeType: string; contentUrl: string | null; sourceUrl: string | null }> }>;
  practicumCompleted: boolean;
};

function mapDiscussionApiStatus(status: DiscussionApiThread["status"]): CuratorDiscussionStatus {
  return status;
}

function mapDiscussionApiThread(thread: DiscussionApiThread): CuratorDiscussion {
  const courseModule = thread.module ? `${String(thread.module.position).padStart(2, "0")} · ${thread.module.title}` : thread.assignment ? "Практическое задание" : "Без урока";
  return {
    id: thread.id,
    title: thread.title,
    student: thread.student.name ?? thread.student.email ?? "Ученик",
    initials: getInitials(thread.student.name ?? thread.student.email ?? "Ученик", "УЧ"),
    avatarUrl: thread.student.avatarUrl,
    studentIsAdvanced: thread.student.isAdvanced ?? false,
    module: courseModule,
    coverPath: discussionCoverForModule(thread.module?.position, thread.module?.coverPath),
    assignment: thread.assignment?.title,
    status: mapDiscussionApiStatus(thread.status),
    updatedAt: thread.messages[thread.messages.length - 1]?.createdAt ? new Date(thread.messages[thread.messages.length - 1].createdAt).toLocaleString("ru-RU") : "только что",
    messages: thread.messages.map((message) => ({
      id: message.id,
      author: message.authorRole === "STUDENT" ? "student" : "curator",
      name: message.authorName ?? (message.authorRole === "STUDENT" ? "Ученик" : "Куратор"),
      time: new Date(message.createdAt).toLocaleString("ru-RU"),
      body: message.body,
      attachments: message.attachments.map((attachment) => ({
        originalName: attachment.originalName,
        mimeType: attachment.mimeType,
        contentUrl: attachment.contentUrl ?? undefined,
        sourceUrl: attachment.sourceUrl ?? undefined,
        embedUrl: attachment.sourceUrl ? assignmentMaterialEmbed(attachment.sourceUrl) ?? undefined : undefined,
      })),
    })),
    practicumCompleted: thread.practicumCompleted,
  };
}

function discussionBodyEmbedUrl(body: string): string | undefined {
  const url = body.match(/https?:\/\/[^\s<>()]+/i)?.[0]?.replace(/[.,!?;:]+$/, "");
  return url ? assignmentMaterialEmbed(url) ?? undefined : undefined;
}

function DiscussionMessageAttachments({ message }: { message: CuratorDiscussionMessage }) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const lightboxPortalTarget = useLightboxPortalTarget(Boolean(lightboxUrl));
  useEffect(() => {
    if (!lightboxUrl) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setLightboxUrl(null); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxUrl]);

  const imageAttachments = message.attachments.filter((attachment): attachment is CuratorDiscussionMessageAttachment & { contentUrl: string } => Boolean(attachment.contentUrl) && attachment.mimeType.startsWith("image/"));
  const otherAttachments = message.attachments.filter((attachment) => !(attachment.contentUrl && attachment.mimeType.startsWith("image/")));
  const attachmentEmbedUrl = message.attachments.find((attachment) => attachment.embedUrl)?.embedUrl;
  const fallbackEmbedUrl = attachmentEmbedUrl ?? discussionBodyEmbedUrl(message.body);

  return <>
    {imageAttachments.length > 0 && <div className="discussion-message-image-grid">{imageAttachments.map((attachment, index) => <button type="button" className="discussion-message-image" key={index} onClick={() => setLightboxUrl(attachment.contentUrl)} aria-label={`Открыть вложение ${attachment.originalName}`}><Image src={attachment.contentUrl} alt={attachment.originalName} fill sizes="140px" unoptimized /></button>)}</div>}
    {otherAttachments.map((attachment, index) => {
      if (attachment.sourceUrl) {
        return <a className="discussion-message-link" key={index} href={attachment.sourceUrl} target="_blank" rel="noreferrer"><ArrowUpRight size={15} /><span>Открыть ссылку на материал</span></a>;
      }
      return attachment.contentUrl
        ? <a className="discussion-message-attachment" key={index} href={attachment.contentUrl} target="_blank" rel="noreferrer"><FileCheck2 size={15} /><span>{attachment.originalName}</span><ArrowUpRight size={14} /></a>
        : <div className="discussion-message-attachment" key={index}><FileCheck2 size={15} /><span>{attachment.originalName}</span></div>;
    })}
    {fallbackEmbedUrl && <div className="discussion-message-video"><iframe src={fallbackEmbedUrl} title="Видео в ответе куратора" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /></div>}
    {lightboxUrl && lightboxPortalTarget && createPortal(
      <div className="chat-image-lightbox-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLightboxUrl(null); }}>
        <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть просмотр" onClick={() => setLightboxUrl(null)}><X size={22} /></button>
        <img className="chat-image-lightbox-image" src={lightboxUrl} alt="Просмотр изображения" />
      </div>,
      lightboxPortalTarget,
    )}
  </>;
}

type PendingDiscussionAttachment = { file: File; previewUrl: string; kind: "image" | "video" | "file" };
type DiscussionAttachmentPayload = { fileId: string; originalName: string; mimeType: string; byteSize: number };
const MAX_DISCUSSION_ATTACHMENTS = 5;

// Shared across every multi-file attach point (discussion composers, assignment submission) —
// all need the same select-many/preview/remove/upload behavior; only the surrounding JSX differs.
function useDiscussionAttachments() {
  const [attachments, setAttachments] = useState<PendingDiscussionAttachment[]>([]);
  const [error, setError] = useState("");
  const attachmentsRef = useRef<PendingDiscussionAttachment[]>([]);
  useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
  useEffect(() => () => { attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl)); }, []);

  const addFiles = (fileList: FileList | File[] | null | undefined) => {
    if (!fileList) return;
    const incoming = Array.from(fileList);
    if (incoming.length === 0) return;
    let nextError = "";
    const accepted: PendingDiscussionAttachment[] = [];
    for (const file of incoming) {
      if (attachments.length + accepted.length >= MAX_DISCUSSION_ATTACHMENTS) { nextError = `Можно прикрепить не более ${MAX_DISCUSSION_ATTACHMENTS} файлов за раз.`; break; }
      if (file.size > 10 * 1024 * 1024) { nextError = "Файл слишком большой. Максимальный размер — 10 МБ."; continue; }
      accepted.push({ file, previewUrl: URL.createObjectURL(file), kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file" });
    }
    setError(nextError);
    if (accepted.length) setAttachments((current) => [...current, ...accepted]);
  };

  const removeAt = (index: number) => {
    setAttachments((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  };

  const clear = () => {
    setAttachments((current) => {
      current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      return [];
    });
    setError("");
  };

  const uploadAll = async (): Promise<{ payload: DiscussionAttachmentPayload[]; uploadedFileIds: string[] }> => {
    const payload: DiscussionAttachmentPayload[] = [];
    const uploadedFileIds: string[] = [];
    for (const attachment of attachments) {
      const file = attachment.file;
      const createResponse = await fetch(`${API_ORIGIN}/api/files`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ originalName: file.name, mimeType: file.type, byteSize: file.size }) });
      const createPayload = await createResponse.json().catch(() => ({})) as { message?: string; data?: { id: string; uploadUrl: string } };
      if (!createResponse.ok || !createPayload.data?.id || !createPayload.data.uploadUrl) {
        for (const fileId of uploadedFileIds) void fetch(`${API_ORIGIN}/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
        throw new Error(createPayload.message ?? "Не удалось подготовить файл.");
      }
      uploadedFileIds.push(createPayload.data.id);
      const uploadResponse = await fetch(createPayload.data.uploadUrl, { method: "PUT", credentials: "include", headers: { "Content-Type": file.type }, body: file });
      if (!uploadResponse.ok) {
        for (const fileId of uploadedFileIds) void fetch(`${API_ORIGIN}/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
        throw new Error("Не удалось загрузить файл.");
      }
      payload.push({ fileId: createPayload.data.id, originalName: file.name, mimeType: file.type, byteSize: file.size });
    }
    return { payload, uploadedFileIds };
  };

  return { attachments, error, addFiles, removeAt, clear, uploadAll };
}

function DiscussionAttachmentPreviewList({ attachments, onRemove }: { attachments: PendingDiscussionAttachment[]; onRemove: (index: number) => void }) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const lightboxPortalTarget = useLightboxPortalTarget(Boolean(lightboxUrl));
  useEffect(() => {
    if (!lightboxUrl) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setLightboxUrl(null); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxUrl]);

  if (attachments.length === 0) return null;
  return <>
    <div className="discussion-selected-preview-list">{attachments.map((attachment, index) => <div className="discussion-selected-preview" key={`${attachment.file.name}-${index}`}>
      <button type="button" className="discussion-selected-remove" onClick={() => onRemove(index)} aria-label={`Убрать файл ${attachment.file.name}`}><X size={13} /></button>
      {attachment.kind === "image" && <button type="button" className="discussion-selected-image" aria-label={`Увеличить фото ${attachment.file.name}`} onClick={() => setLightboxUrl(attachment.previewUrl)} style={{ backgroundImage: `url("${attachment.previewUrl}")` }} />}
      {attachment.kind === "video" && <video src={attachment.previewUrl} controls playsInline preload="metadata" />}
      {attachment.kind === "file" && <div className="discussion-file-preview"><FileCheck2 size={18} /><span>{attachment.file.name}</span></div>}
    </div>)}</div>
    {lightboxUrl && lightboxPortalTarget && createPortal(
      <div className="chat-image-lightbox-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLightboxUrl(null); }}>
        <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть просмотр" onClick={() => setLightboxUrl(null)}><X size={22} /></button>
        <img className="chat-image-lightbox-image" src={lightboxUrl} alt="Просмотр изображения" />
      </div>,
      lightboxPortalTarget,
    )}
  </>;
}

const demoCuratorDiscussions: CuratorDiscussion[] = [
  {
    id: "discussion-1",
    title: "Как отличить возврат в зону от ложного пробоя?",
    student: "Алексей К.",
    initials: "АК",
    module: "01 · Контекст и структура рынка",
    status: "NEW",
    updatedAt: "18 минут назад",
    practicumCompleted: false,
    messages: [
      { id: "discussion-1-message-1", author: "student", name: "Алексей К.", time: "Сегодня, 12:06", body: "Подскажите, правильно ли я отметил возврат в зону на графике? Не понимаю, где заканчивается реакция и начинается ложный пробой.", attachments: [{ originalName: "EURUSD-уровни.png", mimeType: "image/png", contentUrl: "/market-logic-cover.webp" }] },
    ],
  },
  {
    id: "discussion-2",
    title: "Дополнительное ДЗ по уроку 03",
    student: "Мария К.",
    initials: "МК",
    module: "03 · Зоны поддержки и сопротивления",
    assignment: "Тестовое задание к первому уроку",
    status: "WAITING",
    updatedAt: "вчера",
    practicumCompleted: false,
    messages: [
      { id: "discussion-2-message-1", author: "student", name: "Мария К.", time: "Вчера, 17:42", body: "Я отправила работу повторно после комментария. Можно уточнить, нужно ли дополнительно описать сценарий отмены?", attachments: [] },
      { id: "discussion-2-message-2", author: "curator", name: "Мария · куратор", time: "Вчера, 18:01", body: "Да, добавь один короткий пример отмены сценария и отправь новую попытку. Вопрос оставляю открытым до проверки.", attachments: [] },
    ],
  },
  {
    id: "discussion-3",
    title: "Поделитесь разметкой перед завтрашним стримом",
    student: "Елена С.",
    initials: "ЕС",
    module: "02 · Narrative и Reversal",
    status: "ANSWERED",
    updatedAt: "2 дня назад",
    practicumCompleted: false,
    messages: [
      { id: "discussion-3-message-1", author: "student", name: "Елена С.", time: "2 дня назад, 15:20", body: "Прикрепляю разметку, которую хочу разобрать на завтрашнем стриме." , attachments: [{ originalName: "разметка-сценария.pdf", mimeType: "application/pdf" }] },
      { id: "discussion-3-message-2", author: "curator", name: "Мария · куратор", time: "2 дня назад, 15:45", body: "Получила. Добавлю этот пример в план разбора и отмечу его во время трансляции.", attachments: [] },
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
  const replyAttachments = useDiscussionAttachments();
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

  const handleReplyPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    const files = imageItems.map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      const extension = item.type.split("/")[1] || "png";
      return new File([file], `screenshot-${Date.now()}-${index}.${extension}`, { type: item.type });
    }).filter((file): file is File => file !== null);
    replyAttachments.addFiles(files);
  };

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = reply.trim();
    if ((!body && replyAttachments.attachments.length === 0) || !selectedThread || replySaving) return;
    setReplySaving(true);
    setReplyError("");
    let uploadedFileIds: string[] = [];
    try {
      const uploaded = await replyAttachments.uploadAll();
      uploadedFileIds = uploaded.uploadedFileIds;
      const response = await fetch(`${API_ORIGIN}/api/discussions/${selectedThread.id}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, attachments: uploaded.payload }),
      });
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить ответ.");
      const nextThread = mapDiscussionApiThread(payload.data);
      setThreads((current) => current.map((thread) => thread.id === nextThread.id ? nextThread : thread));
      setReply("");
      replyAttachments.clear();
    } catch (error: unknown) {
      for (const fileId of uploadedFileIds) void fetch(`${API_ORIGIN}/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
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
          {(["all", "NEW", "WAITING", "ANSWERED", "CLOSED"] as const).map((item) => {
            const count = item === "all" ? moduleThreads.length : moduleThreads.filter((thread) => thread.status === item).length;
            const label = item === "all" ? "Все" : item === "NEW" ? "Новые" : item === "WAITING" ? "Ждёт" : item === "ANSWERED" ? "Отвечен" : "Закрыт";
            return <button className={`filter-chip ${filter === item ? "active" : ""}`} type="button" key={item} onClick={() => setFilter(item)} aria-pressed={filter === item}>{label} <span>{count}</span></button>;
          })}
          <label className="curator-discussion-module-filter"><span>Урок</span><select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}><option value="all">Все уроки</option>{moduleOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </div>
        <div className="curator-discussion-thread-list">{loading ? <div className="empty-state"><MessageSquareText size={22} /><strong>Загружаем обсуждения…</strong><span>Проверяем темы из базы данных.</span></div> : loadError ? <div className="empty-state"><MessageSquareText size={22} /><strong>Не удалось загрузить обсуждения</strong><span>{loadError}</span></div> : visibleThreads.length > 0 ? visibleThreads.map((thread) => <button className={`curator-discussion-thread-row ${thread.id === selectedThread?.id ? "selected" : ""}`} type="button" key={thread.id} onClick={() => setSelectedId(thread.id)}>{thread.avatarUrl ? <Image className="profile-avatar profile-avatar-image" src={thread.avatarUrl} alt={thread.student} width={34} height={34} unoptimized /> : <div className={`profile-avatar ${thread.status === "ANSWERED" ? "curator" : ""}`}>{thread.initials}</div>}<div><strong>{thread.title}</strong><span><span className={thread.studentIsAdvanced ? "student-name-advanced" : undefined}>{thread.student}</span>{thread.studentIsAdvanced && <em className="adv-tag" title="Advanced">ADV</em>} · {thread.module}</span><small>{thread.updatedAt} · {thread.messages.length} {thread.messages.length === 1 ? "сообщение" : "сообщения"}</small></div><b className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(thread.status)}</b><ChevronRight size={15} /></button>) : <div className="empty-state"><MessageSquareText size={22} /><strong>Обсуждений пока нет</strong><span>Новые вопросы появятся здесь после отправки учеником.</span></div>}</div>
      </section>
      {selectedThread ? <section className="content-panel curator-discussion-detail">
        <div className="curator-discussion-detail-head"><div><span className="section-kicker">{selectedThread.module}</span><h2>{selectedThread.title}</h2><p><span className={selectedThread.studentIsAdvanced ? "student-name-advanced" : undefined}>{selectedThread.student}</span>{selectedThread.studentIsAdvanced && <em className="adv-tag" title="Advanced">ADV</em>}{selectedThread.assignment ? ` · ${selectedThread.assignment}` : ""}</p></div><span className={`curator-discussion-status ${selectedThread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(selectedThread.status)}</span></div>
        <div className="curator-discussion-module-cover" role="img" aria-label={`Обложка ${selectedThread.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(4,7,12,.94), rgba(4,7,12,.72)), url("${selectedThread.coverPath ?? discussionCoverForContext({ module: selectedThread.module })}")` }}><strong>{selectedThread.module}</strong></div>
        <div className="curator-discussion-context">{selectedThread.assignment && <span><FileCheck2 size={14} /> {selectedThread.assignment}</span>}<span><MessageSquareText size={14} /> Личная тема ученика</span></div>
        <div className="curator-discussion-messages">{selectedThread.messages.map((message) => <article className={`curator-discussion-message ${message.author}`} key={message.id}><div className="curator-discussion-message-meta"><StudentName name={message.name} advanced={message.author === "student" && selectedThread.studentIsAdvanced} /><span>{message.time}</span></div><p>{linkifyText(message.body)}</p><DiscussionMessageAttachments message={message} /></article>)}</div>
        <form className="curator-discussion-reply" onSubmit={sendReply}><label htmlFor="curator-discussion-reply">ОТВЕТ КУРАТОРА</label><div className="curator-discussion-input-wrap"><textarea id="curator-discussion-reply" onKeyDown={continueNumberedList} value={reply} onChange={(event) => setReply(event.target.value)} onPaste={handleReplyPaste} placeholder="Напишите ответ…" rows={4} /><label className="discussion-reply-attach-button" htmlFor="curator-discussion-reply-attachment" title="Прикрепить файлы" aria-label="Прикрепить файлы"><Plus size={18} /><input id="curator-discussion-reply-attachment" type="file" multiple accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => { replyAttachments.addFiles(event.target.files); event.target.value = ""; }} /></label></div>{replyAttachments.error && <div className="file-error" role="alert">{replyAttachments.error}</div>}<DiscussionAttachmentPreviewList attachments={replyAttachments.attachments} onRemove={replyAttachments.removeAt} /><div><span className="curator-discussion-draft-note"><FileCheck2 size={14} /> Ответ сохранится в истории этой темы</span><button className="primary-button" type="submit" disabled={(!reply.trim() && replyAttachments.attachments.length === 0) || replySaving}>{replySaving ? "Сохраняем…" : "Отправить ответ"} <ChevronRight size={15} /></button></div>{replyError && <div className="file-error" role="alert">{replyError}</div>}</form>
      </section> : <section className="content-panel curator-discussion-empty empty-state"><MessageSquareText size={22} /><strong>Выбери тему</strong><span>Справа появится история вопроса и форма ответа.</span></section>}
    </div>
  </div>;
}

function CuratorDashboardOverview({ onNavigate, isOwner, onViewPracticum, workingPracticumId, onWorkingPracticumChange }: { onNavigate: (nextNav: CuratorNav) => void; isOwner: boolean; onViewPracticum: (practicum: PracticumSummary) => void; workingPracticumId: string | null; onWorkingPracticumChange: (nextId: string | null) => void }) {
  const [localQueue, setLocalQueue] = useState<ReviewQueueItem[]>([]);
  const [studentCount, setStudentCount] = useState<number | null>(null);
  const [discussions, setDiscussions] = useState<CuratorDiscussion[]>([]);
  const [upcomingEvents, setUpcomingEvents] = useState<ScheduleEvent[]>([]);
  const [liveScheduleEventId, setLiveScheduleEventId] = useState<string | null>(null);

  useEffect(() => {
    const handleSubmitted = (event: Event) => {
      if (event.type !== assignmentSubmittedEvent) return;
      void fetchReviewQueue().then(setLocalQueue).catch(() => setLocalQueue([]));
    };
    void fetchReviewQueue().then(setLocalQueue).catch(() => setLocalQueue([]));
    window.addEventListener(assignmentSubmittedEvent, handleSubmitted);
    return () => window.removeEventListener(assignmentSubmittedEvent, handleSubmitted);
  }, []);

  useEffect(() => {
    // "Ученики в потоке" means the поток shown everywhere else on this page (breadcrumb,
    // "Потоки" list below) — the curator's own workingPracticumId — not every student ever
    // enrolled anywhere. Omitting practicumId here used to always return the platform-wide
    // total regardless of which поток was selected.
    // No working поток picked (e.g. an owner who never switched) means "the active one" — same
    // fallback as the server and the "Ученики" tab. Sending no practicumId at all instead
    // counted every student on the platform, old/completed cohorts included.
    let cancelled = false;
    void (async () => {
      let practicumId = workingPracticumId;
      if (!practicumId) {
        const list = await fetch(`${API_ORIGIN}/api/course/practicums`, { credentials: "include", cache: "no-store" })
          .then((response) => response.ok ? response.json() as Promise<{ data?: PracticumSummary[] }> : null)
          .catch(() => null);
        practicumId = list?.data?.find((practicum) => practicum.isActive)?.id ?? null;
      }
      const query = practicumId ? `?practicumId=${encodeURIComponent(practicumId)}` : "";
      const payload = await fetch(`${API_ORIGIN}/api/security/students${query}`, { credentials: "include", cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ data?: unknown[] }> : null)
        .catch(() => null);
      if (!cancelled && Array.isArray(payload?.data)) setStudentCount(payload.data.length);
    })();
    return () => { cancelled = true; };
  }, [workingPracticumId]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/discussions/manage`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: DiscussionApiThread[] };
      if (cancelled || !Array.isArray(payload.data)) return;
      setDiscussions(payload.data.map(mapDiscussionApiThread));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

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
      setUpcomingEvents(events);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const refreshLiveStatus = async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { data?: { liveScheduleEventId: string | null } };
        setLiveScheduleEventId(payload.data?.liveScheduleEventId ?? null);
      } catch { /* keep last known state */ }
    };
    void refreshLiveStatus();
    const poll = window.setInterval(() => { void refreshLiveStatus(); }, 15_000);
    return () => window.clearInterval(poll);
  }, []);

  // Cohort-wide counts stay in the top row (curators share one queue); "Проверено вами" is
  // scoped to this curator specifically — with 2-3 curators on one stream, a shared "Принято"
  // number told nobody which of them was actually doing the reviewing.
  const reviewCount = localQueue.filter((item) => item.status === "На проверке").length;
  const revisionCount = localQueue.filter((item) => item.status === "Нужна доработка").length;
  const reviewedByMeCount = localQueue.filter((item) => item.status === "Принято" && item.reviewedByMe).length;
  const recentQueue = localQueue.slice(0, 3);
  const pendingDiscussions = discussions.filter((thread) => thread.status === "NEW" || thread.status === "WAITING").slice(0, 3);
  const nextEvents = upcomingEvents.slice(0, 3);

  return <>
    <div className="stats-grid curator-stats">
      <StatCard icon={<FileCheck2 size={17} />} label="Работы на проверке" value={String(reviewCount)} detail="Ждут решения куратора" accent="blue" onClick={() => onNavigate("Очередь проверки")} />
      <StatCard icon={<RotateCcw size={17} />} label="Нужна доработка" value={String(revisionCount)} detail="Ждут ответа ученика" accent="amber" onClick={() => onNavigate("Очередь проверки")} />
      <StatCard icon={<CheckCircle2 size={17} />} label="Проверено вами" value={String(reviewedByMeCount)} detail="Принято лично вами" accent="cyan" onClick={() => onNavigate("Очередь проверки")} />
      <StatCard icon={<GraduationCap size={17} />} label="Ученики в потоке" value={studentCount === null ? "—" : String(studentCount)} detail="Активные участники" accent="blue" onClick={() => onNavigate("Ученики")} />
    </div>
    <div className="curator-dashboard-widgets">
      <section className="content-panel curator-dashboard-widget">
        <div className="section-heading"><div><h2>Последние работы</h2></div><span className="progress-inline">{localQueue.length}</span></div>
        <div className="curator-dashboard-widget-list">
          {recentQueue.length > 0 ? recentQueue.map((item) => <button className="curator-dashboard-widget-row" type="button" key={item.id} onClick={() => onNavigate("Очередь проверки")}>
            {item.studentAvatarUrl ? <Image className="profile-avatar profile-avatar-image" src={item.studentAvatarUrl} alt={item.studentName} width={30} height={30} unoptimized /> : <div className="profile-avatar">{item.studentInitials}</div>}
            <div className="curator-dashboard-widget-copy"><StudentName name={item.studentName} advanced={item.studentIsAdvanced} /><span>{item.assignmentTitle}</span></div>
            <div className={`assignment-badge ${item.selfCompleted ? "gray" : item.status === "Принято" ? "green" : item.tone}`}>{item.selfCompleted ? "Без проверки" : item.status}</div>
          </button>) : <div className="empty-state"><FileCheck2 size={20} /><strong>Пока пусто</strong><span>Новые работы появятся здесь.</span></div>}
        </div>
        <button className="support-card" type="button" onClick={() => onNavigate("Очередь проверки")}><span className="support-card-label">Открыть всю очередь</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button>
      </section>
      <section className="content-panel curator-dashboard-widget">
        <div className="section-heading"><div><h2>Вопросы учеников</h2></div><span className="progress-inline">{pendingDiscussions.length}</span></div>
        <div className="curator-dashboard-widget-list">
          {pendingDiscussions.length > 0 ? pendingDiscussions.map((thread) => <button className="curator-dashboard-widget-row" type="button" key={thread.id} onClick={() => onNavigate("Обсуждения")}>
            {thread.avatarUrl ? <Image className="profile-avatar profile-avatar-image" src={thread.avatarUrl} alt={thread.student} width={30} height={30} unoptimized /> : <div className="profile-avatar">{thread.initials}</div>}
            <div className="curator-dashboard-widget-copy"><strong>{thread.title}</strong><span><span className={thread.studentIsAdvanced ? "student-name-advanced" : undefined}>{thread.student}</span>{thread.studentIsAdvanced && <em className="adv-tag" title="Advanced">ADV</em>} · {thread.module}</span></div>
            <b className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(thread.status)}</b>
          </button>) : <div className="empty-state"><MessageSquareText size={20} /><strong>Нет открытых вопросов</strong><span>Новые вопросы появятся здесь.</span></div>}
        </div>
        <button className="support-card" type="button" onClick={() => onNavigate("Обсуждения")}><span className="support-card-label">Открыть обсуждения</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button>
      </section>
      <section className="content-panel curator-dashboard-widget">
        <div className="section-heading"><div><h2>Расписание</h2></div><span className="progress-inline">{nextEvents.length}</span></div>
        <div className="curator-dashboard-widget-list">
          {nextEvents.length > 0 ? nextEvents.map((event) => <button className="curator-dashboard-widget-row" type="button" key={event.id} onClick={() => { window.sessionStorage.setItem("curator-target-schedule-event", event.id); onNavigate("Расписание"); }}>
            <div className="curator-dashboard-widget-date"><strong>{event.day}</strong><span>{event.month}</span></div>
            <div className="curator-dashboard-widget-copy"><strong>{event.title}</strong><span>{event.time}{event.kyivTimeLabel ? ` · по Киеву ${event.kyivTimeLabel}` : ""}</span></div>
            {event.id === liveScheduleEventId && <span className="curator-dashboard-widget-live-badge"><span className="live-dot" /> В эфире</span>}
          </button>) : <div className="empty-state"><CalendarDays size={20} /><strong>Ничего не запланировано</strong><span>Добавь событие в расписании.</span></div>}
        </div>
        <button className="support-card" type="button" onClick={() => onNavigate("Расписание")}><span className="support-card-label">Открыть расписание</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button>
      </section>
    </div>
    <NotificationSettingsCard />
    <PracticumManagerCard onView={onViewPracticum} isOwner={isOwner} workingPracticumId={workingPracticumId} onWorkingPracticumChange={onWorkingPracticumChange} />
  </>;
}

/**
 * One global switch (not per-practicum — see PlatformSettings in schema.prisma), for exactly one
 * workflow: a curator migrating recordings off the LiveKit box between cohorts would otherwise
 * spam students/curators with a burst of irrelevant new-content notifications. Invitations and
 * email verification bypass this entirely (see email-service.ts) — those can't go dark just
 * because a migration is in progress.
 */
function NotificationSettingsCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/notifications/settings`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: { notificationsEnabled: boolean } }> : null)
      .then((payload) => { if (!cancelled && payload?.data) setEnabled(payload.data.notificationsEnabled); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const toggle = async () => {
    if (enabled === null || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/notifications/settings`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notificationsEnabled: !enabled }),
      });
      const payload = await response.json().catch(() => ({})) as { data?: { notificationsEnabled: boolean }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить настройку.");
      setEnabled(payload.data.notificationsEnabled);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось сохранить настройку.");
    } finally {
      setSaving(false);
    }
  };

  return <section className="content-panel notification-settings-card">
    <div className="notification-settings-head">
      <div>
        <h2>Уведомления ученикам и кураторам</h2>
        <p className="section-heading-note">Колокольчик и письма о новых уроках, ДЗ, записях и обсуждениях. Выключите на время переноса записей между потоками — приглашения и подтверждение почты продолжат работать в любом случае.</p>
      </div>
      <button type="button" className={`notification-settings-switch ${enabled ? "on" : ""}`} role="switch" aria-checked={enabled ?? false} aria-label="Уведомления ученикам и кураторам" disabled={enabled === null || saving} onClick={() => void toggle()}>
        <span className="notification-settings-switch-knob" />
      </button>
    </div>
    <span className="notification-settings-status">{enabled === null ? "Загрузка…" : enabled ? "Включены" : "Выключены — новые уроки, ДЗ и записи никого не потревожат"}</span>
    {error && <div className="file-error" role="alert">{error}</div>}
  </section>;
}

type PracticumSummary = { id: string; title: string; description: string | null; isActive: boolean; streamsPrivate: boolean; completedAt: string | null; createdAt: string };

/**
 * Lists every practicum (current and past) — visible to any curator. Two independent, decoupled
 * things happen here:
 *  - "Работать здесь" — a personal pick (User.workingPracticumId), available to any curator/owner.
 *    Drives where THEIR new content (modules/schedule/media/invitations) gets created — see
 *    practicum-service.ts#getWorkingPracticumId. Two staff members can point at different
 *    practicums at once; switching is instant, no confirmation, fully reversible.
 *  - "Назначить для эфиров" — owner-only, flips Practicum.isActive. Only affects live-streaming
 *    targeting (LiveKit ingress, "Стримы") — unrelated to content creation, deliberately untouched
 *    by this feature.
 * "Просмотреть" (any curator) opens a non-working practicum's Программа/Медиатека/Расписание
 * read-only — see PracticumManagerCard#onView and course-service.ts/schedule-service.ts's
 * viewPracticumId option. A finished practicum's own students keep seeing exactly what they
 * always saw, regardless of anyone's working pick or the live-stream target.
 */
function PracticumManagerCard({ onView, isOwner, workingPracticumId, onWorkingPracticumChange }: { onView: (practicum: PracticumSummary) => void; isOwner: boolean; workingPracticumId: string | null; onWorkingPracticumChange: (nextId: string | null) => void }) {
  const [practicums, setPracticums] = useState<PracticumSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [switchingWorkId, setSwitchingWorkId] = useState("");
  const [togglingPrivateId, setTogglingPrivateId] = useState("");
  const [togglingCompletedId, setTogglingCompletedId] = useState("");
  const [notice, setNotice] = useState("");

  const loadPracticums = useCallback(async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/practicums`, { credentials: "include", cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { data?: PracticumSummary[] };
      if (response.ok && Array.isArray(payload.data)) setPracticums(payload.data);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => { void loadPracticums(); }, [loadPracticums]);

  const startNewPracticum = async () => {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    if (!window.confirm(`Начать новый поток «${trimmed}»? Текущий поток останется как есть и доступен своим ученикам — но эфиры и ваш личный рабочий поток переключатся на новый.`)) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/practicum`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: trimmed }) });
      const payload = await response.json().catch(() => ({})) as { message?: string; data?: { id: string } };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось начать новый поток.");
      setTitle("");
      setNotice(`Новый поток «${trimmed}» запущен.`);
      if (payload.data?.id) onWorkingPracticumChange(payload.data.id);
      await loadPracticums();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось начать новый поток.");
    } finally {
      setSaving(false);
    }
  };

  const switchActiveTo = async (practicum: PracticumSummary) => {
    if (saving) return;
    if (!window.confirm(`Назначить поток «${practicum.title}» целью для эфиров? Не влияет на то, где кто-то из кураторов создаёт контент — только на «Стримы».`)) return;
    setSaving(true);
    setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/practicums/${practicum.id}/activate`, { method: "POST", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось переключить поток для эфиров.");
      setNotice(`Для эфиров назначен поток «${practicum.title}».`);
      await loadPracticums();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось переключить поток для эфиров.");
    } finally {
      setSaving(false);
    }
  };

  const workHere = async (practicum: PracticumSummary) => {
    if (switchingWorkId) return;
    setSwitchingWorkId(practicum.id);
    setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/working-practicum`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ practicumId: practicum.id }) });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось переключить рабочий поток.");
      onWorkingPracticumChange(practicum.id);
      setNotice(`Теперь вы создаёте контент в потоке «${practicum.title}».`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось переключить рабочий поток.");
    } finally {
      setSwitchingWorkId("");
    }
  };

  const [deletePanelId, setDeletePanelId] = useState("");
  const [deletionImpact, setDeletionImpact] = useState<{ enrollments: number; modules: number; scheduleEvents: number; mediaAssets: number; assignments: number } | null>(null);
  const [loadingImpact, setLoadingImpact] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingPracticumId, setDeletingPracticumId] = useState("");
  const [deleteFlowError, setDeleteFlowError] = useState("");

  const openDeletePanel = async (practicum: PracticumSummary) => {
    setDeletePanelId(practicum.id);
    setDeleteConfirmText("");
    setDeleteFlowError("");
    setDeletionImpact(null);
    setLoadingImpact(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/practicums/${practicum.id}/deletion-impact`, { credentials: "include", cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { data?: { enrollments: number; modules: number; scheduleEvents: number; mediaAssets: number; assignments: number }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось загрузить данные о потоке.");
      setDeletionImpact(payload.data);
    } catch (error) {
      setDeleteFlowError(error instanceof Error ? error.message : "Не удалось загрузить данные о потоке.");
    } finally {
      setLoadingImpact(false);
    }
  };

  const closeDeletePanel = () => {
    setDeletePanelId("");
    setDeleteConfirmText("");
    setDeleteFlowError("");
    setDeletionImpact(null);
  };

  // Two confirmations by design, not one: typing the exact title catches "clicked the wrong row",
  // the window.confirm right after catches "typed it on autopilot" — the two together are what
  // the tester asked for so a whole cohort's history can't go with a single misclick.
  const confirmDeletePracticum = async (practicum: PracticumSummary) => {
    if (deletingPracticumId || deleteConfirmText.trim() !== practicum.title) return;
    if (!window.confirm(`Это последнее подтверждение. Поток «${practicum.title}» и всё, что в нём — ученики, зачисления, задания, записи, расписание, обсуждения — будут удалены навсегда, без возможности восстановить. Продолжить?`)) return;
    setDeletingPracticumId(practicum.id);
    setDeleteFlowError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/practicums/${practicum.id}`, { method: "DELETE", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmTitle: deleteConfirmText.trim() }) });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось удалить поток.");
      closeDeletePanel();
      setNotice(`Поток «${practicum.title}» удалён.`);
      await loadPracticums();
    } catch (error) {
      setDeleteFlowError(error instanceof Error ? error.message : "Не удалось удалить поток.");
    } finally {
      setDeletingPracticumId("");
    }
  };

  // Per-practicum, not global — a new cohort always starts with this off, regardless of what an
  // older one was set to. See Practicum.streamsPrivate and stream-visibility.ts.
  const togglePrivate = async (practicum: PracticumSummary) => {
    if (togglingPrivateId) return;
    setTogglingPrivateId(practicum.id);
    setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/practicums/${practicum.id}/streams-private`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ streamsPrivate: !practicum.streamsPrivate }) });
      const payload = await response.json().catch(() => ({})) as { data?: PracticumSummary; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось изменить видимость эфира.");
      setPracticums((current) => current.map((item) => item.id === practicum.id ? payload.data! : item));
      setNotice(payload.data.streamsPrivate ? `Эфир потока «${practicum.title}» скрыт от учеников.` : `Эфир потока «${practicum.title}» снова виден ученикам.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось изменить видимость эфира.");
    } finally {
      setTogglingPrivateId("");
    }
  };

  // Reversible — students of this practicum keep full read access (modules, ДЗ history,
  // recordings); only submitting/resubmitting ДЗ and writing in "Обсуждения" get blocked while
  // this is on. See Practicum.completedAt in schema.prisma.
  const toggleCompleted = async (practicum: PracticumSummary) => {
    if (togglingCompletedId) return;
    const nextCompleted = !practicum.completedAt;
    if (nextCompleted && !window.confirm(`Завершить поток «${practicum.title}»? Ученики сохранят доступ на просмотр (уроки, ДЗ, записи), но больше не смогут отправлять ДЗ и писать в обсуждениях. Действие обратимо — поток можно будет открыть обратно в любой момент.`)) return;
    setTogglingCompletedId(practicum.id);
    setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/practicums/${practicum.id}/completed`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ completed: nextCompleted }) });
      const payload = await response.json().catch(() => ({})) as { data?: PracticumSummary; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось изменить статус потока.");
      setPracticums((current) => current.map((item) => item.id === practicum.id ? payload.data! : item));
      setNotice(payload.data.completedAt ? `Поток «${practicum.title}» завершён — доступен только на просмотр.` : `Поток «${practicum.title}» снова открыт.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось изменить статус потока.");
    } finally {
      setTogglingCompletedId("");
    }
  };

  return <section className="content-panel curator-dashboard-widget">
    <div className="section-heading"><div><h2>Потоки</h2><p className="section-heading-note">Новый урок, событие, медиа и приглашение по умолчанию уходят в ваш личный рабочий поток — у каждого куратора он может быть свой. Отдельно, только для эфиров, поток назначает владелец.</p></div></div>
    {loaded && practicums.length > 0 && <div className="curator-dashboard-widget-list">
      {practicums.map((practicum) => { const isMine = workingPracticumId ? practicum.id === workingPracticumId : practicum.isActive; return <Fragment key={practicum.id}><div className="curator-dashboard-widget-row">
        <div className="curator-dashboard-widget-copy"><strong>{practicum.title}</strong><span>{new Date(practicum.createdAt).toLocaleDateString("ru-RU")}</span></div>
        <div className="curator-dashboard-widget-row-actions">
          {practicum.isActive && <span className="assignment-badge green">Эфиры здесь</span>}
          {practicum.streamsPrivate && <span className="assignment-badge amber">Эфир скрыт от учеников</span>}
          {practicum.completedAt && <span className="assignment-badge gray">Завершён · только просмотр</span>}
          {isMine
            ? <span className="assignment-badge blue">Вы здесь работаете</span>
            : <button className="secondary-button" type="button" disabled={switchingWorkId === practicum.id} onClick={() => void workHere(practicum)}>Работать здесь</button>}
          {!isMine && <button className="secondary-button" type="button" onClick={() => onView(practicum)}>Просмотреть</button>}
          {isOwner && !practicum.isActive && <button className="secondary-button" type="button" disabled={saving} onClick={() => void switchActiveTo(practicum)}>Назначить для эфиров</button>}
          <button className="secondary-button stream-visibility-button" type="button" disabled={togglingPrivateId === practicum.id} onClick={() => void togglePrivate(practicum)}>{togglingPrivateId === practicum.id ? "Сохраняем…" : practicum.streamsPrivate ? "Показать эфир ученикам" : "Скрыть эфир от учеников"}</button>
          <button className="secondary-button" type="button" disabled={togglingCompletedId === practicum.id} onClick={() => void toggleCompleted(practicum)}>{togglingCompletedId === practicum.id ? "Сохраняем…" : practicum.completedAt ? "Открыть поток обратно" : "Завершить поток"}</button>
          {isOwner && (practicum.isActive
            ? <button className="secondary-button danger-button" type="button" disabled title="Сначала назначьте другой поток для эфиров"><Trash2 size={15} /> Удалить поток</button>
            : <button className="secondary-button danger-button" type="button" onClick={() => void openDeletePanel(practicum)}><Trash2 size={15} /> Удалить поток</button>)}
        </div>
      </div>
      {isOwner && deletePanelId === practicum.id && <div className="curator-dashboard-widget-row practicum-delete-panel">
        <div className="practicum-delete-warning">
          <strong>Удалить поток «{practicum.title}» навсегда?</strong>
          {loadingImpact ? <span>Считаем, что удалится…</span> : deletionImpact ? <span>Будут безвозвратно удалены: {deletionImpact.enrollments} {deletionImpact.enrollments === 1 ? "зачисление" : "зачислений"} (ученики), {deletionImpact.modules} {deletionImpact.modules === 1 ? "урок" : "уроков"}, {deletionImpact.assignments} {deletionImpact.assignments === 1 ? "задание" : "заданий"}, {deletionImpact.scheduleEvents} {deletionImpact.scheduleEvents === 1 ? "событие расписания" : "событий расписания"}, {deletionImpact.mediaAssets} {deletionImpact.mediaAssets === 1 ? "запись" : "записей"} в медиатеке — вместе со всеми ДЗ, перепиской и историей входов учеников этого потока. Отменить это будет нельзя.</span> : null}
          {deleteFlowError && <span className="file-error" role="alert">{deleteFlowError}</span>}
          <label className="form-field"><span>Чтобы подтвердить, введите название потока: «{practicum.title}»</span><input value={deleteConfirmText} onChange={(event) => setDeleteConfirmText(event.target.value)} placeholder={practicum.title} /></label>
        </div>
        <div className="curator-dashboard-widget-row-actions">
          <button className="secondary-button" type="button" onClick={closeDeletePanel} disabled={deletingPracticumId === practicum.id}>Отмена</button>
          <button className="secondary-button danger-button" type="button" disabled={deletingPracticumId === practicum.id || loadingImpact || deleteConfirmText.trim() !== practicum.title} onClick={() => void confirmDeletePracticum(practicum)}>{deletingPracticumId === practicum.id ? "Удаляем…" : "Удалить навсегда"}</button>
        </div>
      </div>}
      </Fragment>; })}
    </div>}
    {isOwner && <div className="media-editor-body">
      <div className="media-editor-fields">
        <label className="form-field"><span>Название нового потока</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Поток 05 · Октябрь" /></label>
      </div>
      <div className="media-form-actions">
        <button className="primary-button" type="button" disabled={!title.trim() || saving} onClick={() => void startNewPracticum()}>{saving ? "Сохраняем…" : "Начать новый поток"} <ChevronRight size={16} /></button>
        {notice && <span className="form-action-feedback"><Target size={16} /> {notice}</span>}
      </div>
    </div>}
    {!isOwner && notice && <div className="media-editor-body practicum-notice-row"><span className="form-action-feedback"><Target size={16} /> {notice}</span></div>}
  </section>;
}

function CuratorReviewWorkspace({ onNavigate }: { onNavigate?: (nextNav: CuratorNav) => void }) {
  // Defaults to "Активные" (на проверке + доработка) — the queue keeps every accepted work too, and
  // with a whole поток submitting, "Все" turned the page into an endless scroll of done items.
  const [filter, setFilter] = useState<"active" | "all" | AssignmentStatus>("active");
  const [studentFilter, setStudentFilter] = useState("");
  const [localQueue, setLocalQueue] = useState<ReviewQueueItem[]>([]);
  const [selectedId, setSelectedId] = useState(() => localQueue[0]?.id ?? "");
  const [studentCount, setStudentCount] = useState<number | null>(null);
  useEffect(() => {
    const handleSubmitted = (event: Event) => {
      if (event.type !== assignmentSubmittedEvent) return;
      // Keep the work the curator is on — "Взять на проверку" refreshes the queue, and resetting to
      // queue[0] jumped them to someone else's work right after claiming (2026-10-04).
      void fetchReviewQueue().then((queue) => { setLocalQueue(queue); setSelectedId((current) => (queue.some((item) => item.id === current) ? current : queue[0]?.id ?? "")); }).catch(() => setLocalQueue([]));
    };
    void fetchReviewQueue().then((queue) => { setLocalQueue(queue); setSelectedId(queue[0]?.id ?? ""); }).catch(() => setLocalQueue([]));
    window.addEventListener(assignmentSubmittedEvent, handleSubmitted);
    return () => window.removeEventListener(assignmentSubmittedEvent, handleSubmitted);
  }, []);
  useEffect(() => {
    // The "Ученики в потоке" stat used to always show the fixture's static "18 учеников"
    // regardless of the real cohort size — same class of bug as the profile name below. Scoped to
    // the active поток, like the dashboard's counter: without practicumId the API counts every
    // student on the platform, finished cohorts included.
    let cancelled = false;
    void (async () => {
      const list = await fetch(`${API_ORIGIN}/api/course/practicums`, { credentials: "include", cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ data?: PracticumSummary[] }> : null)
        .catch(() => null);
      const activeId = list?.data?.find((practicum) => practicum.isActive)?.id;
      const payload = await fetch(`${API_ORIGIN}/api/security/students${activeId ? `?practicumId=${encodeURIComponent(activeId)}` : ""}`, { credentials: "include", cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<{ data?: unknown[] }> : null)
        .catch(() => null);
      if (!cancelled && Array.isArray(payload?.data)) setStudentCount(payload.data.length);
    })();
    return () => { cancelled = true; };
  }, []);
  const studentOptions = useMemo(() => [...new Set(localQueue.map((item) => item.studentName).filter(Boolean))].sort((left, right) => left.localeCompare(right, "ru")), [localQueue]);
  const studentQueue = studentFilter ? localQueue.filter((item) => item.studentName === studentFilter) : localQueue;
  // "Активные" = waiting for a curator. A work sent back for revision is waiting for the student,
  // so it lives under "Доработка" only (2026-10-04: it used to stay here and the list never shrank).
  const isActiveItem = (item: ReviewQueueItem) => item.status === "На проверке";
  // The whole workspace fits the screen: the list and the review panel each scroll on their own,
  // the page itself doesn't grow with the queue (curators lost the bottom works and the panel).
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [workspaceHeight, setWorkspaceHeight] = useState<number | null>(null);
  useEffect(() => {
    const measure = () => {
      const element = workspaceRef.current;
      if (!element || window.innerWidth <= 1000) { setWorkspaceHeight(null); return; }
      const scroller = element.closest(".content-area");
      const scrolled = scroller && scroller.scrollHeight > scroller.clientHeight ? scroller.scrollTop : window.scrollY;
      const top = element.getBoundingClientRect().top + scrolled;
      setWorkspaceHeight(Math.max(420, window.innerHeight - top - 20));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  const matchesFilter = (item: ReviewQueueItem, id: typeof filter) => id === "all" ? true : id === "active" ? isActiveItem(item) : item.status === id;
  const filteredQueue = studentQueue.filter((item) => matchesFilter(item, filter));
  const selectedItem = filteredQueue.find((item) => item.id === selectedId) ?? filteredQueue[0] ?? emptyReviewQueueItem;
  const filters: Array<{ id: typeof filter; label: string }> = [
    { id: "active", label: "Активные" },
    { id: "На проверке", label: "На проверке" },
    { id: "Нужна доработка", label: "Доработка" },
    { id: "Принято", label: "Принято" },
    { id: "all", label: "Все" },
  ];

  return <div className="curator-workspace review-workspace-fit" ref={workspaceRef} style={workspaceHeight ? { "--review-fit-height": `${workspaceHeight}px` } as CSSProperties : undefined}>
    <section className="content-panel review-queue">
      <div className="section-heading"><div><span className="section-kicker">{baseCuratorDashboard.cohort.name.toUpperCase()}</span><h2>Очередь проверки</h2></div><div className="section-heading-actions"><span className="progress-inline">{studentCount === null ? "…" : pluralizeStudents(studentCount)}</span>{onNavigate && <button className="primary-button compact-button curator-create-assignment-button" onClick={() => onNavigate("Создать задание")}><Plus size={15} /> Создать задание</button>}</div></div>
      <div className="assignment-filter curator-filter">{filters.map((item) => { const count = studentQueue.filter((queueItem) => matchesFilter(queueItem, item.id)).length; return <button className={`filter-chip ${filter === item.id ? "active" : ""}`} key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{count}</span></button>; })}</div>
      <label className="review-student-filter"><span>Ученик</span><select value={studentFilter} onChange={(event) => setStudentFilter(event.target.value)} aria-label="Фильтр очереди по ученику"><option value="">Все ученики</option>{studentOptions.map((student) => <option value={student} key={student}>{student}</option>)}</select></label>
      <div className="review-queue-list">{filteredQueue.length > 0 ? filteredQueue.map((item) => <CuratorQueueRow item={item} selected={item.id === selectedItem.id} key={item.id} onOpen={() => setSelectedId(item.id)} />) : <div className="empty-state"><FileCheck2 size={22} /><strong>Очередь пуста</strong><span>{studentFilter ? "У выбранного ученика нет работ с таким статусом." : filter === "active" ? "Сейчас нет работ, которые ждут проверки или доработки. Принятые — во вкладке «Принято» или «Все»." : "Новые отправки появятся здесь после отправки задания учеником."}</span></div>}</div>
    </section>
    <CuratorReviewPanel item={selectedItem} key={selectedItem.id} />
  </div>;
}

function CuratorQueueRow({ item, selected, onOpen }: { item: ReviewQueueItem; selected: boolean; onOpen: () => void }) {
  // A student's face is what a curator actually recognizes at a glance once the cohort
  // grows — the module is already named in the row's own subtitle below.
  // "Принято" shared the same blue badge as "На проверке" — a curator couldn't tell reviewed
  // from pending at a glance. Green for accepted matches the tone the student's own
  // assignment list already uses for the same status.
  const effectiveTone = item.status === "Принято" ? "green" : item.tone;
  // A resubmission after "Вернуть на доработку" goes straight back to the curator who returned it
  // (assignment-service carries reviewerId over), but in the list it looked like any first attempt
  // (2026-10-05). Tag it with that curator's name — bright when it's yours, muted when someone else's.
  const attemptNumber = Number(item.attempt.match(/\d+/)?.[0] ?? 1);
  const isResubmission = item.status === "На проверке" && attemptNumber > 1;
  const resubmissionMine = isResubmission && Boolean(item.reviewerId) && item.isReviewerSelf === true;
  const resubmissionLabel = item.reviewerName ? `Доработка · ${item.reviewerName}` : "Доработка";
  return <button className={`review-queue-row ${selected ? "selected" : ""}`} onClick={onOpen} aria-pressed={selected}>{item.studentAvatarUrl ? <Image className="profile-avatar profile-avatar-image" src={item.studentAvatarUrl} alt={item.studentName} width={31} height={31} unoptimized /> : <div className="profile-avatar">{item.studentInitials}</div>}<div className="review-queue-copy"><StudentName name={item.studentName} advanced={item.studentIsAdvanced} /><span>{item.assignmentTitle} · {item.module}</span><small>{item.submittedAt} · {item.attempt}</small></div>{isResubmission && <span className={`review-resubmission-tag ${resubmissionMine ? "mine" : ""}`} title={item.reviewerName ? `Повторная попытка после доработки — принимает ${item.reviewerName}` : "Повторная попытка после доработки"}>{resubmissionLabel}</span>}<div className={`assignment-badge ${item.selfCompleted ? "gray" : effectiveTone}`}>{item.selfCompleted ? "Без проверки" : item.status}</div><ChevronRight size={16} /></button>;
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

  return <section className="content-panel curator-review"><div className="curator-review-header"><div className="curator-student"><div className="profile-avatar">{item.studentInitials}</div><div><span className="section-kicker">{item.module}</span><StudentName name={item.studentName} advanced={item.studentIsAdvanced} /><small>Прогресс потока · {item.progress}</small></div></div><div className={`assignment-badge ${item.tone}`}>{decision === "accepted" ? "Принято" : decision === "revision" ? "Возвращено" : item.status}</div></div><div className="submission-meta"><span><Clock3 size={14} /> Отправлено {item.submittedAt}</span><span><FileCheck2 size={14} /> {item.attempt}</span></div><div className="curator-review-body"><div className="submission-section submission-answer-section"><span className="detail-label">КОММЕНТАРИЙ УЧЕНИКА</span><p className="submission-answer">{linkifyText(item.answer)}</p><p className="student-note"><MessageSquareText size={14} /> {item.studentNote}</p></div><div className="submission-section"><span className="detail-label">ВЛОЖЕНИЯ</span><div className="submission-files">{item.attachments.length > 0 ? item.attachments.map((attachment) => { const file = item.attachmentFiles?.find((candidate) => candidate.name === attachment); return <div className={`submission-file-card ${file ? "has-preview" : ""}`} key={attachment}>{file?.type.startsWith("image/") && <><span className="visually-hidden">Предпросмотр изображения {file.name}</span><div className="submission-image-preview" role="img" aria-label={`Предпросмотр вложения ${file.name}`} style={{ backgroundImage: `url("${API_ORIGIN}${file.url}")` }} /></>}{file?.type.startsWith("video/") && <video src={`${API_ORIGIN}${file.url}`} controls preload="metadata" />}<a className="submission-file" href={file ? `${API_ORIGIN}${file.url}` : undefined} target={file ? "_blank" : undefined} rel={file ? "noreferrer" : undefined}><FileCheck2 size={16} /><span>{attachment}</span><ArrowUpRight size={14} /></a></div>; }) : <p className="submission-empty-file">Работа отправлена без вложений.</p>}</div>{item.attachments.length > 0 && <p className="attachment-preview-note">Файл доступен только участникам этой проверки.</p>}</div><div className="submission-section"><span className="detail-label">ИСТОРИЯ ПОПЫТОК</span><div className="attempt-history"><div><span className="attempt-dot done" /><div><strong>Попытка 1</strong><small>{item.submittedAt} · Отправлено на проверку</small></div></div><div><span className={`attempt-dot ${isRevision ? "current" : "muted"}`} /><div><strong>{item.attempt}</strong><small>{isRevision ? "Текущая работа требует внимания" : "Работа ожидает решения куратора"}</small></div></div></div></div><div className="curator-feedback"><label className="detail-label" htmlFor="curator-feedback">ОБРАТНАЯ СВЯЗЬ</label><textarea id="curator-feedback" onKeyDown={continueNumberedList} value={feedback} onChange={(event) => { setFeedback(event.target.value); setDecision(null); }} placeholder="Напиши, что получилось и что нужно поправить..." rows={4} /><label className={`video-feedback ${videoName ? "has-file" : ""}`} htmlFor="curator-video"><Play size={17} /><span>{videoName || "Добавить видеоразбор"}</span><small>MP4 или WebM · до 500 МБ</small><input id="curator-video" type="file" accept="video/mp4,video/webm" onChange={(event) => setVideoName(event.target.files?.[0]?.name ?? "")} /></label>{decision && <div className="detail-feedback curator-decision"><Target size={17} /><div><strong>{decision === "accepted" ? "Работа принята" : "Работа возвращена на доработку"}</strong><p>В предпросмотре статус обновлён. В API это станет транзакцией с историей проверки и уведомлением ученика.</p></div></div>}<div className="curator-actions"><button className="secondary-button" disabled={!feedback.trim()} onClick={() => setDecision("revision")}>Вернуть на доработку</button><button className="primary-button" onClick={() => setDecision("accepted")}>Принять работу <ChevronRight size={16} /></button></div></div></div></section>;
}

function CuratorReviewPanel({ item }: { item: ReviewQueueItem }) {
  const [feedback, setFeedback] = useState("");
  const [decisionError, setDecisionError] = useState("");
  const [claimError, setClaimError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [checkedCriteria, setCheckedCriteria] = useState<boolean[]>(() => (item.requirements ?? []).map(() => false));
  const [previewFile, setPreviewFile] = useState<NonNullable<ReviewQueueItem["attachmentFiles"]>[number] | null>(null);
  const [zoomImageUrl, setZoomImageUrl] = useState("");
  const [openAttemptNumber, setOpenAttemptNumber] = useState<number | null>(null);
  useEffect(() => {
    if (!zoomImageUrl && openAttemptNumber === null) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setZoomImageUrl(""); setOpenAttemptNumber(null); } };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [zoomImageUrl, openAttemptNumber]);
  // Same hook the discussion composer uses — supports several files at once (see
  // DiscussionAttachmentPreviewList below), unlike the old single-File state this replaced, which
  // silently dropped the first photo whenever a curator attached a second one.
  const feedbackAttachments = useDiscussionAttachments();
  const files = item.attachmentFiles ?? [];
  const currentAttemptNumber = Number.parseInt(item.attempt.replace(/\D/g, ""), 10) || 1;
  const attemptHistory = item.attemptHistory?.length ? item.attemptHistory : [{ attempt: currentAttemptNumber, status: item.status, submittedAt: item.submittedAt, answerText: item.answer, files, feedback: [] }];
  const openAttempt = attemptHistory.find((attempt) => attempt.attempt === openAttemptNumber) ?? null;

  // NEEDS_REVISION/ACCEPTED submissions carry a reviewerId too (the curator who last decided
  // them), but there's nothing to decide right now — NEEDS_REVISION is waiting on the student
  // to resubmit, and the backend's nextSubmissionStatus() only accepts a decision from
  // SUBMITTED/IN_REVIEW ("На проверке"). Gating on status here keeps the buttons disabled
  // instead of letting a click reach the server and bounce back as a raw error.
  const canDecide = Boolean(item.reviewerId) && item.isReviewerSelf !== false && item.status === "На проверке";
  const awaitingResubmission = item.status === "Нужна доработка" && item.isReviewerSelf !== false;

  const handleFeedbackPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter((entry) => entry.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    const files = imageItems.map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      const extension = item.type.split("/")[1] || "png";
      return new File([file], `screenshot-${Date.now()}-${index}.${extension}`, { type: item.type });
    }).filter((file): file is File => file !== null);
    feedbackAttachments.addFiles(files);
  };

  const submitDecision = async (nextDecision: "accepted" | "revision") => {
    if (!item.reviewerId) {
      setClaimError("Сначала возьмите работу на проверку.");
      return;
    }
    if (!canDecide) return;
    setDecisionError("");
    const checkedRequirements = (item.requirements ?? []).filter((_, index) => checkedCriteria[index]);
    let uploadedFileIds: string[] = [];
    try {
      const uploaded = await feedbackAttachments.uploadAll();
      uploadedFileIds = uploaded.uploadedFileIds;
      const response = await fetch(`${API_ORIGIN}/api/review/submissions/${item.id}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: nextDecision,
          feedback: feedback.trim() || undefined,
          checkedRequirements: checkedRequirements.length > 0 ? checkedRequirements : undefined,
          attachments: uploaded.payload.length > 0 ? uploaded.payload : undefined,
        }),
      });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось сохранить решение.");
      setFeedback("");
      feedbackAttachments.clear();
      window.dispatchEvent(new Event(assignmentSubmittedEvent));
    } catch (error) {
      for (const fileId of uploadedFileIds) void fetch(`${API_ORIGIN}/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
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

  // Claimed by mistake, or a curator ran out of time — releasing hands the submission back
  // to the shared queue so another curator can pick it up instead of it sitting stuck.
  const releaseWork = async () => {
    if (releasing) return;
    setReleasing(true);
    setClaimError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/review/submissions/${item.id}/release`, { method: "POST", credentials: "include" });
      const payload = await response.json() as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось отменить взятие работы.");
      window.dispatchEvent(new Event(assignmentSubmittedEvent));
    } catch (error) {
      setClaimError(error instanceof Error ? error.message : "Не удалось отменить взятие работы.");
    } finally {
      setReleasing(false);
    }
  };

  if (!item.id) return <section className="content-panel curator-review directory-empty"><div className="empty-state"><FileCheck2 size={24} /><strong>Очередь проверки пока пуста</strong><span>После отправки задания работа появится здесь вместе с ответом и вложениями.</span></div></section>;

  return <section className="content-panel curator-review">
    {item.reviewerId ? (
      item.isReviewerSelf === false
        ? <div className="review-claim-banner review-claim-banner-other"><strong>Проверяет: {item.reviewerName ?? "другой куратор"}</strong><span>Работа закреплена за другим куратором — принять или вернуть на доработку нельзя.</span></div>
        : (() => { const hasPriorRevision = (item.attemptHistory?.length ?? 0) > 1; return <div className="review-claim-banner"><strong>Проверяете вы</strong><span>{hasPriorRevision ? "Вы уже отправляли эту работу на доработку — доведите проверку до конца." : "Работа закреплена за вами."}</span>{!hasPriorRevision && <button type="button" className="primary-button compact-button curator-create-assignment-button review-release-button" onClick={() => void releaseWork()} disabled={releasing}>{releasing ? "Отменяем…" : "Отменить взятие"}</button>}</div>; })()
    ) : <button type="button" className="primary-button review-claim-button" onClick={() => void claimWork()} disabled={claiming}>{claiming ? "Закрепляем…" : "Взять на проверку"}</button>}
    {claimError && <div className="file-error" role="alert">{claimError}</div>}
    <div className="curator-review-header"><div className="curator-student">{item.studentAvatarUrl ? <Image className="profile-avatar profile-avatar-image" src={item.studentAvatarUrl} alt={item.studentName} width={31} height={31} unoptimized /> : <div className="profile-avatar">{item.studentInitials}</div>}<StudentName name={item.studentName} advanced={item.studentIsAdvanced} /></div></div>
    {item.coverPath && <div className="curator-review-cover" role="img" aria-label={`Обложка ${item.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(0,0,0,.92), rgba(0,0,0,.3)), url("${item.coverPath}")` }}><strong>{item.module}</strong><span>{item.assignmentTitle}</span></div>}
    <div className="curator-review-body">
      <div className="submission-section submission-answer-section"><span className="detail-label">ОТВЕТ УЧЕНИКА</span><p className="submission-answer">{linkifyText(item.answer)}</p><p className="student-note"><MessageSquareText size={14} /> {item.studentNote}</p></div>
      {item.requirements && item.requirements.length > 0 && <div className="submission-section review-criteria"><div className="review-section-heading"><div><span className="detail-label">КРИТЕРИИ ПРОВЕРКИ</span><small>{item.status === "Принято" ? "Отмечено на момент принятия работы — необязательно все." : "Отметь то, что ученик выполнил чётко. Работу можно принять и без всех галочек."}</small></div><strong>{(item.status === "Принято" ? (item.checkedRequirements?.length ?? 0) : checkedCriteria.filter(Boolean).length)}/{item.requirements.length}</strong></div><div className="review-criteria-list">{item.requirements.map((requirement, index) => { const checked = item.status === "Принято" ? (item.checkedRequirements?.includes(requirement) ?? false) : (checkedCriteria[index] ?? false); return <label className={`review-criteria-item ${checked ? "checked" : ""}`} key={`${item.id}-${requirement}`}><input type="checkbox" checked={checked} disabled={item.status === "Принято"} onChange={() => setCheckedCriteria((current) => current.map((value, currentIndex) => currentIndex === index ? !value : value))} /><span className="review-criteria-box">✓</span><span>{requirement}</span></label>; })}</div></div>}
      {(files.length > 0 || item.attachments.length > 0) && <div className="submission-section"><span className="detail-label">ВЛОЖЕНИЯ</span><div className="submission-files">
        {files.length > 0 ? files.map((file) => <div className="submission-file-card has-preview" key={file.id}>
          {file.type.startsWith("image/") && <button type="button" className="submission-image-preview submission-image-preview-button" aria-label={`Увеличить изображение ${file.name}`} onClick={() => setZoomImageUrl(`${API_ORIGIN}${file.url}`)}><Image src={`${API_ORIGIN}${file.url}`} alt={`Предпросмотр вложения ${file.name}`} fill sizes="(max-width: 700px) 100vw, 720px" unoptimized /><span className="submission-image-preview-zoom-hint"><Maximize2 size={13} /> Увеличить</span></button>}
          {file.type.startsWith("video/") && <video src={`${API_ORIGIN}${file.url}`} controls preload="metadata" />}
          <button type="button" className="submission-file" onClick={() => file.type.startsWith("image/") ? setZoomImageUrl(`${API_ORIGIN}${file.url}`) : setPreviewFile(file)}><FileCheck2 size={16} /><span>{file.name}</span><Maximize2 size={14} /></button>
        </div>) : <div className="submission-legacy-file"><FileCheck2 size={16} /><div><strong>{[...new Set(item.attachments)].join(", ")}</strong><span>Это вложение сохранено до подключения защищённого хранилища. Попросите ученика отправить работу повторно.</span></div></div>}
      </div><p className="attachment-preview-note">Предпросмотр открыт внутри платформы и доступен только участникам этой проверки.</p></div>}
        <div className="submission-section review-history-section"><div className="review-section-heading"><span className="detail-label">ИСТОРИЯ ПОПЫТОК</span></div><div className="attempt-history">{attemptHistory.map((attempt) => { const isCurrent = attempt.attempt === currentAttemptNumber; const dotTone = attempt.status === "Принято" ? "done" : isCurrent ? "current" : "muted"; const statusLabel = attempt.status === "На проверке" ? "Отправлено на проверку" : attempt.status; return <button type="button" className="attempt-history-row" key={attempt.attempt} onClick={() => setOpenAttemptNumber(attempt.attempt)}><span className={`attempt-dot ${dotTone}`} /><div><strong>Попытка {attempt.attempt}{isCurrent ? " · текущая" : ""}</strong><small>{attempt.submittedAt} · {statusLabel}</small></div><ChevronRight size={15} /></button>; })}</div></div>
      <div className="curator-feedback"><label className="detail-label" htmlFor="curator-feedback">ВАШ ОТВЕТ</label><textarea id="curator-feedback" onKeyDown={continueNumberedList} value={feedback} onChange={(event) => setFeedback(event.target.value)} onPaste={handleFeedbackPaste} placeholder={item.status === "Принято" ? "Работа уже принята — история проверки доступна выше." : awaitingResubmission ? "Ждём доработку от ученика — как только он отправит новую попытку, здесь снова будет можно оставить ответ." : "Напиши, что получилось и что нужно поправить… Скриншот можно вставить через Ctrl+V"} rows={4} disabled={item.status === "Принято" || !canDecide} />{item.status !== "Принято" && canDecide && <label className={`discussion-attachment-picker ${feedbackAttachments.attachments.length > 0 ? "has-file" : ""}`} htmlFor="curator-feedback-attachment"><FileCheck2 size={17} /><span>{feedbackAttachments.attachments.length > 0 ? `Прикреплено файлов: ${feedbackAttachments.attachments.length}` : "Прикрепить скриншот или файл"}</span><small>PNG, JPG, PDF, MP4, WebM · до 10 МБ за файл · можно прикрепить сразу несколько, или вставить скриншот через Ctrl+V</small><input id="curator-feedback-attachment" type="file" multiple accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => { feedbackAttachments.addFiles(event.target.files); event.target.value = ""; }} /></label>}{feedbackAttachments.error && <div className="file-error" role="alert">{feedbackAttachments.error}</div>}<DiscussionAttachmentPreviewList attachments={feedbackAttachments.attachments} onRemove={feedbackAttachments.removeAt} />{decisionError && <div className="file-error" role="alert">{decisionError}</div>}{item.status === "Принято" && <div className="detail-feedback curator-decision"><CheckCircle2 size={17} /><div><strong>Работа уже принята</strong><p>Повторная попытка для этого задания не создаётся. Все предыдущие ответы и комментарии сохранены в истории ученика.</p></div></div>}{awaitingResubmission && <div className="detail-feedback curator-decision"><Clock3 size={17} /><div><strong>Ждём доработку от ученика</strong><p>Вы уже отправили эту попытку на доработку. Как только ученик пришлёт новую, работа снова появится здесь для проверки.</p></div></div>}<div className="curator-actions"><button className="secondary-button" disabled={item.status === "Принято" || !canDecide || !feedback.trim()} onClick={() => void submitDecision("revision")}>Вернуть на доработку</button><button className="primary-button" disabled={item.status === "Принято" || !canDecide} onClick={() => void submitDecision("accepted")}>Принять работу <ChevronRight size={16} /></button></div></div>
    </div>
    {previewFile && <div className="attachment-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Просмотр файла ${previewFile.name}`} onMouseDown={(event) => { if (event.currentTarget === event.target) setPreviewFile(null); }}><div className="attachment-modal"><div className="video-modal-head"><strong>{previewFile.name}</strong><button className="icon-button" aria-label="Закрыть просмотр" onClick={() => setPreviewFile(null)}><X size={18} /></button></div>{previewFile.type.startsWith("video/") && <video src={`${API_ORIGIN}${previewFile.url}`} controls autoPlay playsInline />}{previewFile.type === "application/pdf" && <iframe src={`${API_ORIGIN}${previewFile.url}`} title={previewFile.name} />}</div></div>}
    {openAttempt && <div className="attachment-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Попытка ${openAttempt.attempt}`} onMouseDown={(event) => { if (event.currentTarget === event.target) setOpenAttemptNumber(null); }}><div className="attachment-modal attempt-detail-modal">
      <div className="video-modal-head"><strong>Попытка {openAttempt.attempt}</strong><button className="icon-button" aria-label="Закрыть" onClick={() => setOpenAttemptNumber(null)}><X size={18} /></button></div>
      <div className="submission-section submission-answer-section"><span className="detail-label">ОТВЕТ УЧЕНИКА</span><p className="submission-answer">{linkifyText(openAttempt.answerText || "Ответ отправлен без файла.")}</p></div>
      {openAttempt.files.length > 0 && <div className="submission-section"><span className="detail-label">ВЛОЖЕНИЯ</span><div className="submission-files">{openAttempt.files.map((file) => <div className="submission-file-card has-preview" key={file.id}>
        {file.type.startsWith("image/") && <button type="button" className="submission-image-preview submission-image-preview-button" aria-label={`Увеличить изображение ${file.name}`} onClick={() => setZoomImageUrl(`${API_ORIGIN}${file.url}`)}><Image src={`${API_ORIGIN}${file.url}`} alt={`Предпросмотр вложения ${file.name}`} fill sizes="(max-width: 700px) 100vw, 720px" unoptimized /><span className="submission-image-preview-zoom-hint"><Maximize2 size={13} /> Увеличить</span></button>}
        {file.type.startsWith("video/") && <video src={`${API_ORIGIN}${file.url}`} controls preload="metadata" />}
        <button type="button" className="submission-file" onClick={() => file.type.startsWith("image/") ? setZoomImageUrl(`${API_ORIGIN}${file.url}`) : setPreviewFile(file)}><FileCheck2 size={16} /><span>{file.name}</span><Maximize2 size={14} /></button>
      </div>)}</div></div>}
      {openAttempt.feedback.length > 0 && <div className="submission-section"><span className="detail-label">ОТВЕТ КУРАТОРА</span>{openAttempt.feedback.map((entry) => <div className="attempt-detail-feedback-entry" key={entry.id}>{entry.text && <p className="submission-answer">{linkifyText(entry.text)}</p>}{entry.attachments.map((attachment) => attachment.mimeType.startsWith("image/") ? <button type="button" key={attachment.id} className="assignment-history-feedback-image assignment-history-feedback-image-button" aria-label={`Увеличить изображение ${attachment.originalName}`} onClick={() => setZoomImageUrl(`${API_ORIGIN}${attachment.url}`)}><Image src={`${API_ORIGIN}${attachment.url}`} alt={attachment.originalName} fill sizes="320px" unoptimized /></button> : <a key={attachment.id} className="submission-file" href={`${API_ORIGIN}${attachment.url}`} target="_blank" rel="noreferrer"><FileCheck2 size={14} /><span>{attachment.originalName}</span><ArrowUpRight size={12} /></a>)}<small className="attempt-detail-feedback-date">{new Date(entry.createdAt).toLocaleString("ru-RU")}</small></div>)}</div>}
    </div></div>}
    {zoomImageUrl && typeof document !== "undefined" && createPortal(
      <div className="chat-image-lightbox-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setZoomImageUrl(""); }}>
        <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть просмотр" onClick={() => setZoomImageUrl("")}><X size={22} /></button>
        <img className="chat-image-lightbox-image" src={zoomImageUrl} alt="Просмотр вложения" />
      </div>,
      document.body,
    )}
  </section>;
}

type StudentDirectoryRecord = {
  id: string;
  status: string;
  createdAt: string;
  email: string | null;
  identities: Array<{ provider: string; username: string | null; displayName: string | null; avatarUrl: string | null }>;
  activeSessionCount: number;
  loginEventCount: number;
  submissionCount: number;
  practicum: { id: string; title: string } | null;
  canViewDetails: boolean;
  isAdvanced: boolean;
  lastSession: { lastActiveAt: string; deviceName: string | null; ipAddress: string | null; countryCode?: string | null; city: string | null } | null;
};

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

type StudentProgressRow = {
  id: string;
  isAdvanced?: boolean;
  identities: Array<{ provider: string; username: string | null; displayName: string | null; avatarUrl: string | null }>;
  completedModules: number;
  totalModules: number;
  progressPercent: number;
  currentLessonTitle: string;
  pendingReviewCount: number;
  needsRevisionCount: number;
  needsAttention: boolean;
  lastActiveAt: string | null;
  lastReminderAt: string | null;
};

type ProgressFilter = "all" | "attention" | "pending-review" | "completed";

/** Matches the server's REMINDER_COOLDOWN_HOURS (student-progress-service.ts) — purely for disabling the button early client-side; the server re-checks regardless. */
const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Cohort-wide overview so a curator can see who needs attention without opening every student's
 * card one by one — the actual per-student management (sessions, module overrides, deletion)
 * still lives on "Ученики"; a row here just deep-links there via sessionStorage the same way the
 * dashboard's schedule-event rows do (see curator-target-schedule-event a bit further down).
 */
function CuratorProgressView({ onNavigate }: { onNavigate: (nextNav: CuratorNav) => void }) {
  const [rows, setRows] = useState<StudentProgressRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [practicums, setPracticums] = useState<PracticumSummary[]>([]);
  const [practicumFilter, setPracticumFilter] = useState("");
  const [practicumFilterTouched, setPracticumFilterTouched] = useState(false);
  const [filter, setFilter] = useState<ProgressFilter>("all");
  const [search, setSearch] = useState("");
  const [reminding, setReminding] = useState<Set<string>>(new Set());
  const [reminderError, setReminderError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/course/practicums`, { credentials: "include", cache: "no-store" });
        const payload = await response.json().catch(() => ({})) as { data?: PracticumSummary[] };
        const list = payload.data;
        if (!cancelled && response.ok && Array.isArray(list)) {
          setPracticums(list);
          if (!practicumFilterTouched) setPracticumFilter((current) => current || list.find((practicum) => practicum.isActive)?.id || list[0]?.id || "");
        }
      } catch { /* selector just stays empty if this fails */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!practicumFilter) { setLoading(false); return; }
    const controller = new AbortController();
    (async () => {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${API_ORIGIN}/api/course/students/progress?practicumId=${encodeURIComponent(practicumFilter)}`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 403 ? "Нет прав для просмотра прогресса." : "Не удалось загрузить прогресс учеников.");
        const payload = await response.json() as { data: StudentProgressRow[] };
        setRows(payload.data);
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить прогресс учеников.");
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [practicumFilter]);

  const openStudent = (studentId: string) => {
    window.sessionStorage.setItem("curator-target-student", studentId);
    onNavigate("Ученики");
  };

  const sendReminder = async (studentId: string) => {
    setReminderError("");
    setReminding((current) => new Set(current).add(studentId));
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/students/${studentId}/remind`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ practicumId: practicumFilter }) });
      const payload = await response.json().catch(() => ({})) as { data?: { lastReminderAt: string }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось отправить напоминание.");
      const sentAt = payload.data.lastReminderAt;
      setRows((current) => current.map((row) => row.id === studentId ? { ...row, lastReminderAt: sentAt } : row));
    } catch (requestError) {
      setReminderError(requestError instanceof Error ? requestError.message : "Не удалось отправить напоминание.");
    } finally {
      setReminding((current) => { const next = new Set(current); next.delete(studentId); return next; });
    }
  };

  const isOnCooldown = (row: StudentProgressRow) => Boolean(row.lastReminderAt) && Date.now() - new Date(row.lastReminderAt!).getTime() < REMINDER_COOLDOWN_MS;

  const studentCount = rows.length;
  const averageProgress = studentCount > 0 ? Math.round(rows.reduce((total, row) => total + row.progressPercent, 0) / studentCount) : 0;
  const pendingReviewTotal = rows.reduce((total, row) => total + row.pendingReviewCount, 0);
  const attentionCount = rows.filter((row) => row.needsAttention).length;
  const pendingReviewCount = rows.filter((row) => row.pendingReviewCount > 0).length;
  const completedCount = rows.filter((row) => row.totalModules > 0 && row.progressPercent === 100).length;

  const filtered = rows
    .filter((row) => {
      if (filter === "attention") return row.needsAttention;
      if (filter === "pending-review") return row.pendingReviewCount > 0;
      if (filter === "completed") return row.totalModules > 0 && row.progressPercent === 100;
      return true;
    })
    .filter((row) => {
      if (!search.trim()) return true;
      const identity = row.identities.find((item) => item.provider === "DISCORD") ?? row.identities[0];
      const name = (identity?.displayName ?? identity?.username ?? "").toLowerCase();
      return name.includes(search.trim().toLowerCase());
    });

  const practicumFilterSelect = practicums.length > 0 && <label className="directory-practicum-filter"><span>Поток</span><select value={practicumFilter} onChange={(event) => { setPracticumFilterTouched(true); setPracticumFilter(event.target.value); }}>{practicums.map((practicum) => <option key={practicum.id} value={practicum.id}>{practicum.title}{practicum.isActive ? " · активен" : ""}</option>)}</select></label>;

  const filters: Array<{ id: ProgressFilter; label: string; count: number }> = [
    { id: "all", label: "Все", count: rows.length },
    { id: "attention", label: "Отстают", count: attentionCount },
    { id: "pending-review", label: "Есть ДЗ на проверке", count: pendingReviewCount },
    { id: "completed", label: "Завершили", count: completedCount },
  ];

  if (loading) return <section className="content-panel directory-empty"><div className="empty-state"><TrendingUp /><strong>Считаем прогресс</strong><span>Собираем данные по каждому ученику потока.</span></div></section>;
  if (error) return <section className="content-panel directory-empty"><div className="empty-state"><ShieldCheck size={24} /><strong>{error}</strong><span>Сводка доступна владельцу и куратору только в рамках их прав.</span></div></section>;
  if (!practicumFilter) return <section className="content-panel directory-empty"><div className="empty-state"><TrendingUp /><strong>Нет доступных потоков</strong><span>Сначала нужно создать хотя бы один практикум.</span></div></section>;

  return <div className="progress-directory">
    <div className="directory-stats progress-stats">
      <StatCard icon={<GraduationCap size={18} />} label="Учеников в потоке" value={String(studentCount)} detail="Активные участники практикума" accent="blue" />
      <StatCard icon={<TrendingUp size={18} />} label="Средний прогресс" value={`${averageProgress}%`} detail="По выбранному потоку" accent="cyan" />
      <StatCard icon={<FileCheck2 size={18} />} label="ДЗ на проверке" value={String(pendingReviewTotal)} detail="Ждут решения куратора" accent="amber" />
      <StatCard icon={<ShieldCheck size={18} />} label="Отстают" value={String(attentionCount)} detail="Нужно внимание" accent="red" />
    </div>
    <section className="content-panel progress-table-panel">
      <div className="section-heading">
        <div><h2>Ученики потока</h2></div>
        <div className="section-heading-actions">
          {practicumFilterSelect}
          <label className="progress-search"><Search size={14} /><input type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск ученика…" /></label>
        </div>
      </div>
      <div className="assignment-filter">{filters.map((item) => <button type="button" key={item.id} className={`filter-chip ${filter === item.id ? "active" : ""}`} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{item.count}</span></button>)}</div>
      {reminderError && <div className="file-error" role="alert">{reminderError}</div>}
      {filtered.length === 0 ? <div className="empty-state"><GraduationCap size={22} /><strong>Никого не нашли</strong><span>Попробуйте другой фильтр, поток или запрос поиска.</span></div> : <div className="progress-table">
        <div className="progress-table-head">
          <span>Ученик</span><span>Прогресс</span><span>Выполнено</span><span>Текущий урок</span><span>ДЗ на проверке</span><span>Требует внимания</span><span>Последняя активность</span>
        </div>
        {filtered.map((row) => {
          const identity = row.identities.find((item) => item.provider === "DISCORD") ?? row.identities[0];
          const onCooldown = isOnCooldown(row);
          // A plain div (not a <button>) — the "Напомнить" action below needs its own real
          // <button>, and buttons can't nest inside buttons (invalid HTML, unreliable clicks).
          // role="button" + tabIndex/onKeyDown keep the whole-row click and keyboard behavior.
          return <div className="progress-table-row" role="button" tabIndex={0} key={row.id} onClick={() => openStudent(row.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openStudent(row.id); } }}>
            <span className="progress-table-student" data-label="Ученик">
              {identity?.avatarUrl ? <Image className="profile-avatar profile-avatar-image" src={identity.avatarUrl} alt={identity.displayName ?? identity.username ?? "Ученик"} width={28} height={28} unoptimized /> : <div className="profile-avatar">{(identity?.displayName ?? identity?.username ?? "У").slice(0, 2).toUpperCase()}</div>}
              <StudentName name={identity?.displayName ?? identity?.username ?? "Без имени"} advanced={row.isAdvanced} />
            </span>
            <span className="progress-table-bar" data-label="Прогресс"><i><b style={{ width: `${row.progressPercent}%` }} /></i><small>{row.progressPercent}%</small></span>
            <span data-label="Выполнено">{row.completedModules}/{row.totalModules}</span>
            <span data-label="Текущий урок">{row.currentLessonTitle}</span>
            <span data-label="ДЗ на проверке">{row.pendingReviewCount > 0 ? row.pendingReviewCount : "—"}</span>
            <span className="progress-attention-cell" data-label="Требует внимания">
              {row.needsAttention ? <>
                <em className="progress-attention-badge">⚠ Требует внимания</em>
                {onCooldown
                  ? <span className="progress-remind-sent">Напомнили {relativeTimeFromNow(row.lastReminderAt!)}</span>
                  : <button type="button" className="progress-remind-button" disabled={reminding.has(row.id)} onClick={(event) => { event.stopPropagation(); void sendReminder(row.id); }}>{reminding.has(row.id) ? "Отправляем…" : "Напомнить"}</button>}
              </> : "—"}
            </span>
            <span data-label="Последняя активность">{row.lastActiveAt ? relativeTimeFromNow(row.lastActiveAt) : "—"}</span>
          </div>;
        })}
      </div>}
    </section>
  </div>;
}

function CuratorStudentsView({ onInvite, requestedStudentId = "", isOwner = false }: { onInvite: () => void; requestedStudentId?: string; isOwner?: boolean }) {
  const [students, setStudents] = useState<StudentDirectoryRecord[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [practicums, setPracticums] = useState<PracticumSummary[]>([]);
  // "" means "Все потоки" (every student ever enrolled, incl. old cohorts — the historical
  // behaviour, kept so a former student who reaches out can still be found). Defaults to the
  // active practicum once the list loads, so the roster reads as "current cohort" out of the box.
  const [practicumFilter, setPracticumFilter] = useState("");
  const [practicumFilterTouched, setPracticumFilterTouched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/course/practicums`, { credentials: "include", cache: "no-store" });
        const payload = await response.json().catch(() => ({})) as { data?: PracticumSummary[] };
        if (!cancelled && response.ok && Array.isArray(payload.data)) {
          setPracticums(payload.data);
          if (!practicumFilterTouched) setPracticumFilter(payload.data.find((practicum) => practicum.isActive)?.id ?? "");
        }
      } catch { /* filter just stays on "Все потоки" if this fails */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const loadStudents = async () => {
      setLoading(true);
      try {
        const query = practicumFilter ? `?practicumId=${encodeURIComponent(practicumFilter)}` : "";
        const response = await fetch(`${API_ORIGIN}/api/security/students${query}`, { credentials: "include", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 403 ? "Нет прав для просмотра списка учеников." : "Не удалось загрузить список учеников.");
        const payload = await response.json() as { data: StudentDirectoryRecord[] };
        setStudents(payload.data);
        // "Прогресс" page rows deep-link here the same way the dashboard's schedule-event
        // rows do (see curator-target-schedule-event) — sessionStorage instead of a prop,
        // since CuratorSectionView doesn't thread a per-student setter down from the root.
        const targetStudentId = requestedStudentId || window.sessionStorage.getItem("curator-target-student") || "";
        if (targetStudentId) window.sessionStorage.removeItem("curator-target-student");
        setSelectedId(targetStudentId && payload.data.some((student) => student.id === targetStudentId) ? targetStudentId : "");
      } catch (requestError) {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить список учеников.");
      } finally {
        setLoading(false);
      }
    };
    void loadStudents();
    return () => controller.abort();
  }, [requestedStudentId, practicumFilter]);

  const selectedStudent = students.find((student) => student.id === selectedId) ?? students[0];
  const activeSessions = students.reduce((total, student) => total + student.activeSessionCount, 0);
  const submissions = students.reduce((total, student) => total + student.submissionCount, 0);

  // Deletion is permanent (see the confirm dialog in StudentDirectoryDetailContent) — once it
  // succeeds server-side, just drop them from local state rather than refetching the whole list.
  const handleDeleted = (studentId: string) => {
    setStudents((current) => current.filter((student) => student.id !== studentId));
    setSelectedId("");
  };

  if (selectedStudent && selectedId) return <StudentDirectoryFullPage student={selectedStudent} onBack={() => setSelectedId("")} onDeleted={handleDeleted} isOwner={isOwner} />;

  const practicumFilterSelect = practicums.length > 0 && <label className="directory-practicum-filter"><span>Поток</span><select value={practicumFilter} onChange={(event) => { setPracticumFilterTouched(true); setPracticumFilter(event.target.value); }}><option value="">Все потоки</option>{practicums.map((practicum) => <option key={practicum.id} value={practicum.id}>{practicum.title}{practicum.isActive ? " · активен" : ""}</option>)}</select></label>;

  if (loading) return <section className="content-panel directory-empty"><div className="empty-state"><UsersRoundIcon /><strong>Загружаем учеников</strong><span>Проверяем доступ и получаем данные из базы.</span></div></section>;
  if (error) return <section className="content-panel directory-empty"><div className="empty-state"><ShieldCheck size={24} /><strong>{error}</strong><span>Список доступен владельцу и куратору только в рамках их прав.</span><button className="primary-button" onClick={onInvite}><UserPlus size={16} /> Открыть приглашения</button></div></section>;
  // Client-side: the roster is already fully loaded for the chosen поток, so a name/username/
  // email substring match is instant and needs no extra endpoint. Stats above keep counting
  // the whole поток, not just the matches.
  const searchQuery = search.trim().toLowerCase();
  const visibleStudents = searchQuery
    ? students.filter((student) => [student.email, ...student.identities.flatMap((identity) => [identity.displayName, identity.username])].some((value) => value?.toLowerCase().includes(searchQuery)))
    : students;
  if (students.length === 0) return <section className="content-panel directory-empty-with-heading"><div className="section-heading"><div><h2>Ученики</h2></div><div className="section-heading-actions">{practicumFilterSelect}</div></div><div className="directory-empty"><div className="empty-state"><UsersRoundIcon /><strong>{practicumFilter ? "В этом потоке пока нет учеников" : "Пока нет учеников"}</strong><span>{practicumFilter ? "Переключитесь на «Все потоки» или создайте приглашение прямо в этот поток." : "Создай первое приглашение, чтобы участник появился в этом списке."}</span><button className="primary-button" onClick={onInvite}><UserPlus size={16} /> Создать приглашение</button></div></div></section>;

  return <div className="student-directory"><div className="directory-stats"><StatCard icon={<UsersRoundIcon />} label="Учеников в потоке" value={String(students.length)} detail="Активные участники практикума" accent="blue" /><StatCard icon={<MonitorSmartphone size={18} />} label="Активных устройств" value={String(activeSessions)} detail="Сессии, которые видит система" accent="cyan" /><StatCard icon={<FileCheck2 size={18} />} label="Отправлено работ" value={String(submissions)} detail="Всего в базе" accent="amber" /></div><div className="directory-layout"><section className="content-panel directory-list"><div className="section-heading"><div><h2>Ученики</h2></div><div className="section-heading-actions"><label className="progress-search"><Search size={14} /><input type="text" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск ученика…" /></label>{practicumFilterSelect}<button className="primary-button compact-button curator-create-assignment-button" onClick={onInvite}><UserPlus size={15} /> Создать приглашение</button></div></div><div className="directory-rows">{visibleStudents.length === 0 && <p className="directory-search-empty">Никого не нашли по запросу «{search.trim()}»</p>}{visibleStudents.map((student) => { const identity = student.identities.find((item) => item.provider === "DISCORD") ?? student.identities[0]; return <button className={`directory-row ${student.id === selectedStudent.id ? "selected" : ""}`} key={student.id} onClick={() => setSelectedId(student.id)}>{identity?.avatarUrl ? <Image className="profile-avatar profile-avatar-image" src={identity.avatarUrl} alt={identity.displayName ?? identity.username ?? "Ученик"} width={31} height={31} unoptimized /> : <div className="profile-avatar">{(identity?.displayName ?? identity?.username ?? "У").slice(0, 2).toUpperCase()}</div>}<div className="directory-row-copy"><StudentName name={identity?.displayName ?? identity?.username ?? "Без имени"} advanced={student.isAdvanced} /><span>{identity?.provider ?? "Профиль без провайдера"} · {student.status === "ACTIVE" ? "Активен" : student.status}{student.practicum ? ` · ${student.practicum.title}` : ""}</span></div><div className="directory-row-meta"><strong>{student.submissionCount}</strong><span>ДЗ</span></div><ChevronRight size={16} /></button>; })}</div></section><StudentDirectoryDetail student={selectedStudent} onDeleted={handleDeleted} isOwner={isOwner} /></div></div>;
}

function StudentDirectoryFullPage({ student, onBack, onDeleted, isOwner = false }: { student: StudentDirectoryRecord; onBack: () => void; onDeleted: (studentId: string) => void; isOwner?: boolean }) {
  const identity = student.identities.find((item) => item.provider === "DISCORD") ?? student.identities[0];
  return <div className="student-full-page"><div className="student-full-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Назад к ученикам</button><div><span className="section-kicker">ПРОФИЛЬ УЧЕНИКА</span><strong>{identity?.displayName ?? identity?.username ?? "Без имени"}</strong></div></div><StudentDirectoryDetail student={student} onDeleted={(studentId) => { onDeleted(studentId); onBack(); }} isOwner={isOwner} /></div>;
}

function StudentDirectoryDetail({ student, onDeleted, isOwner = false }: { student: StudentDirectoryRecord; onDeleted: (studentId: string) => void; isOwner?: boolean }) {
  return <div className="student-detail-stack directory-detail"><StudentDirectoryDetailContent student={student} onDeleted={onDeleted} isOwner={isOwner} /><StudentBookingPanel student={student} /><StudentModuleAccessPanel student={student} /></div>;
}

type StudentBookingCurrent = { id: string; type: string; typeLabel: string; title: string; date: string; time: string };
type StudentBookingHistoryEntry = { id: string; eventType: string; typeLabel: string; eventTitle: string; eventDate: string; eventTime: string; action: "BOOKED" | "CANCELLED"; createdAt: string };

/** Бэктест/пресессия — curator can't see this from anywhere but this student's own card today. */
function StudentBookingPanel({ student }: { student: StudentDirectoryRecord }) {
  const [data, setData] = useState<{ current: StudentBookingCurrent[]; history: StudentBookingHistoryEntry[] } | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [releasingId, setReleasingId] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/students/${student.id}/bookings`, { credentials: "include", cache: "no-store" });
      const payload = await response.json().catch(() => ({})) as { data?: { current: StudentBookingCurrent[]; history: StudentBookingHistoryEntry[] }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось загрузить записи");
      setData(payload.data);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить записи");
    }
  }, [student.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Curator-only override — a student can no longer self-cancel a past slot (see
  // schedule-service.ts#cancelBooking's date lock), so a missed backtest/pre-session that was
  // never released stays stuck against their limit until a curator frees it here by hand.
  const releaseBooking = async (eventId: string) => {
    if (releasingId) return;
    setReleasingId(eventId);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/schedule/${eventId}/cancel-booking`, { method: "POST", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось снять запись");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось снять запись");
    } finally {
      setReleasingId("");
    }
  };

  if (!student.canViewDetails) return null;
  if (!data) return null;

  return <section className="student-module-access-panel">
    <button className="student-module-access-toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <div className="student-module-access-head"><span className="section-kicker">БЭКТЕСТ / ПРЕСЕССИЯ</span><strong>Индивидуальные слоты</strong><span>{data.current.length > 0 ? `Занято слотов: ${data.current.length}` : "Слотов не занято"}</span></div>
      <ChevronDown size={16} className={`student-module-access-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
    </button>
    {expanded && <>
      {error && <div className="file-error" role="alert">{error}</div>}
      <span className="form-section-label">Текущие записи</span>
      <div className="student-module-access-list">
        {data.current.length === 0
          ? <div className="student-module-access-row"><div className="student-module-access-copy"><strong>Слотов не занято</strong></div></div>
          : data.current.map((booking) => <div className="student-module-access-row is-unlocked" key={booking.id}><div className="student-module-access-copy"><strong>{booking.typeLabel}</strong><small>Записан на {formatEventDate(booking.date)}, {booking.time}</small></div><div className="student-module-access-actions"><button className="secondary-button" type="button" disabled={releasingId === booking.id} onClick={() => void releaseBooking(booking.id)}>{releasingId === booking.id ? "Снимаем…" : "Снять запись"}</button></div></div>)}
      </div>
      <span className="form-section-label">История</span>
      <div className="student-module-access-list">
        {data.history.length === 0
          ? <div className="student-module-access-row"><div className="student-module-access-copy"><strong>Записей ещё не было</strong></div></div>
          : data.history.map((entry) => <div className="student-module-access-row" key={entry.id}><div className="student-module-access-copy"><strong>{entry.action === "BOOKED" ? "Забронировал(а)" : "Отменил(а)"} · {entry.typeLabel}</strong><small>{formatEventDate(entry.eventDate)}, {entry.eventTime} · {relativeTimeFromNow(entry.createdAt)}</small></div></div>)}
      </div>
    </>}
  </section>;
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
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось загрузить доступ к урокам");
      setRows(payload.data);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось загрузить доступ к урокам");
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
    if (!window.confirm("Отметить урок пройденным? Откроется содержимое следующего урока, а ДЗ следующего урока станет доступно для отправки этому ученику.")) return;
    setBusy(moduleId); setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${moduleId}/students/${student.id}/complete`, { method: "POST", credentials: "include" });
      if (!response.ok) throw new Error("Не удалось отметить урок пройденным");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отметить урок пройденным");
    } finally {
      setBusy("");
    }
  };

  if (!student.canViewDetails) return null;
  if (!rows) return null;

  return <section className="student-module-access-panel">
    <button className="student-module-access-toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <div className="student-module-access-head"><span className="section-kicker">ДОСТУП К УРОКАМ</span><strong>Точечно для этого ученика</strong><span>Открыть/закрыть — не трогает общий переключатель на «Программе», действует только на этого ученика. «Отметить пройденным» — открывает следующий урок и разблокирует его ДЗ.</span></div>
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


function StudentDirectoryDetailContent({ student, onDeleted, isOwner = false }: { student: StudentDirectoryRecord; onDeleted: (studentId: string) => void; isOwner?: boolean }) {
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
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

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
  const studentLabel = identity?.displayName ?? identity?.username ?? "этого ученика";

  const deleteStudentAccount = async () => {
    if (deleting) return;
    const confirmed = window.confirm(`Удалить «${studentLabel}» с платформы? Все его ДЗ, переписка с куратором и история входов будут стёрты безвозвратно — это нельзя отменить. Если уверены — удалить?`);
    if (!confirmed) return;
    setDeleting(true);
    setDeleteError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/students/${student.id}/delete`, { method: "POST", credentials: "include" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось удалить ученика.");
      }
      onDeleted(student.id);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Не удалось удалить ученика.");
      setDeleting(false);
    }
  };

  return <section className="content-panel directory-detail">
    <div className="directory-detail-heading">
      {identity?.avatarUrl ? <Image className="profile-avatar large profile-avatar-image" src={identity.avatarUrl} alt={identity.displayName ?? identity.username ?? "Ученик"} width={46} height={46} unoptimized /> : <div className="profile-avatar large">{(identity?.displayName ?? identity?.username ?? "У").slice(0, 2).toUpperCase()}</div>}
      <div className="directory-detail-title"><span className="section-kicker">ПРОФИЛЬ УЧЕНИКА</span><h2 className={student.isAdvanced ? "student-name-advanced" : undefined}>{identity?.displayName ?? identity?.username ?? "Без имени"}{student.isAdvanced && <em className="adv-tag" title="Advanced">ADV</em>}</h2><p>{identity?.provider ?? "Профиль без провайдера"} · {student.status === "ACTIVE" ? "Активен" : student.status}{student.isAdvanced ? " · Advanced" : ""}</p><div className="student-assignment-status">{isOwner && <RoleSwitchButton userId={student.id} nextRole="CURATOR" label="Сделать куратором" confirmText={`Сделать «${studentLabel}» куратором? Зачисление в поток и доступ к урокам будут сняты — как у нового куратора.`} />}<AdvancedToggleButton studentId={student.id} isAdvanced={student.isAdvanced} label={studentLabel} /><button type="button" className="secondary-button danger-button" onClick={() => void deleteStudentAccount()} disabled={deleting}><Trash2 size={15} />{deleting ? "Удаляем…" : "Удалить ученика"}</button></div>{deleteError && <div className="file-error" role="alert">{deleteError}</div>}</div>
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
                <div><span className="detail-label">ОТВЕТ УЧЕНИКА</span><p>{linkifyText(attempt.answerText || "Ответ отправлен без текста.")}</p></div>
                {attempt.files.length > 0 && <div><span className="detail-label">ВЛОЖЕНИЯ</span><div className="student-assignment-files">{attempt.files.map((file) => file.mimeType.startsWith("image/") ? <div className="student-assignment-image" key={file.id}><Image src={API_ORIGIN + "/api/files/" + file.id + "/content"} alt={file.originalName} width={320} height={210} unoptimized /><span>{file.originalName}</span></div> : <a key={file.id} href={API_ORIGIN + "/api/files/" + file.id + "/content"} target="_blank" rel="noreferrer">{file.originalName}</a>)}</div></div>}
                {attempt.feedback.length > 0 ? <div className="student-assignment-feedback"><strong>КОММЕНТАРИИ КУРАТОРА</strong>{attempt.feedback.map((feedback) => <div className="student-assignment-feedback-item" key={feedback.id}><span>{linkifyText(feedback.text)}</span><small>{formatDateTime(feedback.createdAt)}</small></div>)}</div> : <div className="student-assignment-feedback empty"><strong>КОММЕНТАРИИ КУРАТОРА</strong><span>Комментариев по этой попытке пока нет.</span></div>}
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

type TeamMemberRecord = {
  id: string;
  role: string;
  isProtectedOwner: boolean;
  status: string;
  createdAt: string;
  email: string | null;
  identities: Array<{ provider: string; username: string | null; displayName: string | null; avatarUrl: string | null }>;
  activeSessionCount: number;
  loginEventCount: number;
  lastSession: { lastActiveAt: string; deviceName: string | null; ipAddress: string | null; countryCode?: string | null; city: string | null } | null;
};

/**
 * Owner-only device/session security for curator accounts — the staff counterpart to
 * "Ученики". Needed because a curator's 3rd-device approval has nobody who can grant it once
 * they're off the student roster (see auth-service.ts#assertCanManageDeviceSecurity): this is
 * where that approval actually happens.
 */
function CuratorTeamView({ isOwner }: { isOwner: boolean }) {
  const [members, setMembers] = useState<TeamMemberRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${API_ORIGIN}/api/security/team`, { credentials: "include", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 403 ? "Нет прав для просмотра списка команды." : "Не удалось загрузить список команды.");
        const payload = await response.json() as { data: TeamMemberRecord[] };
        setMembers(payload.data);
      })
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") return;
        setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить список команды.");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  const selectedMember = members.find((member) => member.id === selectedId) ?? members[0];
  const activeSessions = members.reduce((total, member) => total + member.activeSessionCount, 0);

  // Mirrors CuratorStudentsView/StudentDirectoryFullPage: `.directory-detail` is force-hidden by
  // CSS whenever it's nested inside `.directory-layout` under `.student-directory` (see
  // globals.css ".student-directory > .directory-layout > .directory-detail { display: none; }"),
  // so a selected row has to navigate to a dedicated full-page view instead of a live side panel
  // — without this branch the click "worked" (fetched data) but nothing was ever visible.
  if (selectedMember && selectedId) return <TeamMemberFullPage member={selectedMember} onBack={() => setSelectedId("")} isOwner={isOwner} />;

  if (loading) return <section className="content-panel directory-empty"><div className="empty-state"><ShieldCheck size={24} /><strong>Загружаем команду</strong><span>Проверяем доступ и получаем данные из базы.</span></div></section>;
  if (error) return <section className="content-panel directory-empty"><div className="empty-state"><ShieldCheck size={24} /><strong>{error}</strong></div></section>;
  if (members.length === 0) return <section className="content-panel directory-empty"><div className="empty-state"><ShieldCheck size={24} /><strong>Кураторов пока нет</strong><span>Как только куратор примет приглашение, его устройства появятся здесь.</span></div></section>;

  return <div className="student-directory"><div className="directory-stats"><StatCard icon={<ShieldCheck size={18} />} label="Кураторов" value={String(members.length)} detail="Активные сотрудники" accent="blue" /><StatCard icon={<MonitorSmartphone size={18} />} label="Активных устройств" value={String(activeSessions)} detail="Сессии, которые видит система" accent="cyan" /></div><div className="directory-layout"><section className="content-panel directory-list"><div className="section-heading"><div><h2>Куратор</h2></div></div><div className="directory-rows">{members.map((member) => { const identity = member.identities.find((item) => item.provider === "DISCORD") ?? member.identities[0]; return <button className={`directory-row ${member.id === selectedMember.id ? "selected" : ""}`} key={member.id} onClick={() => setSelectedId(member.id)}>{identity?.avatarUrl ? <Image className="profile-avatar profile-avatar-image" src={identity.avatarUrl} alt={identity.displayName ?? identity.username ?? "Куратор"} width={31} height={31} unoptimized /> : <div className="profile-avatar">{(identity?.displayName ?? identity?.username ?? "К").slice(0, 2).toUpperCase()}</div>}<div className="directory-row-copy"><strong>{identity?.displayName ?? identity?.username ?? "Без имени"}</strong><span>{identity?.provider ?? "Профиль без провайдера"} · {member.status === "ACTIVE" ? "Активен" : member.status}</span></div><div className="directory-row-meta team-row-meta"><strong>{member.activeSessionCount}</strong><span>устройств</span></div><ChevronRight size={16} /></button>; })}</div></section></div></div>;
}

function TeamMemberFullPage({ member, onBack, isOwner }: { member: TeamMemberRecord; onBack: () => void; isOwner: boolean }) {
  const identity = member.identities.find((item) => item.provider === "DISCORD") ?? member.identities[0];
  return <div className="student-full-page"><div className="student-full-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Назад к команде</button><div><span className="section-kicker">ПРОФИЛЬ КУРАТОРА</span><strong>{identity?.displayName ?? identity?.username ?? "Без имени"}</strong></div></div><TeamMemberDetail member={member} isOwner={isOwner} /></div>;
}

function TeamMemberDetail({ member, isOwner }: { member: TeamMemberRecord | undefined; isOwner: boolean }) {
  type SecurityDetail = { sessions: Array<{ id: string; status: string; deviceName: string | null; userAgent: string | null; ipAddress: string | null; countryCode?: string | null; city: string | null; lastActiveAt: string; createdAt: string; expiresAt: string }>; loginEvents: Array<{ id: string; outcome: string; reasonCode: string | null; ipAddress: string | null; countryCode?: string | null; city: string | null; createdAt: string }> };
  const [detail, setDetail] = useState<SecurityDetail | null>(null);
  const [revoking, setRevoking] = useState("");
  const [approving, setApproving] = useState("");
  const [securityError, setSecurityError] = useState("");

  useEffect(() => {
    if (!member) return;
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/security/team/${member.id}`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data: SecurityDetail }> : null)
      .then((payload) => { if (!cancelled && payload?.data) setDetail(payload.data); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [member]);

  if (!member) return <section className="content-panel directory-detail"><div className="empty-state"><ShieldCheck size={24} /><strong>Выберите куратора</strong></div></section>;

  const revoke = async (sessionId: string) => {
    if (!window.confirm("Отозвать эту сессию?")) return;
    setRevoking(sessionId);
    setSecurityError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/team/${member.id}/sessions/${sessionId}/revoke`, {
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
      const response = await fetch(`${API_ORIGIN}/api/security/team/${member.id}/sessions/${sessionId}/approve`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Device approved by owner" }),
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

  const identity = member.identities.find((item) => item.provider === "DISCORD") ?? member.identities[0];
  const activeSessions = detail?.sessions.filter((session) => session.status === "ACTIVE") ?? [];
  const pendingSessions = detail?.sessions.filter((session) => session.status === "PENDING") ?? [];
  const revokedSessions = detail?.sessions.filter((session) => session.status === "REVOKED" || session.status === "EXPIRED") ?? [];
  const unusualActivity = activeSessions.length > 1 && new Set(activeSessions.map((session) => session.countryCode ?? session.city ?? session.ipAddress).filter(Boolean)).size > 1;
  const formatDevice = (userAgent: string | null) => userAgent?.includes("Windows") ? "Windows · браузер" : userAgent?.includes("Macintosh") ? "macOS · браузер" : userAgent?.includes("Android") ? "Android · мобильное устройство" : userAgent?.includes("iPhone") ? "iPhone · мобильное устройство" : "Браузер";
  const formatDateTime = (value: string | null) => value ? new Date(value).toLocaleString("ru-RU") : "Дата не указана";

  return <section className="content-panel directory-detail">
    <div className="directory-detail-heading">
      {identity?.avatarUrl ? <Image className="profile-avatar large profile-avatar-image" src={identity.avatarUrl} alt={identity.displayName ?? identity.username ?? "Куратор"} width={46} height={46} unoptimized /> : <div className="profile-avatar large">{(identity?.displayName ?? identity?.username ?? "К").slice(0, 2).toUpperCase()}</div>}
      <div className="directory-detail-title"><span className="section-kicker">ПРОФИЛЬ КУРАТОРА</span><h2>{identity?.displayName ?? identity?.username ?? "Без имени"}</h2><p>{identity?.provider ?? "Профиль без провайдера"} · {member.status === "ACTIVE" ? "Активен" : member.status}{member.role === "OWNER" ? " · Овнер" : ""}</p>{isOwner && <div className="student-assignment-status">
        {member.role === "CURATOR" && <RoleSwitchButton userId={member.id} nextRole="STUDENT" label="Сделать учеником" confirmText={`Сделать «${identity?.displayName ?? identity?.username ?? "этого куратора"}» учеником? Он попадёт в активный поток заново, как только принявший приглашение ученик; ученики, которые сейчас закреплены за ним, останутся без куратора.`} />}
        {member.role === "CURATOR" && <OwnerRoleButton userId={member.id} direction="grant" label="Сделать Овнером" confirmText={`Сделать «${identity?.displayName ?? identity?.username ?? "этого куратора"}» Овнером? Он получит полный доступ уровня Овнера — управление командой, потоками и их удаление.`} />}
        {member.role === "OWNER" && !member.isProtectedOwner && <OwnerRoleButton userId={member.id} direction="revoke" label="Снять Овнера" confirmText={`Снять роль Овнера с «${identity?.displayName ?? identity?.username ?? "этого Овнера"}»? Он станет куратором, доступ уровня Овнера будет закрыт.`} />}
        {member.role === "OWNER" && member.isProtectedOwner && <span className="assignment-badge blue">Защищённый Овнер</span>}
      </div>}</div>
    </div>
    <div className="directory-detail-grid">
      <div><span>Discord</span><strong>{identity?.username ?? "Не подключён"}</strong></div>
      <div><span>Событий входа</span><strong>{member.loginEventCount}</strong></div>
      <div><span>Активных устройств</span><strong>{detail ? activeSessions.length : member.activeSessionCount}</strong></div>
    </div>
    <div className="directory-security">
      {securityError && <div className="file-error" role="alert">{securityError}</div>}
      {detail && pendingSessions.length > 0 && <div className="security-pending-list"><div className="security-pending-heading"><div><span className="section-kicker">ТРЕБУЕТСЯ РЕШЕНИЕ</span><h4>Новые устройства ожидают подтверждения</h4><p>Если уже заняты два места, сначала отзовите активное устройство, затем разрешите это.</p></div><span>{pendingSessions.length}</span></div>{pendingSessions.map((session) => <article className="security-device-card pending" key={session.id}><div className="security-device-head"><div><span className="security-device-status pending">ОЖИДАЕТ ПОДТВЕРЖДЕНИЯ</span><h4>{formatDevice(session.userAgent)}</h4></div>{isOwner && <div className="security-device-actions"><button className="primary-button" disabled={approving === session.id} onClick={() => void approve(session.id)}>{approving === session.id ? "Разрешаем…" : "Разрешить устройство"}</button><button className="secondary-button danger" disabled={revoking === session.id} onClick={() => void revoke(session.id)}>{revoking === session.id ? "Отклоняем…" : "Отклонить"}</button></div>}</div><div className="security-device-grid"><div><span>IP-АДРЕС</span><strong>{session.ipAddress ?? "Не определён"}</strong></div><div><span>РЕГИОН</span><strong>{formatRegion(session.city, session.countryCode)}</strong></div><div><span>ЗАПРОС</span><strong>{formatDateTime(session.createdAt)}</strong></div><div><span>ИСТЕКАЕТ</span><strong>{formatDateTime(session.expiresAt)}</strong></div></div></article>)}</div>}
      <div className="section-heading"><div><span className="section-kicker">КОНТРОЛЬ ДОСТУПА</span><h3>Доверенные устройства</h3></div><ShieldCheck size={18} className="heading-icon" /></div>
      {unusualActivity && <div className="file-error" role="status">Активные сессии имеют разные сетевые признаки. Это сигнал для проверки, но не доказательство передачи аккаунта.</div>}
      {detail && activeSessions.length === 0 && pendingSessions.length === 0 && <div className="empty-state compact"><MonitorSmartphone size={21} /><strong>Нет активных устройств</strong><span>Все ранее созданные сессии отозваны или завершены.</span></div>}
      {activeSessions.map((session) => <article className="security-device-card" key={session.id}><div className="security-device-head"><div><span className="security-device-status">АКТИВНО</span><h4>{formatDevice(session.userAgent)}</h4></div>{isOwner && <button className="secondary-button" disabled={revoking === session.id} onClick={() => void revoke(session.id)}>{revoking === session.id ? "Отзываем…" : "Отозвать доступ"}</button>}</div><div className="security-device-grid"><div><span>IP-АДРЕС</span><strong>{session.ipAddress ?? "Не определён"}</strong></div><div><span>РЕГИОН</span><strong>{formatRegion(session.city, session.countryCode)}</strong></div><div><span>ПЕРВЫЙ ВХОД</span><strong>{new Date(session.createdAt).toLocaleString("ru-RU")}</strong></div><div><span>ПОСЛЕДНЯЯ АКТИВНОСТЬ</span><strong>{new Date(session.lastActiveAt).toLocaleString("ru-RU")}</strong></div></div></article>)}
      {revokedSessions.length > 0 && <details className="security-event-list"><summary className="detail-label">ЗАВЕРШЁННЫЕ СЕССИИ ({revokedSessions.length})</summary>{revokedSessions.slice(0, 10).map((session) => <div className="security-event" key={session.id}><strong>{formatDevice(session.userAgent)}</strong><span>Сессия завершена · {new Date(session.createdAt).toLocaleString("ru-RU")} · IP: {session.ipAddress ?? "не определён"} · {formatRegion(session.city, session.countryCode)}</span></div>)}</details>}
      {detail && <details className="security-event-list"><summary className="detail-label">ПОСЛЕДНИЕ ВХОДЫ</summary>{detail.loginEvents.slice(0, 5).map((event) => <div className="security-event" key={event.id}><strong>{formatLoginEventLabel(event.outcome, event.reasonCode)}{formatLoginEventReason(event.reasonCode) && <small>{formatLoginEventReason(event.reasonCode)}</small>}</strong><span>{new Date(event.createdAt).toLocaleString("ru-RU")} · IP: {event.ipAddress ?? "не определён"} · {formatRegion(event.city, event.countryCode)}</span></div>)}</details>}
    </div>
  </section>;
}

/**
 * Owner-only student <-> curator toggle for a test account — same effect as accepting a fresh
 * invitation with the other role (Enrollment/module access on the way in, curator assignments
 * cleared on the way out), without needing a new Discord identity each time. See
 * auth-service.ts#setUserRole for exactly what moves.
 */
function RoleSwitchButton({ userId, nextRole, label, confirmText }: { userId: string; nextRole: "STUDENT" | "CURATOR"; label: string; confirmText: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    if (busy || !window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/students/${userId}/role`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: nextRole }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось изменить роль.");
      }
      window.location.reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось изменить роль.");
      setBusy(false);
    }
  };
  return <span className="role-switch-control"><button type="button" className="secondary-button" onClick={() => void run()} disabled={busy}><ArrowRightLeft size={15} />{busy ? "Меняем…" : label}</button>{error && <div className="file-error" role="alert">{error}</div>}</span>;
}

/** Owner-only grant/revoke of the OWNER role itself — see auth-service.ts#grantOwnerRole/revokeOwnerRole for the guards (protected owner, last-remaining-owner, no self-revoke). */
function OwnerRoleButton({ userId, direction, label, confirmText }: { userId: string; direction: "grant" | "revoke"; label: string; confirmText: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    if (busy || !window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/team/${userId}/${direction === "grant" ? "grant-owner" : "revoke-owner"}`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось изменить роль.");
      }
      window.location.reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось изменить роль.");
      setBusy(false);
    }
  };
  return <span className="role-switch-control"><button type="button" className="secondary-button" onClick={() => void run()} disabled={busy}><ArrowRightLeft size={15} />{busy ? "Меняем…" : label}</button>{error && <div className="file-error" role="alert">{error}</div>}</span>;
}

// Grants/revokes the "Advanced" tier — a third Module.section track (parallel to Теория/
// Практика) plus MediaAudience.ADVANCED recordings in "Записи", both otherwise invisible to
// this student. See course-service.ts#getForUser and the schema comment on User.isAdvanced.
function AdvancedToggleButton({ studentId, isAdvanced, label }: { studentId: string; isAdvanced: boolean; label: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async () => {
    const confirmText = isAdvanced
      ? `Забрать Advanced-доступ у «${label}»? Пропадёт вкладка Advanced в «Мой практикум» и Advanced-фильтры в «Записях».`
      : `Выдать Advanced-доступ «${label}»? Откроется вкладка Advanced в «Мой практикум» и Advanced-фильтры в «Записях».`;
    if (busy || !window.confirm(confirmText)) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/security/students/${studentId}/advanced`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdvanced: !isAdvanced }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось изменить Advanced-доступ.");
      }
      window.location.reload();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось изменить Advanced-доступ.");
      setBusy(false);
    }
  };
  return <span className="role-switch-control"><button type="button" className={isAdvanced ? "secondary-button" : "primary-button"} onClick={() => void run()} disabled={busy}><Sparkles size={15} />{busy ? "Сохраняем…" : isAdvanced ? "Забрать Advanced" : "Выдать Advanced"}</button>{error && <div className="file-error" role="alert">{error}</div>}</span>;
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
      const payload = await response.json() as { data?: { token: string; expiresAt: string; emailSent?: boolean; emailError?: string }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать приглашение");
      const url = `${window.location.origin}/?invite=${encodeURIComponent(payload.data.token)}`;
      setInviteUrl(url); setNotice(`Ссылка создана до ${new Date(payload.data.expiresAt).toLocaleString("ru-RU")}. ${payload.data.emailSent ? "Письмо отправлено." : payload.data.emailError ? `Письмо не отправлено: ${payload.data.emailError}` : "Письмо не отправлено: email не указан."}`);
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

function CuratorInvitationsView({ workingPracticumId = null }: { workingPracticumId?: string | null }) {
  const [role, setRole] = useState<"STUDENT" | "CURATOR">("STUDENT");
  const [email, setEmail] = useState("");
  const [discordId, setDiscordId] = useState("");
  const [expiresInHours, setExpiresInHours] = useState("24");
  const [inviteUrl, setInviteUrl] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [practicums, setPracticums] = useState<PracticumSummary[]>([]);
  const [practicumId, setPracticumId] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/course/practicums`, { credentials: "include", cache: "no-store" });
        const payload = await response.json().catch(() => ({})) as { data?: PracticumSummary[] };
        if (cancelled || !response.ok || !Array.isArray(payload.data)) return;
        setPracticums(payload.data);
        setPracticumId((current) => current
          || payload.data!.find((item) => item.id === workingPracticumId)?.id
          || payload.data!.find((item) => item.isActive)?.id
          || payload.data![0]?.id
          || "");
      } catch {
        // form still works without the picker — server falls back to the inviting curator's working practicum
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          practicumId: practicumId || undefined,
        }),
      });
      const payload = await response.json() as { data?: { token: string; expiresAt: string; emailSent?: boolean; emailError?: string }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать приглашение");
      setInviteUrl(`${window.location.origin}/?invite=${encodeURIComponent(payload.data.token)}`);
      setNotice(`Ссылка создана до ${new Date(payload.data.expiresAt).toLocaleString("ru-RU")}. ${payload.data.emailSent ? "Письмо отправлено." : payload.data.emailError ? `Письмо не отправлено: ${payload.data.emailError}` : "Письмо не отправлено: email не указан."}`);
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
        {practicums.length > 0 && <label className="form-field"><span>Поток</span><select value={practicumId} onChange={(event) => setPracticumId(event.target.value)}>{practicums.map((item) => <option key={item.id} value={item.id}>{item.title}{item.id === workingPracticumId ? " · ваш рабочий" : item.isActive ? " · эфиры здесь" : ""}</option>)}</select><small className="file-field-note">Куда попадёт участник после подтверждения Discord. По умолчанию — ваш рабочий поток.</small></label>}
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

function CuratorLessonPage({ module, onBack, onNavigate }: { module: CourseApiModule; onBack: () => void; onNavigate: (nextNav: CuratorNav) => void }) {
  const [media, setMedia] = useState<CourseLessonMedia[]>(module.media ?? []);
  const [assignments, setAssignments] = useState<CourseAssignmentSummary[]>(module.assignments ?? []);
  const [description, setDescription] = useState(module.description ?? "");
  const [qaQuestions, setQaQuestions] = useState<string[]>(module.qaQuestions.length > 0 ? module.qaQuestions : [""]);
  const [showAssignmentForm, setShowAssignmentForm] = useState(false);
  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [assignmentDescription, setAssignmentDescription] = useState("");
  const [assignmentRequirements, setAssignmentRequirements] = useState<string[]>([""]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deletingMediaId, setDeletingMediaId] = useState("");
  const [deletingAssignmentId, setDeletingAssignmentId] = useState("");
  const [notice, setNotice] = useState("");
  const [noticeError, setNoticeError] = useState(false);
  const [mediaGroups, setMediaGroups] = useState<CourseMediaGroup[]>(module.mediaGroups ?? []);
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupPreset, setNewGroupPreset] = useState("");
  const [newGroupCustom, setNewGroupCustom] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [deletingGroupId, setDeletingGroupId] = useState("");
  const showNotice = (message: string, error = false) => { setNoticeError(error); setNotice(message); };
  const thematicMedia = media.filter((item) => item.kind !== "QA");
  const qaMedia = media.filter((item) => item.kind === "QA");
  // Practice/Advanced records that aren't inside a named block — the normal case for a curator
  // who names the whole lesson after its topic ("Бектест практика тест") instead of naming a
  // block inside a generically-titled lesson. Blocks stay available for the rarer case where one
  // lesson genuinely needs several named sub-groups.
  // QA-kind media gets its own card below instead — same split as the non-block layout.
  const ungroupedMedia = media.filter((item) => !item.groupId && item.kind !== "QA");
  const mediaGroupPresets = ["Бектест", "Пресессия", "WPA"];

  const addMediaGroup = async () => {
    const title = newGroupPreset === "__custom__" ? newGroupCustom.trim() : newGroupPreset;
    if (!title) return;
    setSavingGroup(true); showNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${module.id}/media-groups`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
      const payload = await response.json().catch(() => ({})) as { data?: CourseMediaGroup; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать блок");
      setMediaGroups((current) => [...current, payload.data as CourseMediaGroup]);
      setNewGroupPreset(""); setNewGroupCustom(""); setAddingGroup(false);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось создать блок", true); }
    finally { setSavingGroup(false); }
  };
  const removeMediaGroup = async (group: CourseMediaGroup) => {
    if (deletingGroupId) return;
    if (group.media.length > 0) { showNotice("Сначала удалите записи из блока — тогда можно будет удалить и сам блок.", true); return; }
    if (!window.confirm(`Удалить блок «${group.title}»?`)) return;
    setDeletingGroupId(group.id); showNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media-groups/${group.id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) { const payload = await response.json().catch(() => ({})) as { message?: string }; throw new Error(payload.message ?? "Не удалось удалить блок"); }
      setMediaGroups((current) => current.filter((item) => item.id !== group.id));
      showNotice(`Блок «${group.title}» удалён.`);
    } catch (error) { showNotice(error instanceof Error ? error.message : "Не удалось удалить блок", true); }
    finally { setDeletingGroupId(""); }
  };
  const openMediaLibraryForGroup = (groupId: string) => {
    window.sessionStorage.setItem("curator-target-module", module.id);
    window.sessionStorage.setItem("curator-target-group", groupId);
    window.sessionStorage.setItem("curator-target-kind", "STREAM");
    onNavigate("Медиатека");
  };

  const openMediaLibrary = (targetKind: "STREAM" | "QA" | "BREAKDOWN") => {
    window.sessionStorage.setItem("curator-target-module", module.id);
    window.sessionStorage.removeItem("curator-target-group");
    window.sessionStorage.setItem("curator-target-kind", targetKind);
    onNavigate("Медиатека");
  };
  // The assignment creator uses the same canonical form as the curator sidebar. Keep the
  // module context in session storage so the form can preselect this exact module.
  useEffect(() => {
    if (!showAssignmentForm) return;
    window.sessionStorage.setItem(ASSIGNMENT_TARGET_MODULE_KEY, module.id);
    onNavigate("Создать задание");
  }, [module.id, onNavigate, showAssignmentForm]);
  const createAssignment = async () => {
    if (!assignmentTitle.trim() || !assignmentDescription.trim()) return;
    setSaving(true); showNotice("");
    try {
      const requirements = assignmentRequirements.map((requirement) => requirement.trim()).filter(Boolean);
      const response = await fetch(`${API_ORIGIN}/api/assignments`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ moduleId: module.id, title: assignmentTitle.trim(), description: assignmentDescription.trim(), requirements, allowedFormats: ["comment", "image"] }) });
      const payload = await response.json().catch(() => ({})) as { data?: CourseAssignmentSummary; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать домашнее задание");
      const createdAssignment = payload.data;
      setAssignments((current) => [...current, {
        ...createdAssignment,
        title: createdAssignment.title || assignmentTitle.trim(),
        description: createdAssignment.description || assignmentDescription.trim(),
        requirements: Array.isArray(createdAssignment.requirements) ? createdAssignment.requirements : requirements,
        allowedFormats: Array.isArray(createdAssignment.allowedFormats) ? createdAssignment.allowedFormats : ["comment", "image"],
        deadline: createdAssignment.deadline ?? null,
        materials: Array.isArray(createdAssignment.materials) ? createdAssignment.materials : [],
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
      setMediaGroups((current) => current.map((group) => ({ ...group, media: group.media.filter((mediaItem) => mediaItem.id !== item.id) })));
      showNotice("Запись убрана из урока и больше не будет показана ученикам.");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Не удалось удалить запись.", true);
    } finally {
      setSaving(false);
      setDeletingMediaId("");
    }
  };

  const archiveAssignment = async (assignment: CourseAssignmentSummary) => {
    if (deletingAssignmentId) return;
    const title = assignment.title?.trim() || "Без названия";
    if (!window.confirm(`Удалить ДЗ «${title}» из этого урока? Уже отправленные учениками работы по нему сохранятся в истории.`)) return;
    setDeletingAssignmentId(assignment.id);
    setSaving(true);
    showNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/assignments/${assignment.id}`, { method: "DELETE", credentials: "include" });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось удалить домашнее задание.");
      setAssignments((current) => current.filter((item) => item.id !== assignment.id));
      showNotice("Домашнее задание удалено из урока.");
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "Не удалось удалить домашнее задание.", true);
    } finally {
      setSaving(false);
      setDeletingAssignmentId("");
    }
  };
  const save = async () => {
    setSaving(true); showNotice("");
    try {
      // Practice lessons don't expose drag-reorder within a block yet, so there's nothing to
      // send order for — the flat `media` list also spans every block at once, and reordering
      // it here would scramble each block's own position sequence for no reason.
      const qaQuestionsPayload = qaQuestions.map((question) => question.trim()).filter(Boolean);
      const requests = isBlockLayoutSection(module.section)
        ? [fetch(`${API_ORIGIN}/api/course/modules/${module.id}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: module.title, description, qaQuestions: qaQuestionsPayload }) })]
        : [
          fetch(`${API_ORIGIN}/api/course/modules/${module.id}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: module.title, description, qaQuestions: qaQuestionsPayload }) }),
          fetch(`${API_ORIGIN}/api/course/modules/${module.id}/media/reorder`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaIds: media.map((item) => item.id) }) }),
        ];
      const responses = await Promise.all(requests);
      if (responses.some((response) => !response.ok)) throw new Error("Не удалось сохранить изменения урока");
      showNotice("Изменения сохранены. Именно так урок увидит ученик.");
    } catch (reason) { showNotice(reason instanceof Error ? reason.message : "Не удалось сохранить изменения урока", true); }
    finally { setSaving(false); }
  };

  return <div className="module-page curator-lesson-page">
    <div className="module-page-toolbar"><button className="secondary-button" type="button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к программе</button><span className="module-page-breadcrumb">{module.section} / {module.title}</span><div className="curator-lesson-toolbar-actions">{!isBlockLayoutSection(module.section) && <button className="secondary-button" type="button" onClick={() => openMediaLibrary("STREAM")}><Plus size={15} /> Добавить стрим</button>}<button className="primary-button" type="button" disabled={saving} onClick={() => void save()}>{saving ? "Сохраняем…" : "Сохранить урок"}</button></div></div>
    <div className="curator-lesson-page-header"><span className="section-kicker">УРОК {module.number}</span><h2>{module.title}</h2></div>
    <div className="curator-lesson-hint"><Settings2 size={16} /><span>{isBlockLayoutSection(module.section) ? "Записи можно добавлять прямо в урок. Именованные блоки нужны, только если хочешь разбить урок на несколько тем." : "Тематические стримы находятся в центральном блоке, а записи Q&A — рядом с вопросами."}</span></div>
    {isBlockLayoutSection(module.section) ? <div className="module-resource-grid practice-lesson-layout">
      <section className="module-resource-card module-description-card"><div className="module-resource-heading"><BookOpen size={17} /><h3>Описание</h3><span>Редактируется</span></div><textarea className="curator-lesson-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Добавьте описание урока…" /></section>
      <section className="module-resource-card module-block-card"><div className="module-resource-heading"><Play size={17} /><h3>Материалы урока</h3><span>{ungroupedMedia.length} {ungroupedMedia.length === 1 ? "материал" : "материалов"}</span><button className="quiet-button add-button" type="button" onClick={() => openMediaLibrary("STREAM")}><Plus size={15} /> Добавить запись</button></div>{ungroupedMedia.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Записей пока нет</strong><span>Добавь запись сюда или создай именованный блок ниже.</span></div> : <div className="module-video-stack">{[...ungroupedMedia].reverse().map((item) => <div className="module-video-card" key={item.id}><div className="module-video-heading"><span className="module-video-label">{item.title ?? "Материал без названия"}</span><span className="stream-duration">{item.status === "PUBLISHED" ? "ОПУБЛИКОВАНО" : "ЧЕРНОВИК"}</span></div><div className="module-video-stage">{item.embedUrl && <TrackedVideo mediaId={item.id} src={item.embedUrl} title={item.title ?? "Запись"} />}</div><div className="module-video-footer"><span className="module-video-kind-badge">{mediaKindLabel(item.kind)}</span><button className="secondary-button danger-button compact-button" type="button" disabled={saving || deletingMediaId === item.id} onClick={() => void archiveLessonMedia(item)}>{deletingMediaId === item.id ? "Удаляем…" : "Удалить"}</button></div></div>)}</div>}</section>
      {mediaGroups.map((group) => <section className="module-resource-card module-block-card" key={group.id}><div className="module-resource-heading"><Play size={17} /><h3>{group.title}</h3><span>{group.media.length} {group.media.length === 1 ? "материал" : "материалов"}</span><button className="quiet-button add-button" type="button" onClick={() => openMediaLibraryForGroup(group.id)}><Plus size={15} /> Добавить запись</button><button className="icon-button compact module-block-remove" type="button" aria-label={`Удалить блок «${group.title}»`} disabled={deletingGroupId === group.id} onClick={() => void removeMediaGroup(group)}><X size={14} /></button></div>{group.media.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Записей пока нет</strong><span>Появятся здесь, когда вы их добавите.</span></div> : <div className="module-video-stack">{[...group.media].reverse().map((item) => <div className="module-video-card" key={item.id}><div className="module-video-heading"><span className="module-video-label">{item.title ?? "Материал без названия"}</span><span className="stream-duration">{item.status === "PUBLISHED" ? "ОПУБЛИКОВАНО" : "ЧЕРНОВИК"}</span></div><div className="module-video-stage">{item.embedUrl && <TrackedVideo mediaId={item.id} src={item.embedUrl} title={item.title ?? "Запись"} />}</div><div className="module-video-footer"><span className="module-video-kind-badge">{mediaKindLabel(item.kind)}</span><button className="secondary-button danger-button compact-button" type="button" disabled={saving || deletingMediaId === item.id} onClick={() => void archiveLessonMedia(item)}>{deletingMediaId === item.id ? "Удаляем…" : "Удалить"}</button></div></div>)}</div>}</section>)}
      <section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>{qaMedia.length} {qaMedia.length === 1 ? "запись" : "записей"}</span><button className="quiet-button add-button" type="button" onClick={() => openMediaLibrary("QA")}><Plus size={15} /> Добавить Q&A</button></div>{qaMedia.length > 0 && <div className="module-video-stack">{qaMedia.map((item) => <div className="module-qa-video-card" key={item.id}><div className="module-qa-video-stage">{item.embedUrl && <TrackedVideo mediaId={item.id} src={item.embedUrl} title={item.title ?? "Q&A с куратором"} />}<span>{item.title ?? "Q&A-запись"}</span></div><div className="module-video-footer"><span className="module-video-kind-badge">{item.status === "PUBLISHED" ? "Опубликовано" : "Черновик"}</span><button className="secondary-button danger-button compact-button" type="button" disabled={saving || deletingMediaId === item.id} onClick={() => void archiveLessonMedia(item)}>{deletingMediaId === item.id ? "Удаляем…" : "Удалить"}</button></div></div>)}</div>}{qaMedia.length === 0 && <div className="module-action-feedback">Добавьте Q&A-запись — она будет показана ученику именно в этом блоке.</div>}<div className="assignment-criteria-editor module-qa-questions-editor"><div className="assignment-criteria-heading"><span>Вопросы Q&A</span><button className="quiet-button" type="button" onClick={() => setQaQuestions((current) => [...current, ""])}><Plus size={14} /> Добавить вопрос</button></div>{qaQuestions.map((question, index) => <div className="assignment-criterion-row" key={`qa-question-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><textarea value={question} onChange={(event) => setQaQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="Например: Разбор примера на истории" rows={2} />{qaQuestions.length > 1 && <button className="icon-button compact" type="button" aria-label={`Удалить вопрос ${index + 1}`} onClick={() => setQaQuestions((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>}</div>)}</div></section>
      <section className="module-resource-card module-block-add-card">{addingGroup ? <div className="module-create-groups"><div className="module-create-group-row"><select value={newGroupPreset} onChange={(event) => setNewGroupPreset(event.target.value)}><option value="">Выбери название блока</option>{mediaGroupPresets.map((preset) => <option value={preset} key={preset}>{preset}</option>)}<option value="__custom__">Своё название…</option></select>{newGroupPreset === "__custom__" && <input value={newGroupCustom} onChange={(event) => setNewGroupCustom(event.target.value)} placeholder="Например, Разбор недели 3" maxLength={80} autoFocus />}<button className="icon-button compact" type="button" aria-label="Отмена" onClick={() => { setAddingGroup(false); setNewGroupPreset(""); setNewGroupCustom(""); }}><X size={14} /></button></div><button className="primary-button" type="button" disabled={savingGroup || !(newGroupPreset === "__custom__" ? newGroupCustom.trim() : newGroupPreset)} onClick={() => void addMediaGroup()}>{savingGroup ? "Создаём…" : "Создать блок"}</button></div> : <button className="quiet-button add-button module-block-add-button" type="button" onClick={() => setAddingGroup(true)}><Plus size={15} /> Добавить блок</button>}</section>
    </div> : <div className="module-resource-grid">
      <section className="module-resource-card module-description-card"><div className="module-resource-heading"><BookOpen size={17} /><h3>Описание</h3><span>Редактируется</span></div><textarea className="curator-lesson-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Добавьте описание урока…" /></section>
      <section className="module-resource-card module-stream-card"><div className="module-resource-heading"><Play size={17} /><h3>Тематические записи</h3><span>{thematicMedia.length} {thematicMedia.length === 1 ? "материал" : "материалов"}</span><button className="quiet-button add-button" type="button" onClick={() => openMediaLibrary("STREAM")}><Plus size={15} /> Добавить стрим</button></div>{thematicMedia.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Тематических стримов пока нет</strong><span>Q&A-записи не смешиваются с тематическими материалами.</span></div> : <div className="module-video-stack">{thematicMedia.map((item) => <div className={`module-video-card ${draggedId === item.id ? "is-dragging" : ""}`} key={item.id} draggable onDragStart={() => setDraggedId(item.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveMedia(item.id)}><div className="module-video-heading"><span className="module-video-label">{item.title ?? "Материал без названия"}</span><span className="stream-duration">{item.status === "PUBLISHED" ? "ОПУБЛИКОВАНО" : "ЧЕРНОВИК"}</span></div><div className="module-video-stage">{item.embedUrl && <TrackedVideo mediaId={item.id} src={item.embedUrl} title={item.title ?? "Запись стрима"} />}<span className="curator-drag-handle" title="Перетащите, чтобы изменить порядок">⋮⋮</span></div><div className="module-video-footer"><span className="module-video-kind-badge">{mediaKindLabel(item.kind)}</span><button className="secondary-button danger-button compact-button" type="button" disabled={saving || deletingMediaId === item.id} onClick={() => void archiveLessonMedia(item)}>{deletingMediaId === item.id ? "Удаляем…" : "Удалить"}</button></div></div>)}</div>}</section>
      <section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{assignments.length} {assignments.length === 1 ? "задание" : "заданий"}</span><button className="quiet-button add-button" type="button" onClick={() => setShowAssignmentForm((current) => !current)}><Plus size={15} /> {showAssignmentForm ? "Закрыть" : "Добавить ДЗ"}</button></div>{showAssignmentForm && <div className="curator-inline-form"><input value={assignmentTitle} onChange={(event) => setAssignmentTitle(event.target.value)} placeholder="Название домашнего задания" /><textarea value={assignmentDescription} onChange={(event) => setAssignmentDescription(event.target.value)} placeholder="Описание и контекст для ученика" /><div className="assignment-criteria-editor"><div className="assignment-criteria-heading"><span>Критерии проверки</span><button className="quiet-button" type="button" onClick={() => setAssignmentRequirements((current) => [...current, ""])}><Plus size={14} /> Добавить критерий</button></div>{assignmentRequirements.map((requirement, index) => <div className="assignment-criterion-row" key={`new-criterion-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><input value={requirement} onChange={(event) => setAssignmentRequirements((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="Например: разобрать график и описать выводы" />{assignmentRequirements.length > 1 && <button className="icon-button compact" type="button" aria-label={`Удалить критерий ${index + 1}`} onClick={() => setAssignmentRequirements((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>}</div>)}</div><button className="primary-button" type="button" disabled={saving || !assignmentTitle.trim() || !assignmentDescription.trim()} onClick={() => void createAssignment()}>{saving ? "Создаём…" : "Создать ДЗ в этом уроке"}</button></div>}{assignments.length > 0 ? <div className="curator-assignment-list">{assignments.map((assignment) => <article className="curator-assignment-card" key={assignment.id}><div className="curator-assignment-card-head"><div><strong>{assignment.title}</strong><p>{assignment.description}</p></div><button className="secondary-button danger-button compact-button" type="button" disabled={saving || deletingAssignmentId === assignment.id} onClick={() => void archiveAssignment(assignment)}>{deletingAssignmentId === assignment.id ? "Удаляем…" : "Удалить"}</button></div>{assignment.requirements.length > 0 && <ol>{assignment.requirements.map((requirement, index) => <li key={`${assignment.id}-${index}`}>{requirement}</li>)}</ol>}<AssignmentMaterialsInline materials={assignment.materials} /></article>)}</div> : <div className="module-empty-copy">В этом уроке пока нет домашних заданий.</div>}</section>
      <section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>{qaMedia.length} {qaMedia.length === 1 ? "запись" : "записей"}</span><button className="quiet-button add-button" type="button" onClick={() => openMediaLibrary("QA")}><Plus size={15} /> Добавить Q&A</button></div>{qaMedia.length > 0 && <div className="module-video-stack">{qaMedia.map((item) => <div className="module-qa-video-card" key={item.id}><div className="module-qa-video-stage">{item.embedUrl && <TrackedVideo mediaId={item.id} src={item.embedUrl} title={item.title ?? "Q&A с куратором"} />}<span>{item.title ?? "Q&A-запись"}</span></div><div className="module-video-footer"><span className="module-video-kind-badge">{item.status === "PUBLISHED" ? "Опубликовано" : "Черновик"}</span><button className="secondary-button danger-button compact-button" type="button" disabled={saving || deletingMediaId === item.id} onClick={() => void archiveLessonMedia(item)}>{deletingMediaId === item.id ? "Удаляем…" : "Удалить"}</button></div></div>)}</div>}{qaMedia.length === 0 && <div className="module-action-feedback">Добавьте Q&A-запись — она будет показана ученику именно в этом блоке.</div>}<div className="assignment-criteria-editor module-qa-questions-editor"><div className="assignment-criteria-heading"><span>Вопросы Q&A</span><button className="quiet-button" type="button" onClick={() => setQaQuestions((current) => [...current, ""])}><Plus size={14} /> Добавить вопрос</button></div>{qaQuestions.map((question, index) => <div className="assignment-criterion-row" key={`qa-question-${index}`}><span>{String(index + 1).padStart(2, "0")}</span><textarea value={question} onChange={(event) => setQaQuestions((current) => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item))} placeholder="Например: Разбор примера на истории" rows={2} />{qaQuestions.length > 1 && <button className="icon-button compact" type="button" aria-label={`Удалить вопрос ${index + 1}`} onClick={() => setQaQuestions((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button>}</div>)}</div></section>
    </div>}{notice && <div className={`detail-feedback ${noticeError ? "error" : "accepted"} curator-lesson-notice`} role={noticeError ? "alert" : undefined}>{notice}</div>}
  </div>;
}

function CuratorModuleAccessView({ onNavigate, viewingPracticumId = null }: { onNavigate: (nextNav: CuratorNav) => void; viewingPracticumId?: string | null }) {
  const [modules, setModules] = useState<CourseApiModule[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [openedModuleId, setOpenedModuleId] = useState("");
  const [showModuleForm, setShowModuleForm] = useState(false);
  const [moduleTitle, setModuleTitle] = useState("");
  const [moduleDescription, setModuleDescription] = useState("");
  // Which "Добавить урок"/"Добавить практику"/"Добавить Advanced" button opened the (shared)
  // create form — decides both its copy and which Module.section the new module is tagged with.
  const [creatingSection, setCreatingSection] = useState<"Education" | "Practice" | "Advanced">("Education");
  // The practice/Advanced-only "block picker" step — each row becomes one MediaGroup on submit. "custom"
  // is a sentinel preset value that swaps the row to a free-text input instead of the dropdown.
  const [mediaGroupRows, setMediaGroupRows] = useState<{ key: number; preset: string; custom: string }[]>([]);
  const mediaGroupKeyRef = useRef(0);
  const addMediaGroupRow = () => { mediaGroupKeyRef.current += 1; setMediaGroupRows((current) => [...current, { key: mediaGroupKeyRef.current, preset: "", custom: "" }]); };
  const updateMediaGroupRow = (key: number, patch: Partial<{ preset: string; custom: string }>) => setMediaGroupRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  const removeMediaGroupRow = (key: number) => setMediaGroupRows((current) => current.filter((row) => row.key !== key));
  useEffect(() => { const url = `${API_ORIGIN}/api/course/manage${viewingPracticumId ? `?viewPracticumId=${viewingPracticumId}` : ""}`; void fetch(url, { credentials: "include", cache: "no-store" }).then(async (response) => { if (!response.ok) throw new Error("Не удалось загрузить программу"); const payload = await response.json() as { data: { modules: CourseApiModule[] } }; setModules(payload.data.modules); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Не удалось загрузить программу")); }, [viewingPracticumId]);
  useEffect(() => {
    const targetModuleId = window.sessionStorage.getItem(OPEN_MODULE_AFTER_PUBLISH_KEY);
    if (!targetModuleId || !modules.some((module) => module.id === targetModuleId)) return;
    window.sessionStorage.removeItem(OPEN_MODULE_AFTER_PUBLISH_KEY);
    const timer = window.setTimeout(() => setOpenedModuleId(targetModuleId), 0);
    return () => window.clearTimeout(timer);
  }, [modules]);
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
  const deleteModule = async (module: CourseApiModule) => { if (!window.confirm(`Удалить урок «${module.title}»? Все материалы урока без работ учеников будут удалены.`)) return; setBusy(module.id); setError(""); try { const response = await fetch(`${API_ORIGIN}/api/course/modules/${module.id}`, { method: "DELETE", credentials: "include" }); const payload = await response.json().catch(() => null) as { message?: string } | null; if (!response.ok) throw new Error(payload?.message || "Не удалось удалить урок"); setModules((current) => current.filter((item) => item.id !== module.id)); if (openedModuleId === module.id) setOpenedModuleId(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось удалить урок"); } finally { setBusy(""); } };
  const createModule = async () => {
    setBusy("new-module"); setError("");
    try {
      const mediaGroups = isBlockLayoutSection(creatingSection)
        ? mediaGroupRows.map((row) => row.preset === "__custom__" ? row.custom.trim() : row.preset).filter((title) => title.length > 0)
        : undefined;
      const response = await fetch(`${API_ORIGIN}/api/course/modules`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: moduleTitle, description: moduleDescription.trim() || undefined, section: creatingSection, mediaGroups }) });
      const payload = await response.json().catch(() => ({})) as { data?: CourseApiModule; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать урок");
      setModules((current) => [...current, payload.data as CourseApiModule]);
      setShowModuleForm(false); setModuleTitle(""); setModuleDescription(""); setMediaGroupRows([]);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось создать урок"); }
    finally { setBusy(""); }
  };
  const openModuleForm = (section: "Education" | "Practice" | "Advanced") => {
    if (showModuleForm && creatingSection === section) { setShowModuleForm(false); return; }
    setCreatingSection(section); setShowModuleForm(true); setMediaGroupRows([]);
  };
  const renderModuleRow = (module: CourseApiModule) => { const unlocked = module.status !== "LOCKED"; const contentCount = module.media.length + module.assignments.length; return <div key={module.id}><div className={`module-access-row ${unlocked ? "is-unlocked" : "is-locked"}`}><div className={`module-access-status ${unlocked ? "open" : "closed"}`}>{unlocked ? "Доступен ученикам" : "Закрыт"}</div><div className="module-access-copy"><strong data-module-number={module.number}>{module.title}</strong><span>{module.section} · {pluralizeMaterials(contentCount)}</span></div><div className="module-access-actions"><button className="secondary-button" type="button" onClick={() => setOpenedModuleId(module.id)}>Открыть урок</button><button className={unlocked ? "secondary-button" : "primary-button"} type="button" disabled={busy === module.id} onClick={() => void toggle(module)}>{busy === module.id ? "Сохраняем…" : unlocked ? "Закрыть урок" : "Разблокировать"}</button><button className="secondary-button" type="button" disabled={busy === module.id} onClick={() => void markCompleted(module)}>Урок пройден</button><button className="secondary-button danger-button" type="button" disabled={busy === module.id} onClick={() => void deleteModule(module)}>Удалить</button></div></div></div>; };
  // Same split (and same independent per-track numbering) as the student's Теория/Практика
  // toggle — see Module.section, withTrackNumbers and CourseView.
  const numberedModules = withTrackNumbers(modules);
  const openedModule = numberedModules.find((module) => module.id === openedModuleId);
  if (openedModule) return <CuratorLessonPage key={openedModule.id} module={openedModule} onBack={() => setOpenedModuleId("")} onNavigate={onNavigate} />;
  const unlockedCount = modules.filter((module) => module.status !== "LOCKED").length;
  const theoryModules = numberedModules.filter((module) => module.section !== "Practice" && module.section !== "Advanced");
  const practiceModules = numberedModules.filter((module) => module.section === "Practice");
  const advancedModules = numberedModules.filter((module) => module.section === "Advanced");
  const moduleFormLabel = creatingSection === "Practice" ? "практику" : creatingSection === "Advanced" ? "Advanced-урок" : "урок";
  const mediaGroupPresets = ["Бектест", "Пресессия", "WPA"];
  const moduleForm = showModuleForm && !viewingPracticumId ? <div className="module-create-form"><div className="module-create-form-heading"><div><strong>Добавить {moduleFormLabel} в программу</strong><p>{isBlockLayoutSection(creatingSection) ? `${creatingSection === "Advanced" ? "Advanced-урок" : "Практика"} появится в программе сразу — шаблон урока без ДЗ и Q&A, вместо этого — блоки с записями, которые ты сам называешь.` : "Урок появится в программе сразу — начните добавлять материалы, а открыть доступ ученикам можно одним кликом, когда всё будет готово."}</p></div></div><div className="module-create-fields"><label className="module-create-wide"><span>Название {creatingSection === "Practice" ? "практики" : creatingSection === "Advanced" ? "Advanced-урока" : "урока"}</span><input value={moduleTitle} onChange={(event) => setModuleTitle(event.target.value)} placeholder={creatingSection === "Practice" ? "Например, Разбор сделок · Неделя 1" : creatingSection === "Advanced" ? "Например, Продвинутый бектест · Неделя 1" : "Например, Управление риском"} /></label><label className="module-create-wide"><span>Описание</span><textarea value={moduleDescription} onChange={(event) => setModuleDescription(event.target.value)} placeholder="Что ученик изучит в этом уроке" /></label></div>{isBlockLayoutSection(creatingSection) && <div className="module-create-groups"><div className="module-create-groups-heading"><span>Блоки урока</span><p>Каждый блок — своя папка с записями (Бектест, Пресессия и т.д.). Можно добавить сейчас или пропустить и добавить позже прямо в уроке.</p></div>{mediaGroupRows.map((row) => <div className="module-create-group-row" key={row.key}><select value={row.preset} onChange={(event) => updateMediaGroupRow(row.key, { preset: event.target.value, custom: "" })}><option value="">Выбери название блока</option>{mediaGroupPresets.map((preset) => <option value={preset} key={preset}>{preset}</option>)}<option value="__custom__">Своё название…</option></select>{row.preset === "__custom__" && <input value={row.custom} onChange={(event) => updateMediaGroupRow(row.key, { custom: event.target.value })} placeholder="Например, Разбор недели 3" maxLength={80} autoFocus />}<button className="icon-button compact" type="button" aria-label="Убрать блок" onClick={() => removeMediaGroupRow(row.key)}><X size={14} /></button></div>)}<button className="quiet-button add-button" type="button" onClick={addMediaGroupRow}><Plus size={15} /> Добавить блок</button></div>}<div className="module-create-actions"><button className="secondary-button" type="button" onClick={() => setShowModuleForm(false)}>Отмена</button><button className="primary-button module-add-button" type="button" disabled={busy === "new-module" || !moduleTitle.trim()} onClick={() => void createModule()}><Plus size={16} /> {busy === "new-module" ? "Создаём…" : `Создать ${moduleFormLabel}`}</button></div></div> : null;
  return <section className="content-panel module-access-panel">
    <div className="section-heading"><div><h2>Уроки практикума</h2><p className="section-heading-note">{unlockedCount} из {modules.length} открыто ученикам. Откройте урок — сразу попадёте на страницу, как её видит ученик.</p></div>{!viewingPracticumId && <button className="primary-button module-add-button" type="button" onClick={() => openModuleForm("Education")}><Plus size={16} /> {showModuleForm && creatingSection === "Education" ? "Закрыть форму" : "Добавить урок"}</button>}</div>
    {creatingSection === "Education" && moduleForm}
    {error && <div className="file-error" role="alert">{error}</div>}
    {notice && <div className="form-action-feedback">{notice}</div>}
    <div className="module-access-list">{theoryModules.map(renderModuleRow)}</div>
    <div className="section-heading module-access-practice-heading"><div><h2>Практика</h2><p className="section-heading-note">{practiceModules.length === 0 ? "Начните добавлять уроки практики, когда группа перейдёт к этому этапу." : `${pluralizeLessons(practiceModules.length)} в программе практики.`}</p></div>{!viewingPracticumId && <button className="primary-button module-add-button" type="button" onClick={() => openModuleForm("Practice")}><Plus size={16} /> {showModuleForm && creatingSection === "Practice" ? "Закрыть форму" : "Добавить практику"}</button>}</div>
    {creatingSection === "Practice" && moduleForm}
    {practiceModules.length === 0 ? <div className="empty-state compact"><BookOpen size={20} /><strong>Уроков практики пока нет</strong><span>Появятся здесь, как только вы добавите первый.</span></div> : <div className="module-access-list">{practiceModules.map(renderModuleRow)}</div>}
    <div className="section-heading module-access-practice-heading"><div><h2>Advanced</h2><p className="section-heading-note">{advancedModules.length === 0 ? "Появится ученикам с выданным Advanced-доступом, когда вы добавите первый урок." : `${pluralizeLessons(advancedModules.length)} в программе Advanced.`}</p></div>{!viewingPracticumId && <button className="primary-button module-add-button" type="button" onClick={() => openModuleForm("Advanced")}><Plus size={16} /> {showModuleForm && creatingSection === "Advanced" ? "Закрыть форму" : "Добавить Advanced"}</button>}</div>
    {creatingSection === "Advanced" && moduleForm}
    {advancedModules.length === 0 ? <div className="empty-state compact"><BookOpen size={20} /><strong>Уроков Advanced пока нет</strong><span>Появятся здесь, как только вы добавите первый. Видны только ученикам с Advanced-доступом.</span></div> : <div className="module-access-list">{advancedModules.map(renderModuleRow)}</div>}
  </section>;
}

function CuratorPlaceholder({ title }: { title: string }) {
  return <section className="content-panel curator-placeholder"><div className="empty-state"><Target size={24} /><strong>{title} будет следующим рабочим разделом</strong><span>Каркас роли уже отделён от ученического интерфейса. После проверки основного сценария здесь появятся реальные списки и действия куратора.</span></div></section>;
}

type CuratorMediaItem = CourseLessonMedia & {
  moduleId: string | null;
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

function CuratorMediaLibraryView({ viewingPracticumId = null }: { viewingPracticumId?: string | null }) {
  const [course, setCourse] = useState<CourseState | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [scheduleEventId, setScheduleEventId] = useState("");
  const [groupId, setGroupId] = useState("");
  // Practice/Advanced lessons only render media that's inside a block (see
  // isBlockLayoutSection) — without one of these, "Привязать к уроку" alone silently
  // orphans the record: it stays visible in the flat "Медиатека"/"Записи" lists but never
  // appears on the lesson page for curator or student. addingGroup lets the curator create
  // the missing block right here instead of having to leave and come back from the lesson
  // page's own "Добавить блок".
  const [addingGroup, setAddingGroup] = useState(false);
  const [newGroupPreset, setNewGroupPreset] = useState("");
  const [newGroupCustom, setNewGroupCustom] = useState("");
  const [savingGroup, setSavingGroup] = useState(false);
  const [title, setTitle] = useState("");
  const [vimeoUrl, setVimeoUrl] = useState("");
  const [kind, setKind] = useState<CuratorMediaItem["kind"]>("STREAM");
  const [audience, setAudience] = useState<"ALL" | "ADVANCED">("ALL");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [viewersFor, setViewersFor] = useState("");
  const [viewersLoading, setViewersLoading] = useState(false);
  const [viewers, setViewers] = useState<{ id: string; ipAddress: string | null; createdAt: string; viewer: { id: string; role: string; name: string } }[]>([]);
  const [reclassifying, setReclassifying] = useState(false);
  const [reclassifyKind, setReclassifyKind] = useState<CuratorMediaItem["kind"]>("STREAM");
  const [reclassifyAudience, setReclassifyAudience] = useState<"ALL" | "ADVANCED">("ALL");
  const [reclassifyModuleId, setReclassifyModuleId] = useState("");
  const [reclassifyScheduleEventId, setReclassifyScheduleEventId] = useState("");
  const [reclassifyGroupId, setReclassifyGroupId] = useState("");
  const [addingReclassifyGroup, setAddingReclassifyGroup] = useState(false);
  const [newReclassifyGroupPreset, setNewReclassifyGroupPreset] = useState("");
  const [newReclassifyGroupCustom, setNewReclassifyGroupCustom] = useState("");
  const [savingReclassifyGroup, setSavingReclassifyGroup] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");

  const loadCourse = useCallback(async () => {
    const url = `${API_ORIGIN}/api/course/manage${viewingPracticumId ? `?viewPracticumId=${viewingPracticumId}` : ""}`;
    const response = await fetch(url, { credentials: "include", cache: "no-store" });
    const payload = await response.json().catch(() => ({})) as CourseApiPayload & { message?: string };
    if (!response.ok) throw new Error(payload.message ?? "Не удалось загрузить программу.");
    const nextCourse = normalizeCourse(payload);
    if (!nextCourse) throw new Error("В программе пока нет уроков.");
    setCourse(nextCourse);
    const firstModuleId = nextCourse.modules[0]?.id ?? "";
    setModuleId((current) => current || firstModuleId);
  }, [viewingPracticumId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCourse()
        .catch((error: unknown) => setNotice(error instanceof Error ? error.message : "Не удалось загрузить программу."))
        .finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCourse]);

  const moduleOptions = useMemo(() => course?.modules.map((module) => ({
    id: module.id,
    label: `${module.number} · ${module.title}`,
    section: module.section,
  })) ?? [], [course]);
  // Grouped by track so a growing lesson list (both tracks share 00, 01, 02… numbering
  // independently — see withTrackNumbers) stays easy to scan instead of one flat list.
  const theoryModuleOptions = moduleOptions.filter((module) => module.section !== "Practice" && module.section !== "Advanced");
  const practiceModuleOptions = moduleOptions.filter((module) => module.section === "Practice");
  const advancedModuleOptions = moduleOptions.filter((module) => module.section === "Advanced");
  const items = useMemo<CuratorMediaItem[]>(() => {
    if (!course) return [];
    const eventTitles = new Map(course.scheduleEvents.map((event) => [event.id, event.title]));
    const moduleItems = course.modules.flatMap((module) => (course.contentByModule[module.id]?.media ?? []).map((media) => ({
      ...media,
      moduleId: module.id,
      moduleTitle: `${module.number} · ${module.title}`,
      eventTitle: media.scheduleEventId ? eventTitles.get(media.scheduleEventId) : undefined,
    })));
    const globalItems = course.globalMedia.map((media) => ({
      ...media,
      moduleId: null,
      moduleTitle: "Общая медиатека",
      eventTitle: media.scheduleEventId ? eventTitles.get(media.scheduleEventId) : undefined,
    }));
    // globalMedia is now scoped server-side to moduleId+scheduleEventId both null, so a
    // schedule-event recording (moduleId null, scheduleEventId set) only shows up here.
    const scheduleItems = course.scheduleEvents.flatMap((event) => event.recordings.map((media) => ({
      ...media,
      moduleId: null,
      moduleTitle: "Расписание",
      eventTitle: event.title,
    })));
    return [...moduleItems, ...globalItems, ...scheduleItems];
  }, [course]);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  // "Newest first": a draft has no publishedAt yet, so fall back to createdAt — otherwise every
  // still-unpublished recording (exactly the ones a curator most needs to find right after a
  // stream ends) sorted as if from 1970 and sank to the very bottom of the list.
  const allItemsSorted = useMemo(() => [...items].sort((a, b) => new Date(b.publishedAt ?? b.createdAt).getTime() - new Date(a.publishedAt ?? a.createdAt).getTime()), [items]);
  const manualItemsSorted = useMemo(() => [...items].sort((a, b) => a.libraryPosition - b.libraryPosition || new Date(b.publishedAt ?? b.createdAt).getTime() - new Date(a.publishedAt ?? a.createdAt).getTime()), [items]);
  const [librarySortMode, setLibrarySortMode] = useState<"newest" | "manual">("newest");
  const [manualOrderIds, setManualOrderIds] = useState<string[] | null>(null);
  const [draggedLibraryId, setDraggedLibraryId] = useState<string | null>(null);
  const [reorderingLibrary, setReorderingLibrary] = useState(false);
  // Drop any locally-dragged order once a fresh course load replaces it with server state —
  // adjusted during render (React's recommended reset-on-change pattern) rather than an effect,
  // so this doesn't fire an extra commit after the one that already updated `course`.
  const [manualOrderCourse, setManualOrderCourse] = useState(course);
  if (course !== manualOrderCourse) { setManualOrderCourse(course); setManualOrderIds(null); }
  const displayedItems = librarySortMode === "manual"
    ? (manualOrderIds ? manualOrderIds.flatMap((id) => { const found = items.find((item) => item.id === id); return found ? [found] : []; }) : manualItemsSorted)
    : allItemsSorted;
  // Drag reorders locally and saves immediately on drop — there's no page-wide "Save" button
  // here (unlike the per-lesson editor), so the order the curator sees is always the order
  // that's actually persisted.
  const moveLibraryItem = (targetId: string) => {
    if (!draggedLibraryId || draggedLibraryId === targetId) return;
    const base = manualOrderIds ?? manualItemsSorted.map((item) => item.id);
    const from = base.indexOf(draggedLibraryId);
    const to = base.indexOf(targetId);
    if (from < 0 || to < 0) return;
    const next = [...base];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setManualOrderIds(next);
    setReorderingLibrary(true);
    void fetch(`${API_ORIGIN}/api/course/media/reorder`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mediaIds: next }) })
      .finally(() => setReorderingLibrary(false));
  };
  const isGlobalMedia = kind === "TALKS";
  const groupTitle = groupId ? course?.contentByModule[moduleId]?.mediaGroups?.find((group) => group.id === groupId)?.title : undefined;
  const mediaGroupPresets = ["Бектест", "Пресессия", "WPA"];
  // Optional, not required — a Practice/Advanced record with no groupId still shows up on the
  // lesson page (see the "Материалы урока" card in CuratorLessonPage/ModuleOverviewPage). Blocks
  // exist for a curator who wants to split ONE lesson into several named sub-groups; most
  // curators instead name the whole lesson after its topic ("Бектест практика тест") and never
  // need one, so the picker below stays optional rather than gating publish.
  const moduleGroups = moduleId ? course?.contentByModule[moduleId]?.mediaGroups ?? [] : [];
  const isBlockLayoutModule = !isGlobalMedia && isBlockLayoutSection(moduleOptions.find((module) => module.id === moduleId)?.section ?? "");
  // A module whose whole section is "Advanced" already hides itself entirely from a
  // non-Advanced student (see course-service.ts#getForUser's module filter) — the per-media
  // "Только Advanced-ученикам" toggle can't add anything there, only invite the mistake of
  // leaving it off and assuming that means something. So it's force-synced to ADVANCED and
  // locked whenever the selected lesson is already Advanced, instead of asking the curator to
  // remember it. The toggle stays a real, meaningful choice for a Theory/Practice lesson, where
  // it cherry-picks one recording as Advanced-only inside an otherwise-visible-to-everyone
  // lesson (see the module-filter comment above).
  const selectedModuleIsAdvanced = moduleOptions.find((module) => module.id === moduleId)?.section === "Advanced";
  const reclassifyModuleGroups = reclassifyModuleId ? course?.contentByModule[reclassifyModuleId]?.mediaGroups ?? [] : [];
  const isBlockLayoutReclassifyModule = reclassifyKind !== "TALKS" && isBlockLayoutSection(moduleOptions.find((module) => module.id === reclassifyModuleId)?.section ?? "");
  const reclassifySelectedModuleIsAdvanced = moduleOptions.find((module) => module.id === reclassifyModuleId)?.section === "Advanced";
  const mediaDestinationLabel = groupTitle ? `блок «${groupTitle}»` : isBlockLayoutModule ? "материалы урока" : kind === "QA" ? "Q&A урока" : kind === "BREAKDOWN" ? "разбор урока" : kind === "LESSON_VIDEO" ? "урок" : "тематический блок урока";

  const createGroupForNewMedia = async () => {
    const groupTitleInput = newGroupPreset === "__custom__" ? newGroupCustom.trim() : newGroupPreset;
    if (!groupTitleInput || !moduleId) return;
    setSavingGroup(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${moduleId}/media-groups`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: groupTitleInput }) });
      const payload = await response.json().catch(() => ({})) as { data?: CourseMediaGroup; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать блок");
      await loadCourse();
      setGroupId(payload.data.id);
      setNewGroupPreset(""); setNewGroupCustom(""); setAddingGroup(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось создать блок");
    } finally {
      setSavingGroup(false);
    }
  };
  const createGroupForReclassify = async () => {
    const groupTitleInput = newReclassifyGroupPreset === "__custom__" ? newReclassifyGroupCustom.trim() : newReclassifyGroupPreset;
    if (!groupTitleInput || !reclassifyModuleId) return;
    setSavingReclassifyGroup(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/modules/${reclassifyModuleId}/media-groups`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: groupTitleInput }) });
      const payload = await response.json().catch(() => ({})) as { data?: CourseMediaGroup; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать блок");
      await loadCourse();
      setReclassifyGroupId(payload.data.id);
      setNewReclassifyGroupPreset(""); setNewReclassifyGroupCustom(""); setAddingReclassifyGroup(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось создать блок");
    } finally {
      setSavingReclassifyGroup(false);
    }
  };
  useEffect(() => {
    const targetModuleId = window.sessionStorage.getItem("curator-target-module");
    const targetEventId = window.sessionStorage.getItem("curator-target-event");
    const targetKind = window.sessionStorage.getItem("curator-target-kind");
    const targetGroupId = window.sessionStorage.getItem("curator-target-group");
    if (targetKind === "STREAM" || targetKind === "QA" || targetKind === "BREAKDOWN") window.setTimeout(() => setKind(targetKind), 0);
    window.sessionStorage.removeItem("curator-target-kind");
    if (targetEventId && course?.scheduleEvents.some((event) => event.id === targetEventId)) {
      window.sessionStorage.removeItem("curator-target-event");
      window.setTimeout(() => setScheduleEventId(targetEventId), 0);
    }
    if (targetGroupId) {
      window.sessionStorage.removeItem("curator-target-group");
      window.setTimeout(() => setGroupId(targetGroupId), 0);
    }
    if (!targetModuleId || !moduleOptions.some((module) => module.id === targetModuleId)) return;
    window.sessionStorage.removeItem("curator-target-module");
    const timer = window.setTimeout(() => { setModuleId(targetModuleId); }, 0);
    return () => window.clearTimeout(timer);
  }, [moduleOptions, course?.scheduleEvents]);

  const createMedia = async (event: FormEvent<HTMLFormElement>, publishAfterCreate = false) => {
    event.preventDefault();
    setNotice("");
    setSaving(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(isGlobalMedia ? {} : { moduleId: moduleId || undefined, scheduleEventId: scheduleEventId || undefined, groupId: groupId || undefined }), title, kind, audience, vimeoUrl }),
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
      setGroupId("");
       setNotice(publishAfterCreate ? (isGlobalMedia ? "Talks-запись опубликована в общей медиатеке." : scheduleEventId ? "Запись опубликована и привязана к выбранному событию." : groupTitle ? `Стрим опубликован в блок «${groupTitle}».` : "Стрим опубликован и добавлен в выбранный урок.") : "Черновик создан. Проверь запись и опубликуй её, когда она готова для учеников.");
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
      setNotice("Запись опубликована. Она появится у учеников с доступом к этому уроку.");
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

  const openRename = () => {
    if (!selected) return;
    setRenameTitle(selected.title ?? "");
    setRenaming(true);
  };

  const renameSelected = async () => {
    if (!selected) return;
    const nextTitle = renameTitle.trim();
    if (!nextTitle) return;
    setNotice(""); setSaving(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/course/media/${selected.id}/title`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: nextTitle }) });
      const payload = await response.json().catch(() => ({})) as { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось переименовать запись.");
      setRenaming(false);
      await loadCourse();
      setNotice("Название обновлено.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось переименовать запись.");
    } finally {
      setSaving(false);
    }
  };

  const openReclassify = () => {
    if (!selected) return;
    setReclassifyKind(selected.kind);
    // Repairs drift for a record that landed in an Advanced module before this sync existed
    // (audience left "ALL") — opening "Изменить тип" is the next time anything touches this
    // record, so it's corrected here rather than waiting on the curator to notice and flip it.
    setReclassifyAudience(moduleOptions.find((module) => module.id === selected.moduleId)?.section === "Advanced" ? "ADVANCED" : selected.audience);
    setReclassifyModuleId(selected.moduleId ?? "");
    setReclassifyScheduleEventId(selected.scheduleEventId ?? "");
    setReclassifyGroupId(selected.groupId ?? "");
    setAddingReclassifyGroup(false); setNewReclassifyGroupPreset(""); setNewReclassifyGroupCustom("");
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
          audience: reclassifyAudience,
          moduleId: isTalks ? undefined : (reclassifyScheduleEventId ? undefined : reclassifyModuleId || undefined),
          scheduleEventId: isTalks ? undefined : (reclassifyScheduleEventId || undefined),
          groupId: isTalks || reclassifyScheduleEventId ? undefined : (reclassifyGroupId || undefined),
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
    const confirmMessage = selected.provider === "LIVEKIT_RECORDING"
      ? `Удалить запись «${title}»? Видеофайл будет безвозвратно стёрт с сервера и освободит место — отменить это будет нельзя.`
      : `Убрать запись «${title}» из урока и медиатеки? Само видео Vimeo удалено не будет.`;
    if (!window.confirm(confirmMessage)) return;
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
       <div className="section-heading"><div><span className="section-kicker">НОВАЯ ЗАПИСЬ</span><h2>Добавить запись в медиатеку</h2><p className="section-heading-note">Тип Q&A попадёт только в блок «Q&A с куратором», тематический стрим — в центральный блок урока. Урок и событие — это варианты «или-или»: запись привязывается к чему-то одному, выбор одного поля сбрасывает другое.</p></div></div>
      <form className="media-editor-body" onSubmit={(event) => { const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; void createMedia(event, submitter?.dataset.publish === "true"); }}>
        <div className="media-editor-fields">
          <label className="form-field"><span>{isGlobalMedia ? "Привязка" : "Привязать к уроку"}</span><select value={isGlobalMedia ? "" : moduleId} onChange={(event) => { setModuleId(event.target.value); setGroupId(""); setAddingGroup(false); setNewGroupPreset(""); setNewGroupCustom(""); setAudience(moduleOptions.find((module) => module.id === event.target.value)?.section === "Advanced" ? "ADVANCED" : "ALL"); if (event.target.value) setScheduleEventId(""); }} disabled={isGlobalMedia || loading || moduleOptions.length === 0}><option value="">{isGlobalMedia ? "Без привязки · общая медиатека" : "Выбери урок"}</option><optgroup label="Теория">{theoryModuleOptions.map((module) => <option key={module.id} value={module.id}>{module.label}</option>)}</optgroup>{practiceModuleOptions.length > 0 && <optgroup label="Практика">{practiceModuleOptions.map((module) => <option key={module.id} value={module.id}>{module.label}</option>)}</optgroup>}{advancedModuleOptions.length > 0 && <optgroup label="Advanced">{advancedModuleOptions.map((module) => <option key={module.id} value={module.id}>{module.label}</option>)}</optgroup>}</select></label>
          {isBlockLayoutModule && <div className="form-field">
            <span>Блок (необязательно)</span>
            {addingGroup ? <div className="media-group-inline-create">
              <select value={newGroupPreset} onChange={(event) => setNewGroupPreset(event.target.value)}>
                <option value="">Выбери название блока</option>
                {mediaGroupPresets.map((preset) => <option value={preset} key={preset}>{preset}</option>)}
                <option value="__custom__">Своё название…</option>
              </select>
              {newGroupPreset === "__custom__" && <input value={newGroupCustom} onChange={(event) => setNewGroupCustom(event.target.value)} placeholder="Например, Разбор недели 3" maxLength={80} autoFocus />}
              <div className="media-group-inline-actions">
                <button type="button" className="secondary-button compact-button" onClick={() => { setAddingGroup(false); setNewGroupPreset(""); setNewGroupCustom(""); }}>Отмена</button>
                <button type="button" className="primary-button compact-button" disabled={savingGroup || !(newGroupPreset === "__custom__" ? newGroupCustom.trim() : newGroupPreset)} onClick={() => void createGroupForNewMedia()}>{savingGroup ? "Создаём…" : "Создать блок"}</button>
              </div>
            </div> : <select value={groupId} onChange={(event) => { if (event.target.value === "__new__") setAddingGroup(true); else setGroupId(event.target.value); }}>
              <option value="">Без блока — в общие материалы урока</option>
              {moduleGroups.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}
              <option value="__new__">+ Создать новый блок</option>
            </select>}
            <p className="media-link-note">{groupTitle ? `Запись попадёт в блок «${groupTitle}».` : "Нужен, только если хочешь разбить урок на несколько тем — по умолчанию запись видна прямо в уроке."}</p>
          </div>}
          <label className="form-field"><span>Привязать к событию (вместо урока, необязательно)</span><select value={scheduleEventId} onChange={(event) => { setScheduleEventId(event.target.value); if (event.target.value) setModuleId(""); }} disabled={isGlobalMedia || loading}><option value="">Без события</option>{course?.scheduleEvents.map((event) => <option key={event.id} value={event.id}>{event.date} · {event.title}</option>)}</select></label>
          <label className="form-field"><span>Тип</span><select value={kind} onChange={(event) => { const nextKind = event.target.value as CuratorMediaItem["kind"]; setKind(nextKind); if (nextKind !== "TALKS" && !moduleId) setModuleId(moduleOptions[0]?.id ?? ""); }}><option value="STREAM">Стрим</option><option value="QA">Q&A</option><option value="BREAKDOWN">Разбор</option><option value="LESSON_VIDEO">Урок</option></select></label>
          <div className="form-field media-audience-field"><span>Аудитория</span>{selectedModuleIsAdvanced ? <div className="media-audience-locked"><ShieldCheck size={15} /> Урок Advanced — доступ и так только у Advanced-учеников</div> : <button type="button" className={`media-audience-switch ${audience === "ADVANCED" ? "on" : ""}`} role="switch" aria-checked={audience === "ADVANCED"} onClick={() => setAudience(audience === "ADVANCED" ? "ALL" : "ADVANCED")}><span className="media-audience-switch-track"><span className="media-audience-switch-knob" /></span>Только Advanced-ученикам</button>}</div>
          <label className="form-field"><span>Название</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Q&A по Market Logic · 05.06" /></label>
          <label className="form-field"><span>Ссылка Vimeo</span><input type="url" value={vimeoUrl} onChange={(event) => setVimeoUrl(event.target.value)} placeholder="https://vimeo.com/123456789" /></label>{normalizeVimeoUrl(vimeoUrl) && <div className="media-link-live-preview"><span>Предпросмотр новой записи</span><iframe src={normalizeVimeoUrl(vimeoUrl) ?? undefined} title="Предпросмотр Vimeo" allow="autoplay; fullscreen; picture-in-picture" /> </div>}
        </div>
         <div className="media-form-actions"><button className="secondary-button" type="submit" disabled={saving || (!isGlobalMedia && !moduleId && !scheduleEventId) || !title.trim() || !vimeoUrl.trim()}>Сохранить черновик</button><button className="primary-button" type="submit" data-publish="true" disabled={saving || (!isGlobalMedia && !moduleId && !scheduleEventId) || !title.trim() || !vimeoUrl.trim()}>{isGlobalMedia ? "Опубликовать в медиатеку" : scheduleEventId ? "Опубликовать к событию" : `Опубликовать в ${mediaDestinationLabel}`} <ChevronRight size={16} /></button>{notice && <span className="form-action-feedback"><Target size={16} /> {notice}</span>}</div>
      </form>
    </section>
    <button className="secondary-button" type="button" onClick={() => setLibraryOpen((current) => !current)}>{libraryOpen ? "Скрыть все записи потока" : `Показать все записи потока (${displayedItems.length})`}</button>
    {libraryOpen && <section className="content-panel media-library-inline">
      <div className="media-library-sort-toggle" role="group" aria-label="Сортировка медиатеки">
        <button type="button" className={librarySortMode === "newest" ? "active" : ""} onClick={() => setLibrarySortMode("newest")}>Сначала новые</button>
        <button type="button" className={librarySortMode === "manual" ? "active" : ""} onClick={() => setLibrarySortMode("manual")}>Ручной порядок</button>
        {librarySortMode === "manual" && <span className="media-library-sort-hint">{reorderingLibrary ? "Сохраняем…" : "Перетащи карточку, чтобы изменить порядок"}</span>}
      </div>
      {displayedItems.length === 0
        ? <p className="media-link-note">Записей пока нет.</p>
        : <div className="stream-grid">{displayedItems.map((item) => (
          <div
            key={item.id}
            className="media-library-drag-item"
            draggable={librarySortMode === "manual"}
            onDragStart={() => setDraggedLibraryId(item.id)}
            onDragEnd={() => setDraggedLibraryId(null)}
            onDragOver={(event) => librarySortMode === "manual" && event.preventDefault()}
            onDrop={() => moveLibraryItem(item.id)}
          >
            <CuratorMediaCard item={item} onOpen={() => { setSelectedId(item.id); setReclassifying(false); setRenaming(false); }} />
          </div>
        ))}</div>}
    </section>}
    {/* A second, focused popup for whichever card was opened — matches the student "Записи" flow
        (grid page + a separate video-modal popup) instead of expanding in place inside the grid,
        which meant scrolling past other cards to reach the action buttons. */}
    {selected && <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Запись: ${selected.title ?? "Без названия"}`} onMouseDown={(event) => { if (event.currentTarget === event.target) { setSelectedId(""); setReclassifying(false); setRenaming(false); } }}>
      <div className="video-modal">
        <div className="video-modal-head"><div><span className="section-kicker">{(selected.eventTitle ? `Событие · ${selected.eventTitle}` : selected.moduleTitle)} · {mediaKindLabel(selected.kind)}{formatFileSize(selected.byteSize) && ` · ${formatFileSize(selected.byteSize)}`}</span><strong>{selected.title ?? "Без названия"}</strong></div><button className="icon-button" aria-label="Закрыть" onClick={() => { setSelectedId(""); setReclassifying(false); setRenaming(false); }}><X size={18} /></button></div>
        {selected.embedUrl ? <TrackedVideo mediaId={selected.id} src={selected.embedUrl} title={selected.title ?? "Запись"} /> : <div className="stream-player-unavailable"><Play size={22} /><span>Видео для этой записи ещё не подключено.</span></div>}
        <div className="video-modal-foot media-preview-actions"><button className="secondary-button" type="button" disabled={saving || deletingId !== ""} onClick={() => { if (renaming) { setRenaming(false); return; } setReclassifying(false); openRename(); }}>{renaming ? "Отменить переименование" : "Переименовать"}</button><button className="secondary-button" type="button" disabled={saving || deletingId !== ""} onClick={() => { if (reclassifying) { setReclassifying(false); return; } setRenaming(false); openReclassify(); }}>{reclassifying ? "Отменить изменение типа" : "Изменить тип"}</button>{selected.status === "PUBLISHED" && <button className="secondary-button" type="button" onClick={() => void loadViewers(selected.id)}><Eye size={15} /> {viewersFor === selected.id ? "Скрыть просмотры" : "Кто смотрел"}</button>}{selected.provider === "LIVEKIT_RECORDING" && <a className="secondary-button" href={`/api/streams/recordings/${selected.id}/download`} target="_blank" rel="noopener noreferrer"><Download size={15} /> Скачать</a>}<button className="secondary-button danger-button" type="button" disabled={saving || deletingId === selected.id} onClick={() => void archiveSelected()}>{deletingId === selected.id ? "Удаляем…" : "Удалить запись"}</button><button className="primary-button" type="button" disabled={saving || deletingId !== "" || selected.status === "PUBLISHED"} onClick={() => void publishMedia()}>{selected.status === "PUBLISHED" ? "Опубликовано" : "Опубликовать"} <ChevronRight size={16} /></button></div>
        {renaming && <div className="media-viewers-panel media-reclassify-panel"><p className="media-link-note">Меняет только отображаемое название этой записи.</p><div className="media-editor-fields"><label className="form-field"><span>Название</span><input value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} placeholder="Например, Q&A по Market Logic · 05.06" maxLength={180} /></label></div><div className="media-form-actions"><button className="primary-button" type="button" disabled={saving || !renameTitle.trim()} onClick={() => void renameSelected()}>Сохранить название</button></div></div>}
        {reclassifying && <div className="media-viewers-panel media-reclassify-panel"><p className="media-link-note">Меняет тип и привязку этой же записи — новая копия не создаётся. Урок и событие — варианты «или-или», выбор одного сбрасывает другое.</p><div className="media-editor-fields"><label className="form-field"><span>Тип</span><select value={reclassifyKind} onChange={(event) => { const nextKind = event.target.value as CuratorMediaItem["kind"]; setReclassifyKind(nextKind); if (nextKind !== "TALKS" && !reclassifyModuleId && !reclassifyScheduleEventId) setReclassifyModuleId(moduleOptions[0]?.id ?? ""); }}><option value="STREAM">Стрим</option><option value="QA">Q&A</option><option value="BREAKDOWN">Разбор</option><option value="LESSON_VIDEO">Урок</option></select></label><div className="form-field media-audience-field"><span>Аудитория</span>{reclassifySelectedModuleIsAdvanced ? <div className="media-audience-locked"><ShieldCheck size={15} /> Урок Advanced — доступ и так только у Advanced-учеников</div> : <button type="button" className={`media-audience-switch ${reclassifyAudience === "ADVANCED" ? "on" : ""}`} role="switch" aria-checked={reclassifyAudience === "ADVANCED"} onClick={() => setReclassifyAudience(reclassifyAudience === "ADVANCED" ? "ALL" : "ADVANCED")}><span className="media-audience-switch-track"><span className="media-audience-switch-knob" /></span>Только Advanced-ученикам</button>}</div>{reclassifyKind !== "TALKS" && <><label className="form-field"><span>Привязать к уроку</span><select value={reclassifyModuleId} onChange={(event) => { setReclassifyModuleId(event.target.value); setReclassifyGroupId(""); setAddingReclassifyGroup(false); setNewReclassifyGroupPreset(""); setNewReclassifyGroupCustom(""); setReclassifyAudience(moduleOptions.find((module) => module.id === event.target.value)?.section === "Advanced" ? "ADVANCED" : "ALL"); if (event.target.value) setReclassifyScheduleEventId(""); }}><option value="">Выбери урок</option><optgroup label="Теория">{theoryModuleOptions.map((module) => <option key={module.id} value={module.id}>{module.label}</option>)}</optgroup>{practiceModuleOptions.length > 0 && <optgroup label="Практика">{practiceModuleOptions.map((module) => <option key={module.id} value={module.id}>{module.label}</option>)}</optgroup>}{advancedModuleOptions.length > 0 && <optgroup label="Advanced">{advancedModuleOptions.map((module) => <option key={module.id} value={module.id}>{module.label}</option>)}</optgroup>}</select></label>
        {isBlockLayoutReclassifyModule && <div className="form-field">
          <span>Блок (необязательно)</span>
          {addingReclassifyGroup ? <div className="media-group-inline-create">
            <select value={newReclassifyGroupPreset} onChange={(event) => setNewReclassifyGroupPreset(event.target.value)}>
              <option value="">Выбери название блока</option>
              {mediaGroupPresets.map((preset) => <option value={preset} key={preset}>{preset}</option>)}
              <option value="__custom__">Своё название…</option>
            </select>
            {newReclassifyGroupPreset === "__custom__" && <input value={newReclassifyGroupCustom} onChange={(event) => setNewReclassifyGroupCustom(event.target.value)} placeholder="Например, Разбор недели 3" maxLength={80} autoFocus />}
            <div className="media-group-inline-actions">
              <button type="button" className="secondary-button compact-button" onClick={() => { setAddingReclassifyGroup(false); setNewReclassifyGroupPreset(""); setNewReclassifyGroupCustom(""); }}>Отмена</button>
              <button type="button" className="primary-button compact-button" disabled={savingReclassifyGroup || !(newReclassifyGroupPreset === "__custom__" ? newReclassifyGroupCustom.trim() : newReclassifyGroupPreset)} onClick={() => void createGroupForReclassify()}>{savingReclassifyGroup ? "Создаём…" : "Создать блок"}</button>
            </div>
          </div> : <select value={reclassifyGroupId} onChange={(event) => { if (event.target.value === "__new__") setAddingReclassifyGroup(true); else setReclassifyGroupId(event.target.value); }}>
            <option value="">Без блока — в общие материалы урока</option>
            {reclassifyModuleGroups.map((group) => <option key={group.id} value={group.id}>{group.title}</option>)}
            <option value="__new__">+ Создать новый блок</option>
          </select>}
          <p className="media-link-note">Нужен, только если хочешь разбить урок на несколько тем — по умолчанию запись видна прямо в уроке.</p>
        </div>}
        <label className="form-field"><span>Привязать к событию (вместо урока, необязательно)</span><select value={reclassifyScheduleEventId} onChange={(event) => { setReclassifyScheduleEventId(event.target.value); if (event.target.value) setReclassifyModuleId(""); }}><option value="">Без события</option>{course?.scheduleEvents.map((event) => <option key={event.id} value={event.id}>{event.date} · {event.title}</option>)}</select></label></>}</div><div className="media-form-actions"><button className="primary-button" type="button" disabled={saving || (reclassifyKind !== "TALKS" && !reclassifyModuleId && !reclassifyScheduleEventId)} onClick={() => void saveReclassify()}>Сохранить тип</button></div></div>}
        {viewersFor === selected.id && <div className="media-viewers-panel">{viewersLoading ? <span className="media-viewers-empty">Загружаем…</span> : viewers.length === 0 ? <span className="media-viewers-empty">Пока никто не открывал эту запись.</span> : viewers.map((event) => <div className="media-viewers-row" key={event.id}><strong>{event.viewer.name}</strong><span>{event.viewer.role === "STUDENT" ? "Ученик" : event.viewer.role === "CURATOR" ? "Куратор" : "Владелец"}</span><span>{event.ipAddress ?? "IP не определён"}</span><span>{new Date(event.createdAt).toLocaleString("ru-RU")}</span></div>)}</div>}
      </div>
    </div>}
  </div>;
}

/** One card in the curator's "all recordings" grid (mirroring the student "Записи" page) — opens the shared video-modal popup above rather than expanding in place. */
function CuratorMediaCard({ item, onOpen }: { item: CuratorMediaItem; onOpen: () => void }) {
  return <article className="stream-card"><button className="stream-card-button" type="button" onClick={onOpen}>
    <div className={`stream-preview ${item.thumbnailUrl ? "has-cover" : ""}`}>
      {item.thumbnailUrl ? <div className="stream-cover" role="img" aria-label={`Обложка: ${item.title ?? "запись"}`} style={{ backgroundImage: `url("${item.thumbnailUrl}")` }} /> : <div className="mini-candles"><i /><i /><i /><i /><i /></div>}
      <div className="stream-preview-label">{item.status === "PUBLISHED" ? "ОПУБЛИКОВАНО" : "ЧЕРНОВИК"}</div>
      <span className="play-button" aria-hidden="true"><Play size={17} fill="currentColor" /></span>
      <span className="stream-duration">{formatDuration(item.durationSec)}</span>
    </div>
    <div className="stream-card-copy">
      <span>{item.eventTitle ? `Событие · ${item.eventTitle}` : item.moduleTitle}</span>
      <h3>{item.title ?? "Без названия"}</h3>
      <p>{mediaKindLabel(item.kind)}{formatFileSize(item.byteSize) && ` · ${formatFileSize(item.byteSize)}`}</p>
    </div>
  </button></article>;
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

function ScheduleBookingSettingsPanel() {
  const [backtestSlotLimit, setBacktestSlotLimit] = useState(1);
  const [preSessionSlotLimit, setPreSessionSlotLimit] = useState(1);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/schedule/settings`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { data?: { backtestSlotLimit: number; preSessionSlotLimit: number } } | null) => {
        if (payload?.data) { setBacktestSlotLimit(payload.data.backtestSlotLimit); setPreSessionSlotLimit(payload.data.preSessionSlotLimit); }
      })
      .catch(() => undefined);
  }, []);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/schedule/settings`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backtestSlotLimit, preSessionSlotLimit }),
      });
      const payload = await response.json().catch(() => ({})) as { data?: { backtestSlotLimit: number; preSessionSlotLimit: number }; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить настройки");
      setBacktestSlotLimit(payload.data.backtestSlotLimit);
      setPreSessionSlotLimit(payload.data.preSessionSlotLimit);
      setNotice("Лимиты сохранены.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить настройки");
    } finally {
      setSaving(false);
    }
  };

  return <section className="student-module-access-panel schedule-slot-settings">
    <button className="student-module-access-toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <div className="student-module-access-head"><span className="section-kicker">ЛИМИТЫ ЗАПИСИ</span><strong>Слотов на ученика</strong><span>Бэктест — {backtestSlotLimit}, Пресессия — {preSessionSlotLimit}</span></div>
      <ChevronDown size={16} className={`student-module-access-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
    </button>
    {expanded && <form className="schedule-slot-settings-body" onSubmit={(event) => void save(event)}>
      <div className="form-grid">
        <label className="form-field"><span>Бэктест</span><input type="number" min={0} max={20} value={backtestSlotLimit} onChange={(event) => setBacktestSlotLimit(Number(event.target.value))} /></label>
        <label className="form-field"><span>Пресессия</span><input type="number" min={0} max={20} value={preSessionSlotLimit} onChange={(event) => setPreSessionSlotLimit(Number(event.target.value))} /></label>
      </div>
      <div className="create-actions"><button type="submit" className="primary-button" disabled={saving}><Save size={15} /> {saving ? "Сохраняем…" : "Сохранить"}</button></div>
      {notice && <div className="form-action-feedback">{notice}</div>}
    </form>}
  </section>;
}

function CuratorScheduleView({ onNavigate, viewingPracticumId = null }: { onNavigate: (nextNav: CuratorNav) => void; viewingPracticumId?: string | null }) {
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selectedId, setSelectedId] = useState(events[0]?.id ?? "");
  const [showForm, setShowForm] = useState(false);
  const [editingEvent, setEditingEvent] = useState<ScheduleEvent | null>(null);
  const [formDate, setFormDate] = useState(() => toDateKey(new Date()));
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [scheduleLoadError, setScheduleLoadError] = useState("");
  // Which event the current/next broadcast is attached to ("Начать стрим"), and whether OBS is
  // live right now — drives the event modal's "Начать стрим" / "Завершить эфир" buttons.
  const [streamTargetEventId, setStreamTargetEventId] = useState<string | null>(null);
  const [streamHost, setStreamHost] = useState<StreamHostApiDto>(null);
  const [broadcastLive, setBroadcastLive] = useState(false);
  const [streamActionBusy, setStreamActionBusy] = useState(false);
  const [streamActionError, setStreamActionError] = useState("");
  useEffect(() => {
    if (viewingPracticumId) return;
    let cancelled = false;
    void Promise.all([
      fetch(`${API_ORIGIN}/api/streams/target`, { credentials: "include", cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ data?: StreamTargetApiDto }> : null).catch(() => null),
      fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" }).then((response) => response.ok ? response.json() as Promise<{ data?: PlaybackStatusDto }> : null).catch(() => null),
    ]).then(([target, status]) => {
      if (cancelled) return;
      setStreamTargetEventId(target?.data?.scheduleEventId ?? null);
      setStreamHost(target?.data?.host ?? null);
      setBroadcastLive(Boolean(status?.data?.isLive));
    });
    return () => { cancelled = true; };
  }, [viewingPracticumId]);
  useEffect(() => {
    const load = async () => {
      const url = `${API_ORIGIN}/api/schedule${viewingPracticumId ? `?viewPracticumId=${viewingPracticumId}` : ""}`;
      const response = await fetch(url, { credentials: "include", cache: "no-store" });
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
  }, [viewingPracticumId]);

  // Consumed once when the curator clicks a schedule row on "Кабинет куратора" — opens
  // that event's details directly instead of landing on the first event in the list.
  useEffect(() => {
    const targetEventId = window.sessionStorage.getItem("curator-target-schedule-event");
    if (!targetEventId) return;
    const target = events.find((event) => event.id === targetEventId);
    if (!target) return;
    window.sessionStorage.removeItem("curator-target-schedule-event");
    const timer = window.setTimeout(() => { setSelectedId(target.id); setDetailsId(target.id); }, 0);
    return () => window.clearTimeout(timer);
  }, [events]);

  const selectedEvent = events.find((event) => event.id === selectedId) ?? events[0];
  const detailsEvent = events.find((event) => event.id === detailsId);
  // "События и записи" is the quick-glance "what's coming up" panel — same reasoning as
  // ScheduleView#visibleEvents on the student side (a past day's own history stays fully
  // browsable in the calendar grid to the left, which still shows every event regardless).
  const upcomingEvents = events.filter((event) => event.date >= toDateKey(new Date()));
  const openCreateForDate = (date: string) => {
    const existing = events.find((event) => event.date === date);
    if (existing) { setSelectedId(existing.id); setDetailsId(existing.id); setPendingDate(null); return; }
    if (viewingPracticumId) return; // read-only archive view — nothing to create on an empty date
    setFormDate(date); setEditingEvent(null); setShowForm(false); setPendingDate(date);
  };
  const confirmCreateForDate = () => { if (!pendingDate) return; setFormDate(pendingDate); setEditingEvent(null); setPendingDate(null); setShowForm(true); };
  const openEvent = (event: ScheduleEvent) => { setSelectedId(event.id); setDetailsId(event.id); setPendingDate(null); setShowForm(false); };
  const openEdit = (event: ScheduleEvent) => { setEditingEvent(event); setFormDate(event.date); setDetailsId(null); setPendingDate(null); setShowForm(true); };
  const removeEvent = () => { if (!selectedEvent || !window.confirm(`Удалить событие «${selectedEvent.title}»?`)) return; void fetch(`${API_ORIGIN}/api/schedule/${selectedEvent.id}`, { method: "DELETE", credentials: "include" }).catch(() => undefined); setEvents((current) => current.filter((event) => event.id !== selectedEvent.id)); setSelectedId(events.find((event) => event.id !== selectedEvent.id)?.id ?? ""); setDetailsId(null); };
  const saveEvent = async (event: ScheduleEvent) => {
    // The form shows/takes time in the curator's own zone; storage is Kyiv.
    const stored = viewerTimeZone ? convertToKyivTime(event.date, event.time, viewerTimeZone) ?? { date: event.date, time: event.time } : { date: event.date, time: event.time };
    const body = { type: scheduleUiTypeToApi(event.type), title: event.title, date: stored.date, time: stored.time, description: event.description, live: event.live, coverPath: event.coverPath, coverFileId: event.coverFileId };
    const isPersisted = !event.id.startsWith("event-");
    const response = await fetch(`${API_ORIGIN}/api/schedule${isPersisted ? `/${event.id}` : ""}`, { method: isPersisted ? "PUT" : "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => ({})) as { data?: ScheduleApiEvent; message?: string };
    if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить событие");
    const saved = scheduleApiToUi(payload.data);
    setEvents((current) => isPersisted ? current.map((item) => item.id === event.id ? saved : item) : [...current, saved]);
    setSelectedId(saved.id); setShowForm(false); setEditingEvent(null); setDetailsId(null);
  };
  /** "Начать стрим": attach the broadcast to this event (no manual pick on "Стримы") and go there for OBS. */
  const startStream = async (event: ScheduleEvent) => {
    // Someone else already started (or is about to start) a broadcast — all curators share one OBS
    // key, so make sure this is a deliberate handover, not two people going live at once.
    if (streamHost && !streamHost.isMe) {
      const current = events.find((item) => item.id === streamTargetEventId);
      const what = current ? ` «${current.title}»` : "";
      const question = broadcastLive
        ? `Сейчас эфир${what} ведёт ${streamHost.name} (с ${formatHostTime(streamHost.startedAt)}).\n\nНе запускайте OBS, пока он не закончит — у всех один ключ, эфир переключится на вас. Всё равно привязать эфир к «${event.title}» от вашего имени?`
        : `${streamHost.name} уже нажал «Начать стрим»${what} в ${formatHostTime(streamHost.startedAt)}.\n\nПерехватить эфир и привязать его к «${event.title}» от вашего имени?`;
      if (!window.confirm(question)) return;
    } else if (streamTargetEventId && streamTargetEventId !== event.id && broadcastLive) {
      const current = events.find((item) => item.id === streamTargetEventId);
      if (!window.confirm(`Сейчас идёт эфир${current ? ` «${current.title}»` : ""}. Переключить его на «${event.title}»?`)) return;
    }
    setStreamActionBusy(true); setStreamActionError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/target`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduleEventId: event.id }) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось привязать эфир к событию");
      }
      const saved = await response.json().catch(() => ({})) as { data?: StreamTargetApiDto };
      setStreamTargetEventId(event.id);
      setStreamHost(saved.data?.host ?? null);
      setEvents((current) => current.map((item) => item.id === event.id ? { ...item, streamEndedAt: null } : item));
      setDetailsId(null);
      onNavigate("Стримы");
    } catch (error) {
      setStreamActionError(error instanceof Error ? error.message : "Не удалось привязать эфир к событию");
    } finally {
      setStreamActionBusy(false);
    }
  };
  /** "Завершить эфир": mark the event finished for students and detach the broadcast from it. */
  const finishStream = async (event: ScheduleEvent) => {
    if (!window.confirm(`Завершить эфир «${event.title}»?\n\nУ учеников событие будет отмечено как завершённое. Трансляцию в OBS остановите отдельно (кнопка «Остановить трансляцию»).`)) return;
    setStreamActionBusy(true); setStreamActionError("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/target/finish`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduleEventId: event.id }) });
      const payload = await response.json().catch(() => ({})) as { data?: StreamTargetApiDto; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось завершить эфир");
      setStreamTargetEventId(payload.data?.scheduleEventId ?? null);
      setStreamHost(payload.data?.host ?? null);
      setEvents((current) => current.map((item) => item.id === event.id ? { ...item, streamEndedAt: new Date().toISOString() } : item));
    } catch (error) {
      setStreamActionError(error instanceof Error ? error.message : "Не удалось завершить эфир");
    } finally {
      setStreamActionBusy(false);
    }
  };
  const releaseBooking = async (eventId: string) => {
    const response = await fetch(`${API_ORIGIN}/api/schedule/${eventId}/cancel-booking`, { method: "POST", credentials: "include" });
    const payload = await response.json().catch(() => ({})) as { data?: ScheduleApiEvent; message?: string };
    if (!response.ok || !payload.data) return;
    const updated = scheduleApiToUi(payload.data);
    setEvents((current) => current.map((item) => item.id === updated.id ? updated : item));
  };

  return <div className="curator-schedule">{scheduleLoadError && <div className="file-error" role="alert">{scheduleLoadError}</div>}<div className="curator-schedule-toolbar"><div><span className="section-kicker">РАСПИСАНИЕ ПОТОКА</span><strong>{events.length} событий опубликовано</strong><span>События видят ученики этого потока после публикации.</span></div><div className="schedule-toolbar-actions">{!viewingPracticumId && <button className="primary-button" onClick={() => { setEditingEvent(null); setPendingDate(null); setDetailsId(null); setFormDate(toDateKey(new Date())); setShowForm((current) => !current); }}><Plus size={16} /> {showForm ? "Закрыть форму" : "Создать событие"}</button>}<span className="schedule-toolbar-divider" aria-hidden="true" /><button className="secondary-button" disabled={!selectedEvent} onClick={() => selectedEvent && openEdit(selectedEvent)}><Pencil size={15} /> Редактировать</button><button className="secondary-button danger-button" disabled={!selectedEvent} onClick={removeEvent}><Trash2 size={15} /> Удалить</button></div></div><ScheduleBookingSettingsPanel />{pendingDate && <div className="schedule-date-confirm"><div><strong>Добавить событие на {formatEventDate(pendingDate)}?</strong><span>Дата уже выбрана. Подтверди действие, и откроется форма с деталями.</span></div><div><button className="secondary-button" type="button" onClick={() => setPendingDate(null)}>Нет</button><button className="primary-button" type="button" onClick={confirmCreateForDate}>Да, добавить</button></div></div>}{showForm && <ScheduleEventForm initialDate={formDate} initialEvent={editingEvent} onCancel={() => { setShowForm(false); setEditingEvent(null); }} onCreate={(event) => { void saveEvent(event).catch(() => undefined); }} />}<div className="calendar-layout"><section className="content-panel calendar-panel"><CalendarGrid events={events} selectedId={selectedEvent?.id ?? ""} onSelect={(eventId) => { const event = events.find((item) => item.id === eventId); if (event) openEvent(event); }} onDateSelect={openCreateForDate} /></section><section className="content-panel calendar-events"><div className="section-heading"><div><span className="section-kicker">ПЛАН ПОТОКА</span><h2>События и записи</h2></div><CalendarDays size={18} className="heading-icon" /></div>{upcomingEvents.length === 0 ? <div className="empty-state"><CalendarDays size={22} /><strong>Ближайших событий нет</strong><span>Кликни по дате в календаре или нажми «Создать событие».</span></div> : upcomingEvents.map((event) => <ScheduleEventCard event={event} selected={event.id === selectedEvent?.id} mode="curator" onOpen={() => openEvent(event)} key={event.id} />)}</section></div>{detailsEvent && <CuratorScheduleEventDetails event={detailsEvent} streamControls={viewingPracticumId ? null : { isTarget: streamTargetEventId === detailsEvent.id, host: streamHost, broadcastLive, busy: streamActionBusy, error: streamActionError, onStart: () => void startStream(detailsEvent), onFinish: () => void finishStream(detailsEvent), onOpenStreams: () => { setDetailsId(null); onNavigate("Стримы"); } }} onEdit={() => openEdit(detailsEvent)} onDelete={removeEvent} onClose={() => setDetailsId(null)} onAddRecording={() => { window.sessionStorage.setItem("curator-target-event", detailsEvent.id); onNavigate("Медиатека"); }} onReleaseBooking={() => void releaseBooking(detailsEvent.id)} />}</div>;
}

type CuratorStreamControls = { isTarget: boolean; host: StreamHostApiDto; broadcastLive: boolean; busy: boolean; error: string; onStart: () => void; onFinish: () => void; onOpenStreams: () => void };

function CuratorScheduleEventDetails({ event, streamControls, onEdit, onDelete, onClose, onAddRecording, onReleaseBooking }: { event: ScheduleEvent; streamControls: CuratorStreamControls | null; onEdit: () => void; onDelete: () => void; onClose: () => void; onAddRecording: () => void; onReleaseBooking: () => void }) {
  const coverPath = eventCoverPath(event);
  const isBookable = isBookableSlotType(event.type);
  // Individual slots (Бэктест/Пресессия) are 1:1 calls, not broadcasts — no stream controls there.
  const stream = isBookable ? null : streamControls;
  const endedAtLabel = event.streamEndedAt ? new Date(event.streamEndedAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : null;
  return <div className="event-details-overlay" role="presentation" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}><section className="event-details-modal rich-event-modal curator-event-details" role="dialog" aria-modal="true" aria-labelledby="curator-schedule-event-title"><div className="rich-event-topbar"><h2 id="curator-schedule-event-title">{event.title}</h2><button className="icon-button compact" aria-label="Закрыть детали события" onClick={onClose}><X size={20} /></button></div>{coverPath && <div className="rich-event-cover" role="img" aria-label={`Обложка события: ${event.title}`} style={{ backgroundImage: `url("${coverPath}")` }} />}<div className="rich-event-tabs"><span className="active">Сведения о событии</span><span>{event.type}</span></div><div className="rich-event-body"><div className="rich-event-date"><Clock3 size={17} /><strong>{event.weekday} · {event.time}</strong>{event.kyivTimeLabel && <span className="event-kyiv-time">по Киеву {event.kyivTimeLabel}</span>}</div><h3>{event.title}</h3><div className="rich-event-line"><CalendarDays size={16} /><span>{formatEventDate(event.date)}</span></div><div className="rich-event-description">{event.description}</div>{isBookable && <div className="event-recording-note"><Target size={16} /><div><strong>{event.bookedByStudentName ? `Записан: ${event.bookedByStudentName}` : "Слот пока свободен"}</strong><span>{event.bookedByStudentName ? "Индивидуальный слот занят этим учеником." : "Ученик сможет записаться на этот слот из своего расписания."}</span></div></div>}{event.recordingAvailable && <div className="event-recording-note"><Play size={16} /><div><strong>Запись уже добавлена</strong><span>Ученики увидят её в разделе «Стримы».</span></div></div>}{stream?.isTarget && <div className="event-recording-note event-stream-note"><Radio size={16} /><div><strong>{stream.broadcastLive ? "Эфир идёт и привязан к этому событию" : "Эфир привязан к этому событию"}{stream.host ? ` · ведёт ${stream.host.name}${stream.host.isMe ? " (вы)" : ""}, с ${formatHostTime(stream.host.startedAt)}` : ""}</strong><span>{stream.broadcastLive ? "У учеников в расписании работает «Присоединиться». Когда закончите — нажмите «Завершить эфир» и остановите трансляцию в OBS." : "Запустите трансляцию в OBS — ключ на странице «Стримы». Ученики смогут присоединиться прямо из расписания."}</span></div></div>}{stream && !stream.isTarget && endedAtLabel && <div className="event-recording-note"><CheckCircle2 size={16} /><div><strong>Эфир завершён · {endedAtLabel}</strong><span>{event.recordingAvailable ? "Запись опубликована." : "Запись эфира появится в «Медиатеке» черновиком у этого события — проверьте и опубликуйте."}</span></div></div>}{stream?.error && <div className="file-error" role="alert">{stream.error}</div>}</div><div className="rich-event-footer"><button className="secondary-button danger-button" onClick={onDelete}>Удалить</button><button className="secondary-button" onClick={onEdit}>Редактировать</button>{isBookable && event.bookedByStudentName && <button className="secondary-button" onClick={onReleaseBooking}>Освободить слот</button>}{!event.recordingAvailable && <button className="secondary-button" onClick={onAddRecording}><Plus size={15} /> Добавить запись Vimeo</button>}{stream?.isTarget && <button className="secondary-button" onClick={stream.onOpenStreams}>Открыть «Стримы»</button>}{stream?.isTarget ? <button className="primary-button stream-finish-button" onClick={stream.onFinish} disabled={stream.busy}>{stream.busy ? "Завершаем…" : "Завершить эфир"}</button> : stream ? <button className="primary-button" onClick={stream.onStart} disabled={stream.busy}><Radio size={15} /> {stream.busy ? "Привязываем…" : event.streamEndedAt ? "Начать стрим заново" : "Начать стрим"}</button> : <button className="primary-button" onClick={onClose}>Закрыть</button>}</div></section></div>;
}

/** Interpreted as Kyiv time regardless of the viewer's own timezone — see schedule-time.ts. */
function eventStartDate(event: ScheduleEvent): Date {
  const startTime = (event.kyivTime ?? event.time).split(/\s*[—–-]\s*/)[0]?.trim() || "00:00";
  return zonedTimeToUtc(event.kyivDate ?? event.date, startTime);
}

/** "13:00 — 14:00" → 14:00 that day (Kyiv); a single time counts as a 2-hour slot. */
function eventEndDate(event: ScheduleEvent): Date {
  const endTime = (event.kyivTime ?? event.time).split(/\s*[—–-]\s*/)[1]?.trim();
  return endTime && /^\d{1,2}:\d{2}$/.test(endTime) ? zonedTimeToUtc(event.kyivDate ?? event.date, endTime) : new Date(eventStartDate(event).getTime() + 2 * 60 * 60_000);
}

/**
 * Where a (non-bookable) event's broadcast stands for a student's schedule: live right now
 * (the curator started it from this event), ended via "Завершить эфир", or simply past its
 * scheduled end — so a student who missed it sees it's over instead of "Эфир ещё не начался".
 */
function eventBroadcastPhase(event: ScheduleEvent, liveNow: boolean): "live" | "ended" | "past" | "upcoming" {
  if (liveNow) return "live";
  if (event.streamEndedAt) return "ended";
  if (Date.now() > eventEndDate(event).getTime()) return "past";
  return "upcoming";
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

type IngressDto = { ingressId: string; rtmpUrl: string | null; rtmpStreamKey: string | null; isLive: boolean };
type PlaybackStatusDto = { isLive: boolean; viewerToken: string | null; roomName: string | null; liveScheduleEventId: string | null; recording?: "recording" | "starting" | "off" | null; hasStreamTarget?: boolean | null; host?: StreamHostApiDto };

const REACTION_OPTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;

type StreamChatReaction = { emoji: string; userIds: string[] };
type StreamChatLinkPreview = { title: string; imageUrl: string; siteName: string; sourceUrl: string };
type StreamChatMessage = { id: string; body: string; createdAt: string; authorId: string; authorName: string; authorAvatarUrl: string | null; authorRole: "STUDENT" | "CURATOR" | "OWNER"; authorIsAdvanced?: boolean; attachment: { fileId: string; url: string } | null; linkPreview: StreamChatLinkPreview | null; replyTo: { id: string; authorId?: string; authorName: string; authorRole: "STUDENT" | "CURATOR" | "OWNER"; authorIsAdvanced?: boolean; body: string } | null; reactions: StreamChatReaction[] };
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
    socket.on("chat:delete", ({ messageId }: { messageId: string }) => setMessages((current) => current.filter((message) => message.id !== messageId)));
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

  const deleteMessage = useCallback((messageId: string) => {
    socketRef.current?.emit("chat:delete", { messageId });
  }, []);

  return { messages, connected, chatError, currentUserId, sendMessage, react, deleteMessage };
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
// "смотри https://site.io/x." — the closing punctuation belongs to the sentence, not the link.
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]»"']+$/;

function linkifyText(text: string): ReactNode[] {
  // split() with a capturing group interleaves matches at odd indices — no need to re-test them.
  return text.split(URL_PATTERN).flatMap((part, index) => {
    if (index % 2 === 0) return [part];
    const tail = part.match(URL_TRAILING_PUNCTUATION)?.[0] ?? "";
    const url = tail ? part.slice(0, -tail.length) : part;
    return [<a key={index} className="text-link" href={url} target="_blank" rel="noopener noreferrer">{url}</a>, tail];
  });
}

/**
 * Enter on a "1. текст" line starts the next line with "2. " (asked for by curators 2026-10-04);
 * Enter on an empty "2. " ends the list. Goes through the browser's own text insertion so
 * Ctrl+Z works and React's onChange fires as for normal typing.
 */
function continueNumberedList(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
  const field = event.currentTarget;
  const { selectionStart, selectionEnd, value } = field;
  if (selectionStart !== selectionEnd) return;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const marker = value.slice(lineStart, selectionStart).match(/^(\s*)(\d{1,3})([.)])\s+(.*)$/);
  if (!marker) return;
  event.preventDefault();
  const [, indent, number, separator, rest] = marker;
  if (!rest.trim()) {
    // Empty item — drop its number instead of adding another one.
    // ("insertText" with an empty string leaves Chrome's caret on the line above — use "delete".)
    field.setSelectionRange(lineStart, selectionStart);
    if (!document.execCommand("delete")) insertIntoField(field, "");
    return;
  }
  insertIntoField(field, `\n${indent}${Number(number) + 1}${separator} `);
}

function insertIntoField(field: HTMLTextAreaElement, text: string) {
  if (document.execCommand("insertText", false, text)) return;
  // Fallback for browsers without insertText: change the value natively and let React see an input.
  field.setRangeText(text, field.selectionStart, field.selectionEnd, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

// While an element is in the Fullscreen API's "top layer" (e.g. theater-mode live stream, which
// fullscreens the video+chat wrapper together), anything portaled to document.body renders
// BEHIND it — a lightbox opened from stream chat while fullscreen would look like it never
// opened until Esc is pressed. Portal into the fullscreen element itself when one is active.
function useLightboxPortalTarget(open: boolean): Element | null {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    const update = () => setTarget(document.fullscreenElement ?? document.body);
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, [open]);
  return target;
}

function formatHostTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

/**
 * "Эфир пойдёт в поток: …" on "Стримы", with a warning when that's likely a mistake — a bigger
 * unfinished поток exists (e.g. left on a test поток after testing), or the curator's own working
 * поток (what their "Расписание" shows) is a different one.
 */
function StreamPracticumNote() {
  const [info, setInfo] = useState<StreamPracticumApiDto | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/streams/target`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: StreamTargetApiDto }> : null)
      .then((payload) => { if (!cancelled) setInfo(payload?.data?.practicum ?? null); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);
  if (!info) return null;
  const warnings = [
    info.biggerPracticum && `В потоке «${info.biggerPracticum.title}» ${pluralizeStudents(info.biggerPracticum.students)} — если эфир для них, владелец должен назначить этот поток в «Потоках» → «Назначить для эфиров».`,
    info.workingPracticumTitle && `Ваш рабочий поток — «${info.workingPracticumTitle}» (его вы видите в «Расписании»), а эфир пойдёт в «${info.title}». «Начать стрим» сработает только на событиях потока «${info.title}».`,
  ].filter(Boolean) as string[];
  return <div className={`stream-practicum-note ${warnings.length ? "is-warning" : ""}`} role={warnings.length ? "alert" : "status"}>
    {warnings.length ? <AlertTriangle size={16} /> : <UsersRoundIcon />}
    <div>
      <strong>Эфир пойдёт в поток: {info.title} · {pluralizeStudents(info.students)}</strong>
      {warnings.map((warning) => <span key={warning}>{warning}</span>)}
    </div>
  </div>;
}

/**
 * "Эфир ведёт: Имя" on "Стримы" — all curators share one OBS key, so the platform shows who pressed
 * "Начать стрим" (StreamService#resolveStreamHost); a second curator then knows not to start OBS too.
 */
function StreamHostNote({ status }: { status: PlaybackStatusDto | null }) {
  if (!status?.isLive) return null;
  const host = status.host;
  return <div className={`stream-host-note ${host ? "" : "is-unknown"}`} role="status">
    <Radio size={16} />
    {host
      ? <span><strong>Эфир ведёт: {host.name}{host.isMe ? " (вы)" : ""}</strong> · начат через платформу в {formatHostTime(host.startedAt)}.{host.isMe ? "" : " Не запускайте OBS одновременно — эфир может переключиться на вас."}</span>
      : <span><strong>Эфир идёт, но его запустили без кнопки «Начать стрим»</strong> — платформа не знает, кто ведёт. Уточните в чате кураторов, прежде чем включать OBS.</span>}
  </div>;
}

/**
 * "Is this broadcast being recorded?" — shown to everyone watching (staff on "Стримы", students on
 * "Стрим") since 2026-10-02, so a viewer who sees it's off can tell the curator. Green means OBS is
 * sending and the recording is being written; the server's watchdog restarts a stuck recording on
 * its own within ~30s, this only makes the state visible. Served from the watchdog's cache, so it
 * costs the stream server nothing per viewer — see StreamService#getRecordingState.
 */
function RecordingBadge({ status, audience }: { status: PlaybackStatusDto | null; audience: "staff" | "student" }) {
  if (!status?.isLive || !status.recording) return null;
  const label = status.recording === "recording" ? "● Запись идёт" : status.recording === "starting" ? "Запись запускается…" : audience === "student" ? "Запись не идёт · сообщите куратору" : "Запись не идёт";
  const hint = status.recording === "recording" ? "Всё в порядке: трансляция идёт, видео приходит на сервер и записывается."
    : status.recording === "starting" ? "Запись включается — обычно это занимает до 30 секунд после начала эфира."
    : audience === "student" ? "Эфир идёт, но запись сейчас не ведётся. Пожалуйста, напишите об этом куратору в чат."
    : "Запись эфира сейчас не ведётся — платформа пытается перезапустить её автоматически. Если не появится за минуту, включите запись в OBS.";
  return <span className={`live-room-recording-badge is-${status.recording}`} title={hint} aria-label={`${label}. ${hint}`}>{label}</span>;
}

function ChatMessageRow({ message, currentUserId, showAdvanced = false, onReact, onContextMenu }: { message: StreamChatMessage; currentUserId: string; showAdvanced?: boolean; onReact: (messageId: string, emoji: string) => void; onContextMenu: (event: ReactMouseEvent<HTMLDivElement>, message: StreamChatMessage) => void }) {
  const isStaff = message.authorRole === "CURATOR" || message.authorRole === "OWNER";
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const lightboxPortalTarget = useLightboxPortalTarget(Boolean(lightboxImage));
  useEffect(() => {
    if (!lightboxImage) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setLightboxImage(null); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxImage]);

  const replyIsStaff = message.replyTo?.authorRole === "CURATOR" || message.replyTo?.authorRole === "OWNER";
  // Discord-style: a reply is highlighted only for the person it answers, not for everyone
  // (the old "Ответ ученика" teal highlight lit up every student-to-student reply for all
  // viewers). The quoted original above the text still shows everyone who was answered.
  const isReplyToMe = Boolean(currentUserId) && message.replyTo?.authorId === currentUserId && message.authorId !== currentUserId;
  // Discord-style "jump to message": the quoted reply names the original message's id, so a
  // click just needs to find that row by DOM id (every row in this list carries one) and
  // scroll to it — no server round-trip, the whole chat is already rendered in the list.
  const jumpToMessage = (targetId: string) => {
    const target = document.getElementById(`chat-msg-${targetId}`);
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.remove("is-jump-highlight");
    // Force a reflow so re-adding the class restarts the animation if the same message is
    // jumped to twice in a row.
    void target.offsetWidth;
    target.classList.add("is-jump-highlight");
    window.setTimeout(() => target.classList.remove("is-jump-highlight"), 1400);
  };

  return <div className={`live-room-chat-message ${isStaff ? "is-staff" : ""} ${isReplyToMe ? "is-reply-to-me" : ""}`} id={`chat-msg-${message.id}`} onContextMenu={(event) => onContextMenu(event, message)}>
    <div className="live-room-chat-message-avatar">
      {message.authorAvatarUrl ? <Image className="live-room-chat-avatar-image" src={message.authorAvatarUrl} alt={message.authorName} width={32} height={32} unoptimized /> : <div className="live-room-chat-avatar-fallback">{getInitials(message.authorName, "?")}</div>}
    </div>
    <div className="live-room-chat-message-body">
      <div className="live-room-chat-message-head"><span className="live-room-chat-author">{isStaff ? <strong className="author-staff">{message.authorName}</strong> : <StudentName name={message.authorName} advanced={showAdvanced && message.authorIsAdvanced} />}{isStaff && <em className="live-room-chat-staff-badge">Куратор</em>}</span><span>{new Date(message.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span></div>
      {message.replyTo && <button type="button" className="live-room-chat-reply-quote" onClick={() => jumpToMessage(message.replyTo!.id)}><CornerUpLeft size={13} /><div className="live-room-chat-reply-quote-body">{replyIsStaff ? <strong className="author-staff">{message.replyTo.authorName}</strong> : <StudentName name={message.replyTo.authorName} advanced={showAdvanced && message.replyTo.authorIsAdvanced} />}<span>{message.replyTo.body || "Вложение"}</span></div></button>}
      {message.body && <p>{linkifyText(message.body)}</p>}
      {message.attachment && <button type="button" className="live-room-chat-image-link" onClick={() => setLightboxImage(message.attachment!.url)}><img className="live-room-chat-image" src={message.attachment.url} alt="Скриншот" loading="lazy" /></button>}
      {message.linkPreview && <div className="live-room-chat-embed">
        <span className="live-room-chat-embed-site">{message.linkPreview.siteName}</span>
        <a className="live-room-chat-embed-title" href={message.linkPreview.sourceUrl} target="_blank" rel="noopener noreferrer">{message.linkPreview.title}</a>
        <button type="button" className="live-room-chat-embed-image-link" onClick={() => setLightboxImage(message.linkPreview!.imageUrl)}><img className="live-room-chat-embed-image" src={message.linkPreview.imageUrl} alt={message.linkPreview.title} loading="lazy" /></button>
      </div>}
      {lightboxImage && lightboxPortalTarget && createPortal(
        <div className="chat-image-lightbox-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setLightboxImage(null); }}>
          <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть просмотр" onClick={() => setLightboxImage(null)}><X size={22} /></button>
          <img className="chat-image-lightbox-image" src={lightboxImage} alt="Просмотр изображения" />
        </div>,
        lightboxPortalTarget,
      )}
      {message.reactions.length > 0 && <div className="live-room-chat-reactions">{message.reactions.map((reaction) => <button type="button" key={reaction.emoji} className={`live-room-chat-reaction ${reaction.userIds.includes(currentUserId) ? "active" : ""}`} onClick={() => onReact(message.id, reaction.emoji)}>{reaction.emoji} <span>{reaction.userIds.length}</span></button>)}</div>}
    </div>
  </div>;
}

function ChatContextMenu({ state, canDelete, onClose, onReply, onReact, onDelete }: {
  state: { message: StreamChatMessage; x: number; y: number };
  canDelete: boolean;
  onClose: () => void;
  onReply: (message: StreamChatMessage) => void;
  onReact: (messageId: string, emoji: string) => void;
  onDelete: (messageId: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => { if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose(); };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("keydown", handleKeyDown);
    return () => { window.removeEventListener("mousedown", handleClickOutside); window.removeEventListener("keydown", handleKeyDown); };
  }, [onClose]);

  const menuHeight = canDelete ? 232 : 192;
  const left = Math.min(state.x, window.innerWidth - 220);
  const top = Math.min(state.y, window.innerHeight - menuHeight);

  return typeof document === "undefined" ? null : createPortal(
    <div className="live-room-chat-menu" ref={menuRef} role="menu" style={{ left, top }}>
      <div className="live-room-chat-menu-reactions">{REACTION_OPTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => { onReact(state.message.id, emoji); onClose(); }}>{emoji}</button>)}</div>
      <button type="button" className="live-room-chat-menu-item" role="menuitem" onClick={() => { onReply(state.message); onClose(); }}><CornerUpLeft size={14} /> Ответить</button>
      {canDelete && <button type="button" className="live-room-chat-menu-item danger" role="menuitem" onClick={() => { onDelete(state.message.id); onClose(); }}><Trash2 size={14} /> Удалить сообщение</button>}
    </div>,
    document.body,
  );
}

function ChatPanel({ isFullscreen, canModerate = false }: { isFullscreen?: boolean; canModerate?: boolean }) {
  const [chatDraft, setChatDraft] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<StreamChatMessage | null>(null);
  const [contextMenu, setContextMenu] = useState<{ message: StreamChatMessage; x: number; y: number } | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const { messages: chatMessages, connected: chatConnected, chatError, currentUserId, sendMessage, react, deleteMessage } = useStreamChat();

  // Discord-style: follow new messages only while the viewer is at the bottom. Someone scrolled up
  // reading history stays where they are (2026-10-03: every new message used to yank them down)
  // and gets a "новые сообщения ↓" button instead. Their own message always jumps to the bottom.
  const [atBottom, setAtBottom] = useState(true);
  const atBottomRef = useRef(true);
  const [seenCount, setSeenCount] = useState(0);
  const unseenCount = atBottom ? 0 : Math.max(0, chatMessages.length - seenCount);
  const scrollChatToBottom = (smooth = false) => chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  const handleChatScroll = () => {
    const element = chatScrollRef.current;
    if (!element) return;
    const nowAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (nowAtBottom === atBottomRef.current) return;
    atBottomRef.current = nowAtBottom;
    setAtBottom(nowAtBottom);
    // Leaving the bottom: everything up to here counts as seen; arriving: all of it is.
    setSeenCount(chatMessages.length);
  };
  const lastMessage = chatMessages[chatMessages.length - 1];
  useEffect(() => {
    const ownMessage = Boolean(lastMessage && currentUserId && lastMessage.authorId === currentUserId);
    if (atBottomRef.current || ownMessage) chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight });
  }, [chatMessages, lastMessage, currentUserId]);

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
    <div className="live-room-chat-scroll-wrap">
    <div className="live-room-chat-messages" ref={chatScrollRef} onScroll={handleChatScroll}>
      {chatMessages.length === 0 ? (
        <div className="live-room-chat-placeholder">
          <MessageSquareText size={22} />
          <strong>Сообщений пока нет</strong>
          <span>Здесь будет обсуждение эфира в реальном времени{isFullscreen ? " — чат остаётся справа и на весь экран." : "."}</span>
        </div>
      ) : chatMessages.map((message) => <ChatMessageRow message={message} currentUserId={currentUserId} showAdvanced={canModerate} onReact={react} onContextMenu={(event, targetMessage) => { event.preventDefault(); setContextMenu({ message: targetMessage, x: event.clientX, y: event.clientY }); }} key={message.id} />)}
    </div>
    {unseenCount > 0 && <button type="button" className="live-room-chat-new-messages" onClick={() => scrollChatToBottom(true)}>{unseenCount} {unseenCount % 10 === 1 && unseenCount % 100 !== 11 ? "новое сообщение" : [2, 3, 4].includes(unseenCount % 10) && ![12, 13, 14].includes(unseenCount % 100) ? "новых сообщения" : "новых сообщений"} ↓</button>}
    </div>
    {contextMenu && <ChatContextMenu
      state={contextMenu}
      canDelete={canModerate || contextMenu.message.authorId === currentUserId}
      onClose={() => setContextMenu(null)}
      onReply={setReplyingTo}
      onReact={react}
      onDelete={deleteMessage}
    />}
    {(chatError || uploadError) && <span className="live-room-error live-room-chat-error">{uploadError ?? chatError}</span>}
    {replyingTo && <div className="live-room-chat-replying-bar"><CornerUpLeft size={13} /><span>Ответ для <strong>{replyingTo.authorName}</strong>: {replyingTo.body || "Вложение"}</span><button type="button" className="icon-button compact" aria-label="Отменить ответ" onClick={() => setReplyingTo(null)}><X size={13} /></button></div>}
    <form className="live-room-chat-form" onSubmit={submitChatMessage}>
      <input type="text" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onPaste={(event) => void handlePaste(event)} placeholder={uploadingImage ? "Загружаем скриншот…" : "Написать в чат…"} maxLength={2000} disabled={!chatConnected || uploadingImage} />
      <button type="submit" className="icon-button compact" aria-label="Отправить" disabled={!chatConnected || uploadingImage || !chatDraft.trim()}><ArrowRight size={15} /></button>
    </form>
  </aside>;
}

/** Read-only history of the chat that happened during a specific recorded broadcast — lazy-loaded on expand. */
function ArchivedChatPanel({ mediaId }: { mediaId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<StreamChatMessage[] | null>(null);
  const noop = () => { /* archived — reactions/replies/moderation don't apply */ };

  useEffect(() => {
    if (!expanded || messages !== null) return;
    void fetch(`${API_ORIGIN}/api/streams/media/${mediaId}/chat`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { data?: StreamChatMessage[] } | null) => setMessages(payload?.data ?? []))
      .catch(() => setMessages([]));
  }, [expanded, messages, mediaId]);

  return <div className={`module-archived-chat ${expanded ? "is-open" : ""}`}>
    <button type="button" className="module-archived-chat-toggle" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <span className="module-archived-chat-toggle-label"><MessageSquareText size={14} /> Чат эфира</span>
      <ChevronDown size={15} className={`module-archived-chat-chevron ${expanded ? "is-open" : ""}`} />
    </button>
    {expanded && <div className="module-archived-chat-messages">
      {messages === null
        ? <p className="module-resource-note">Загружаем…</p>
        : messages.length === 0
          ? <p className="module-resource-note">Сообщений во время эфира не было.</p>
          : messages.map((message) => <ChatMessageRow message={message} currentUserId="" onReact={noop} onContextMenu={noop} key={message.id} />)}
    </div>}
  </div>;
}

type StreamHostApiDto = { name: string; startedAt: string; isMe: boolean } | null;
type StreamPracticumApiDto = { title: string; students: number; biggerPracticum: { title: string; students: number } | null; workingPracticumTitle: string | null };
type StreamTargetApiDto = { host?: StreamHostApiDto; practicum?: StreamPracticumApiDto; moduleId: string | null; moduleTitle: string | null; scheduleEventId: string | null; scheduleEventTitle: string | null; mediaKind: "STREAM" | "QA" | null };

function StreamTargetPicker({ upcoming, openSignal = 0, onSaved }: { upcoming: ScheduleEvent[]; openSignal?: number; onSaved?: () => void }) {
  const [mode, setMode] = useState<"none" | "module" | "event">("none");
  const [moduleOptions, setModuleOptions] = useState<Array<{ id: string; title: string }>>([]);
  const [moduleId, setModuleId] = useState("");
  const [scheduleEventId, setScheduleEventId] = useState("");
  const [mediaKind, setMediaKind] = useState<"STREAM" | "QA">("STREAM");
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [targetEventTitle, setTargetEventTitle] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);

  // The "эфир не привязан" banner's button — open the picker (state adjusted during render, the
  // React-recommended way to react to a prop change) and bring it into view.
  const [seenOpenSignal, setSeenOpenSignal] = useState(openSignal);
  if (openSignal !== seenOpenSignal) {
    setSeenOpenSignal(openSignal);
    setExpanded(true);
  }
  useEffect(() => {
    if (openSignal) panelRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [openSignal]);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/course/manage`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { data?: { modules: Array<{ id: string; title: string }> } } | null) => {
        if (payload?.data) setModuleOptions(payload.data.modules.map((module) => ({ id: module.id, title: module.title })));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/streams/target`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((payload: { data?: StreamTargetApiDto } | null) => {
        if (payload?.data?.moduleId) { setMode("module"); setModuleId(payload.data.moduleId); setMediaKind(payload.data.mediaKind === "QA" ? "QA" : "STREAM"); }
        else if (payload?.data?.scheduleEventId) { setMode("event"); setScheduleEventId(payload.data.scheduleEventId); setTargetEventTitle(payload.data.scheduleEventTitle); }
      })
      .catch(() => undefined);
  }, []);

  const save = async (body: { moduleId?: string; scheduleEventId?: string; mediaKind?: "STREAM" | "QA" }) => {
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/target`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({})) as { data?: StreamTargetApiDto; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось сохранить цель эфира");
      setTargetEventTitle(payload.data.scheduleEventTitle);
      setNotice(payload.data.scheduleEventId ? "Сохранено — ученики смогут присоединиться из расписания, запись ляжет черновиком у события." : "Сохранено — запись автоматически попадёт туда.");
      onSaved?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось сохранить цель эфира");
    } finally {
      setSaving(false);
    }
  };

  const applyMode = (nextMode: "none" | "module" | "event") => {
    setMode(nextMode);
    setNotice("");
    if (nextMode === "none") { setModuleId(""); setScheduleEventId(""); void save({}); return; }
    if (nextMode === "module") {
      const id = moduleId || moduleOptions[0]?.id || "";
      setModuleId(id);
      if (id) void save({ moduleId: id, mediaKind });
      return;
    }
    const id = scheduleEventId || upcoming[0]?.id || "";
    setScheduleEventId(id);
    if (id) void save({ scheduleEventId: id });
  };

  const moduleTitle = moduleOptions.find((module) => module.id === moduleId)?.title;
  const summary = mode === "module" ? (moduleTitle ? `${moduleTitle} · ${mediaKind === "QA" ? "Q&A" : "Тематический"}` : undefined)
    : mode === "event" ? (upcoming.find((event) => event.id === scheduleEventId)?.title ?? targetEventTitle ?? undefined)
    : null;
  const summaryLabel = !summary ? "Не выбрана — запись попадёт в Медиатеку черновиком"
    : mode === "event" ? `Событие: ${summary} · запись — черновиком у события`
    : `Автопубликация: ${summary}`;

  /** "Завершить эфир" — same as the button in the schedule event's card (StreamService#finishStream). */
  const finish = async () => {
    if (!scheduleEventId) return;
    if (!window.confirm(`Завершить эфир «${summary ?? "события"}»?\n\nУ учеников событие будет отмечено как завершённое. Трансляцию в OBS остановите отдельно (кнопка «Остановить трансляцию»).`)) return;
    setSaving(true); setNotice("");
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/target/finish`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduleEventId }) });
      const payload = await response.json().catch(() => ({})) as { data?: StreamTargetApiDto; message?: string };
      if (!response.ok) throw new Error(payload.message ?? "Не удалось завершить эфир");
      setMode("none"); setScheduleEventId(""); setTargetEventTitle(null);
      setNotice("Эфир завершён — у учеников событие отмечено как завершённое.");
      onSaved?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Не удалось завершить эфир");
    } finally {
      setSaving(false);
    }
  };

  return <section className="student-module-access-panel" ref={panelRef}>
    <button className="student-module-access-toggle" type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}>
      <div className="student-module-access-head"><span className="section-kicker">ЦЕЛЬ ЭФИРА</span><strong>Куда попадёт запись</strong><span>{summaryLabel}</span></div>
      <ChevronDown size={16} className={`student-module-access-chevron ${expanded ? "is-open" : ""}`} aria-hidden="true" />
    </button>
    {expanded && <div className="schedule-slot-settings-body">
      <div className="form-grid">
        <label className="form-field"><span>Привязать к</span><select value={mode} onChange={(event) => applyMode(event.target.value as "none" | "module" | "event")}><option value="none">Не привязывать</option><option value="module">Уроку</option><option value="event">Событию расписания</option></select></label>
        {mode === "module" && <label className="form-field"><span>Урок</span><select value={moduleId} onChange={(event) => { setModuleId(event.target.value); void save({ moduleId: event.target.value, mediaKind }); }}>{moduleOptions.map((module) => <option value={module.id} key={module.id}>{module.title}</option>)}</select></label>}
        {mode === "module" && <label className="form-field"><span>Тип записи</span><select value={mediaKind} onChange={(event) => { const nextKind = event.target.value as "STREAM" | "QA"; setMediaKind(nextKind); if (moduleId) void save({ moduleId, mediaKind: nextKind }); }}><option value="STREAM">Тематический</option><option value="QA">Q&A</option></select></label>}
        {mode === "event" && <label className="form-field"><span>Событие</span><select value={scheduleEventId} onChange={(event) => { setScheduleEventId(event.target.value); void save({ scheduleEventId: event.target.value }); }}>{upcoming.map((event) => <option value={event.id} key={event.id}>{event.title} — {formatEventDate(event.date)}</option>)}</select></label>}
      </div>
      <small className="form-field-hint">{mode === "event" ? "Эфир можно начать и прямо из «Расписания» — кнопкой «Начать стрим» в карточке события. Запись после эфира ляжет в «Медиатеку» черновиком у этого события: проверьте и опубликуйте." : mode === "module" ? "Как только запись эфира будет готова, она сама опубликуется в выбранном уроке — заходить в Медиатеку не нужно." : "Без привязки запись ляжет в «Медиатеку» черновиком, а у учеников в расписании не будет кнопки «Присоединиться»."}</small>
      {mode === "event" && scheduleEventId && <div className="stream-target-finish-row"><button className="primary-button stream-finish-button" type="button" onClick={() => void finish()} disabled={saving}>{saving ? "Завершаем…" : "Завершить эфир"}</button><span>Отметит событие у учеников как завершённое. Трансляцию в OBS остановите отдельно.</span></div>}
      {notice && <div className="form-action-feedback">{saving ? "Сохраняем…" : notice}</div>}
    </div>}
  </section>;
}

function CuratorStreamsView({ onNavigate }: { onNavigate: (nextNav: CuratorNav) => void }) {
  const [upcoming, setUpcoming] = useState<ScheduleEvent[]>([]);
  const [targetPickerSignal, setTargetPickerSignal] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const liveWrapRef = useRef<HTMLDivElement>(null);
  const [liveInput, setLiveInput] = useState<IngressDto | null>(null);
  const [liveInputLoading, setLiveInputLoading] = useState(true);
  const [settingUp, setSettingUp] = useState(false);
  const [liveInputError, setLiveInputError] = useState<string | null>(null);
  const [keyVisible, setKeyVisible] = useState(false);
  const [copiedField, setCopiedField] = useState<"url" | "key" | null>(null);
  const [status, setStatus] = useState<PlaybackStatusDto | null>(null);
  const [storageStatus, setStorageStatus] = useState<{ totalBytes: number; availableBytes: number } | null>(null);
  useEffect(() => {
    const loadStorageStatus = () => { void fetch(`${API_ORIGIN}/api/streams/recording-storage`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: { totalBytes: number; availableBytes: number } | null };
      if (payload.data) setStorageStatus(payload.data);
    }).catch(() => undefined); };
    loadStorageStatus();
    const poll = window.setInterval(loadStorageStatus, 5 * 60 * 1000);
    return () => window.clearInterval(poll);
  }, []);
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
      const payload = await response.json() as { data?: IngressDto | null };
      setLiveInput(payload.data ?? null);
    } catch { /* keep last known state */ }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data?: PlaybackStatusDto };
      if (payload.data) setStatus(payload.data);
    } catch { /* keep last known state */ }
  }, []);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/streams/live-input`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: IngressDto | null };
      setLiveInput(payload.data ?? null);
      // An already-configured ingress is reused — re-POSTing on every visit never rotates the
      // RTMP URL/key, and the server skips the settings update while a broadcast is running
      // (updating a live ingress restarts it and splits the recording — see ensureIngress).
      if (payload.data) {
        void fetch(`${API_ORIGIN}/api/streams/live-input`, { method: "POST", credentials: "include" })
          .then((refreshResponse) => (refreshResponse.ok ? refreshResponse.json() as Promise<{ data?: IngressDto }> : null))
          .then((refreshPayload) => { if (refreshPayload?.data) setLiveInput(refreshPayload.data); })
          .catch(() => undefined);
      }
    }).catch(() => undefined).finally(() => setLiveInputLoading(false));
  }, []);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: PlaybackStatusDto };
      if (payload.data) setStatus(payload.data);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const poll = window.setInterval(() => { void refreshLiveInput(); void refreshStatus(); }, 15_000);
    return () => window.clearInterval(poll);
  }, [refreshLiveInput, refreshStatus]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const handleChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleChange);
    return () => document.removeEventListener("fullscreenchange", handleChange);
  }, []);

  // Two independent fullscreen entry points: this one (theater mode — video + chat side by
  // side) and the one on the video surface itself (video only). Some viewers want to keep chat
  // visible while fullscreen, others don't — both are kept rather than picking one.
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
      const payload = await response.json() as { data?: IngressDto; message?: string };
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
      <div><span className="section-kicker">ЭФИР ПОТОКА</span><strong>Прямой эфир</strong><span>Здесь куратор будет запускать трансляцию и вести чат с учениками.</span>{storageStatus && <span>Место для записей: свободно {formatFileSize(storageStatus.availableBytes)} из {formatFileSize(storageStatus.totalBytes)}</span>}</div>
      <div className="schedule-toolbar-actions">
        <button className="secondary-button" onClick={() => { window.sessionStorage.setItem("curator-target-kind", "STREAM"); onNavigate("Медиатека"); }}><Plus size={16} /> Загрузить запись в Медиатеку</button>
      </div>
    </div>

    {/* Live without a lesson/event picked: the schedule keeps saying "Эфир ещё не начался",
        the "Стрим начался" email has no topic and the recording lands unassigned — easy to
        miss mid-broadcast, so it gets a loud banner until it's fixed (2026-10-01). */}
    {status?.isLive && status.hasStreamTarget === false && <div className="stream-target-warning" role="alert">
      <AlertTriangle size={18} />
      <div><strong>Эфир не привязан к событию или уроку</strong><span>В расписании у учеников он показывается как «Эфир ещё не начался», а запись попадёт в Медиатеку без привязки. Выберите, к чему относится этот эфир.</span></div>
      <button className="primary-button compact-button" type="button" onClick={() => setTargetPickerSignal((current) => current + 1)}>Выбрать</button>
    </div>}

    <StreamPracticumNote />
    <StreamHostNote status={status} />

    <StreamTargetPicker upcoming={upcoming} openSignal={targetPickerSignal} onSaved={() => void refreshStatus()} />

    <div className="live-room-live" ref={liveWrapRef}>
      <section className="content-panel live-room-player">
        <div className="section-heading">
          <div><span className="section-kicker">ЭФИР</span><h2>Окно трансляции</h2></div>
          <div className="live-room-player-actions">
            {status?.isLive ? <span className="live-room-live-badge"><span className="live-dot" /> В эфире</span> : liveInput ? <span className="live-room-soon-badge">Офлайн</span> : null}
            <RecordingBadge status={status} audience="staff" />
            <button className="icon-button compact" type="button" aria-label={isFullscreen ? "Свернуть" : "Видео + чат на весь экран"} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          </div>
        </div>
        {status?.isLive && status.viewerToken && status.roomName ? (
          <div className="live-room-player-frame">
            <TrackedVideo livekit={{ token: status.viewerToken, roomName: status.roomName }} title="Прямой эфир" />
          </div>
        ) : (
          <div className="live-room-player-placeholder">
            <Radio size={26} />
            {liveInputLoading ? <strong>Проверяем настройки трансляции…</strong> : liveInput ? <>
              <strong>Ждём подключения из OBS</strong>
              <div className="live-room-rtmp-box">
                <div className="live-room-rtmp-row">
                  <span>Server URL</span>
                  <code>{liveInput.rtmpUrl}</code>
                  <button type="button" className="icon-button compact" aria-label="Скопировать URL" onClick={() => liveInput.rtmpUrl && void copyValue(liveInput.rtmpUrl, "url")}>{copiedField === "url" ? <CheckCircle2 size={14} /> : <Copy size={14} />}</button>
                </div>
                <div className="live-room-rtmp-row">
                  <span>Stream Key</span>
                  <code>{keyVisible ? liveInput.rtmpStreamKey : "••••••••••••••••••••"}</code>
                  <button type="button" className="icon-button compact" aria-label={keyVisible ? "Скрыть ключ" : "Показать ключ"} onClick={() => setKeyVisible((current) => !current)}>{keyVisible ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  <button type="button" className="icon-button compact" aria-label="Скопировать ключ" onClick={() => liveInput.rtmpStreamKey && void copyValue(liveInput.rtmpStreamKey, "key")}>{copiedField === "key" ? <CheckCircle2 size={14} /> : <Copy size={14} />}</button>
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

      <ChatPanel isFullscreen={isFullscreen} canModerate />
    </div>

    <section className="content-panel live-room-upcoming">
      <div className="section-heading"><div><span className="section-kicker">РАСПИСАНИЕ</span><h2>Ближайшие эфиры</h2></div><CalendarDays size={18} className="heading-icon" /></div>
      {upcoming.length > 0 ? <div className="live-room-upcoming-list">{upcoming.map((event) => <button className="live-room-upcoming-row" type="button" key={event.id} onClick={() => onNavigate("Расписание")}><div><strong>{event.title}</strong><span>{event.weekday}, {formatEventDate(event.date)} · {event.time}{event.kyivTimeLabel ? ` (по Киеву ${event.kyivTimeLabel})` : ""}</span></div><ChevronRight size={16} /></button>)}</div> : <div className="empty-state compact"><CalendarDays size={20} /><strong>Эфиров пока не запланировано</strong><span>Добавь событие в «Расписании», чтобы оно появилось здесь.</span></div>}
    </section>
  </div>;
}

type ScheduleCoverTemplate = { id: string; label: string; coverPath: string };

function scheduleCoverImageUrl(coverPath: string): string {
  return coverPath.startsWith("/api/") ? `${API_ORIGIN}${coverPath}` : coverPath;
}

function ScheduleEventForm({ initialDate = toDateKey(new Date()), initialEvent, onCreate, onCancel }: { initialDate?: string; initialEvent?: ScheduleEvent | null; onCreate: (event: ScheduleEvent) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(initialEvent?.title ?? "");
  const [type, setType] = useState<ScheduleEvent["type"]>(initialEvent?.type ?? "Практическая часть");
  const [date, setDate] = useState(initialEvent?.date ?? initialDate);
  const [time, setTime] = useState(initialEvent?.time ?? "19:00 — 20:30");
  const [description, setDescription] = useState(initialEvent?.description ?? "");
  const [coverTemplates, setCoverTemplates] = useState<ScheduleCoverTemplate[]>([]);
  const [coverPath, setCoverPath] = useState<string>(initialEvent?.coverPath ?? "");
  // Set only right after a fresh upload for THIS event — cleared the moment a template tile is
  // picked instead. Lets the backend tell an ad hoc upload (needs attaching once the event
  // exists) apart from a template/previous coverPath (already a real, usable URL) — see
  // ScheduleService#create/#update.
  const [coverFileId, setCoverFileId] = useState("");
  const [coverFileName, setCoverFileName] = useState("");
  const [coverUploading, setCoverUploading] = useState(false);
  const [coverError, setCoverError] = useState("");
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateLabel, setTemplateLabel] = useState("");
  const [templateSaving, setTemplateSaving] = useState(false);
  const [templateError, setTemplateError] = useState("");
  const canCreate = title.trim().length > 2 && description.trim().length > 3 && date.length > 0 && time.trim().length > 0;
  useEffect(() => { if (!initialEvent) { const timer = window.setTimeout(() => setDate(initialDate), 0); return () => window.clearTimeout(timer); } }, [initialDate, initialEvent]);
  useEffect(() => {
    let active = true;
    void fetch(`${API_ORIGIN}/api/schedule/cover-templates`, { credentials: "include", cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: ScheduleCoverTemplate[] }> : null)
      .then((payload) => {
        if (!active || !payload?.data) return;
        setCoverTemplates(payload.data);
        // Only for a brand-new event with nothing picked yet — an edit already has its own
        // coverPath (possibly a one-off upload), which this must never clobber.
        if (!initialEvent && payload.data[0]) setCoverPath((current) => current || payload.data![0].coverPath);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [initialEvent]);
  const handleCoverFile = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setCoverError("Выберите файл изображения."); return; }
    if (file.size > 5 * 1024 * 1024) { setCoverError("Размер обложки не должен превышать 5 МБ."); return; }
    setCoverError("");
    setCoverUploading(true);
    try {
      const fileId = await uploadPrivateFile(file, "SCHEDULE_COVER");
      setCoverFileId(fileId);
      setCoverPath(`/api/files/${fileId}/content`);
      setCoverFileName(file.name);
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : "Не удалось загрузить обложку.");
    } finally {
      setCoverUploading(false);
    }
  };
  const handleCreateTemplate = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { setTemplateError("Выберите файл изображения."); return; }
    if (file.size > 5 * 1024 * 1024) { setTemplateError("Размер обложки не должен превышать 5 МБ."); return; }
    const label = templateLabel.trim();
    if (!label) { setTemplateError("Сначала введите название шаблона."); return; }
    setTemplateError("");
    setTemplateSaving(true);
    try {
      const fileId = await uploadPrivateFile(file, "SCHEDULE_COVER_TEMPLATE");
      const response = await fetch(`${API_ORIGIN}/api/schedule/cover-templates`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId, label }) });
      const payload = await response.json().catch(() => ({})) as { data?: ScheduleCoverTemplate; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать шаблон.");
      const created = payload.data;
      setCoverTemplates((current) => [...current, created]);
      setCoverPath(created.coverPath);
      setCoverFileId("");
      setCoverFileName("");
      setTemplateLabel("");
      setShowTemplateForm(false);
    } catch (error) {
      setTemplateError(error instanceof Error ? error.message : "Не удалось создать шаблон.");
    } finally {
      setTemplateSaving(false);
    }
  };
  const deleteTemplate = async (template: ScheduleCoverTemplate) => {
    if (!window.confirm(`Удалить шаблон «${template.label}»? Уже созданные события с этой обложкой не изменятся.`)) return;
    try {
      const response = await fetch(`${API_ORIGIN}/api/schedule/cover-templates/${template.id}`, { method: "DELETE", credentials: "include" });
      if (!response.ok) throw new Error();
      setCoverTemplates((current) => current.filter((item) => item.id !== template.id));
      if (coverPath === template.coverPath) setCoverPath("");
    } catch {
      setCoverError("Не удалось удалить шаблон.");
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    const parsedDate = new Date(`${date}T12:00:00`);
    const weekday = new Intl.DateTimeFormat("ru-RU", { weekday: "long" }).format(parsedDate);
    onCreate({ id: initialEvent?.id ?? `event-${Date.now()}`, date, day: date.slice(-2), month: parsedDate.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase(), weekday, type, title: title.trim(), time: time.trim(), live: type === "Практическая часть" || type === "Лекция", description: description.trim(), recordingAvailable: initialEvent?.recordingAvailable ?? false, coverPath: coverPath.trim() || undefined, coverFileId: coverFileId || undefined });
  };

  return <form className="content-panel schedule-form" onSubmit={submit}><div className="section-heading"><div><span className="section-kicker">НОВОЕ СОБЫТИЕ</span><h2>Добавить встречу в поток</h2></div><button type="button" className="icon-button compact" aria-label="Закрыть форму" onClick={onCancel}><X size={16} /></button></div><div className="form-body"><div className="form-grid"><label className="form-field form-field-wide"><span>Название</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, Разбор рынка в прямом эфире" /></label><label className="form-field"><span>Тип события</span><select value={type} onChange={(event) => setType(event.target.value as ScheduleEvent["type"])}><option>Лекция</option><option>Практическая часть</option><option>Q&A</option><option>Разбор ДЗ</option><option>Бэктест</option><option>Пресессия</option></select>{isBookableSlotType(type) && <small className="form-field-hint">Индивидуальный слот: свободен для записи, пока его не займёт ученик — количество слотов на ученика настраивается в блоке «Лимиты записи» на странице «Расписание».</small>}</label><label className="form-field"><span>Дата</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label className="form-field"><span>{viewerTimeZone ? `Время (ваш пояс: ${timeZoneTitle(viewerTimeZone)}, ${timeZoneOffsetLabel(viewerTimeZone)})` : "Время (по Киеву)"}</span><input value={time} onChange={(event) => setTime(event.target.value)} placeholder="19:00 — 20:30" /></label><label className="form-field form-field-wide"><span>Описание</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="Что будет происходить на встрече и что подготовить ученикам?" /></label></div><div className="schedule-cover-picker"><div><span className="form-section-label">Обложка события</span><p>Выберите готовый шаблон, загрузите фото только для этого события или сохраните новый шаблон для будущих событий.</p></div><div className="schedule-cover-grid">{coverTemplates.map((templateOption) => <div className="schedule-cover-option-wrap" key={templateOption.id}><button type="button" className={`schedule-cover-option ${!coverFileId && coverPath === templateOption.coverPath ? "selected" : ""}`} onClick={() => { setCoverPath(templateOption.coverPath); setCoverFileId(""); setCoverFileName(""); }}><span style={{ backgroundImage: `url("${scheduleCoverImageUrl(templateOption.coverPath)}")` }} /><strong>{templateOption.label}</strong></button><button type="button" className="schedule-cover-delete" aria-label={`Удалить шаблон «${templateOption.label}»`} onClick={() => void deleteTemplate(templateOption)}><X size={12} /></button></div>)}</div><label className="schedule-cover-upload"><Plus size={16} /><span>{coverUploading ? "Загружаем…" : coverFileName || "Выбрать изображение с компьютера"}</span><small>PNG, JPG, WEBP · до 5 МБ · только для этого события</small><input type="file" accept="image/png,image/jpeg,image/webp" disabled={coverUploading} onChange={(event) => { void handleCoverFile(event.target.files?.[0]); event.target.value = ""; }} /></label>{coverError && <div className="file-error" role="alert">{coverError}</div>}<div className="schedule-cover-template-create">{showTemplateForm ? <div className="schedule-cover-template-form"><input value={templateLabel} onChange={(event) => setTemplateLabel(event.target.value)} placeholder="Название шаблона" maxLength={60} /><label className="schedule-cover-upload compact"><Plus size={14} /><span>{templateSaving ? "Сохраняем…" : "Выбрать фото и сохранить как шаблон"}</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={templateSaving} onChange={(event) => { void handleCreateTemplate(event.target.files?.[0]); event.target.value = ""; }} /></label><button type="button" className="text-button" onClick={() => { setShowTemplateForm(false); setTemplateError(""); setTemplateLabel(""); }}>Отмена</button>{templateError && <div className="file-error" role="alert">{templateError}</div>}</div> : <button type="button" className="text-button" onClick={() => setShowTemplateForm(true)}><Plus size={14} /> Создать шаблон из своего фото</button>}</div></div><div className="create-actions"><button type="button" className="secondary-button" onClick={onCancel}>Отмена</button><button type="submit" className="primary-button" disabled={!canCreate}>Опубликовать событие <ChevronRight size={16} /></button></div></div></form>;
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
  const [published, setPublished] = useState<(Assignment & { moduleId?: string }) | null>(null);
  const [formKey, setFormKey] = useState(0);

  useEffect(() => {
    const handlePublished = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isAssignment(event.detail)) return;
      setPublished(event.detail as Assignment & { moduleId?: string });
    };
    window.addEventListener(assignmentPublishedEvent, handlePublished);
    return () => window.removeEventListener(assignmentPublishedEvent, handlePublished);
  }, []);

  const openPublishedLesson = () => {
    if (published?.moduleId) window.sessionStorage.setItem(OPEN_MODULE_AFTER_PUBLISH_KEY, published.moduleId);
    onNavigate("Программа");
  };

  if (published) return <section className="assignment-publish-success content-panel">
    <div className="assignment-publish-success-icon"><ShieldCheck size={24} /></div>
    <span className="section-kicker">Статус задания</span>
    <h2>Задание опубликовано</h2>
    <p><strong>{published.title}</strong> {published.isPractice ? "доступно ученикам потока в разделе «Задания» — они получат уведомление на почту." : "доступно ученикам в разделе «Задания» и связанном уроке."}</p>
    <div className="assignment-publish-success-actions">
      <button className="primary-button" onClick={() => { setPublished(null); setFormKey((value) => value + 1); }}><Plus size={16} /> Создать ещё одно</button>
      {published.moduleId && <button className="secondary-button" onClick={openPublishedLesson}><ArrowUpRight size={16} /> Посмотреть опубликованное ДЗ</button>}
    </div>
  </section>;

  return <CreateAssignmentForm key={formKey} />;
}

async function uploadPrivateFile(file: File, purpose?: "MODULE_COVER" | "SCHEDULE_COVER" | "SCHEDULE_COVER_TEMPLATE"): Promise<string> {
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
  files: File[];
};

function useObjectUrls(files: File[]): string[] {
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [files]);
  useEffect(() => {
    return () => { urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [urls]);
  return urls;
}

function AssignmentCreatorForm({ materialDraft }: { materialDraft: AssignmentMaterialDraft }) {
  const [isPractice, setIsPractice] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deadline, setDeadline] = useState(() => toDateKey(new Date()));
  const [requirements, setRequirements] = useState(["", ""]);
  const [showCriteria, setShowCriteria] = useState(false);
  const [formats, setFormats] = useState<SubmissionFormat[]>(["comment", "image"]);
  const [reviewRequired, setReviewRequired] = useState(true);
  const [courseModules, setCourseModules] = useState<CourseApiModule[]>([]);
  const [moduleId, setModuleId] = useState("");
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
        if (modules.length === 0) throw new Error("В программе пока нет уроков.");

        const targetModuleId = window.sessionStorage.getItem(ASSIGNMENT_TARGET_MODULE_KEY);
        const targetModule = modules.find((module) => module.id === targetModuleId) ?? modules[0];

        if (!active) return;
        setCourseModules(modules);
        setModuleId(targetModule.id);
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
  const canPublish = title.trim().length > 3
    && description.trim().length > 0
    && (isPractice || (!courseLoading && Boolean(selectedModule) && formats.length > 0));

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
    if (!isPractice && !selectedModule) return;
    setPublishError("");
    setPublishing(true);
    const uploadedFileIds: string[] = [];
    try {
      const fileMaterials = await Promise.all(materialDraft.files.map(async (file) => {
        const fileId = await uploadPrivateFile(file);
        uploadedFileIds.push(fileId);
        return { kind: "FILE" as const, title: file.name, fileId };
      }));
      const materials = [
        ...fileMaterials,
        ...(materialDraft.url.trim() ? [{ kind: "LINK" as const, title: materialDraft.title.trim() || "Материал к заданию", url: materialDraft.url.trim() }] : []),
      ];
      const response = await fetch(`${API_ORIGIN}/api/assignments`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isPractice,
          moduleId: isPractice ? undefined : selectedModule!.id,
          title: title.trim(),
          description: description.trim(),
          deadline: isPractice ? undefined : (deadline || undefined),
          requirements: isPractice ? [] : requirements.map((requirement) => requirement.trim()).filter(Boolean),
          allowedFormats: isPractice ? [] : formats,
          reviewRequired: isPractice ? undefined : reviewRequired,
          materials,
        }),
      });
      const payload = await response.json() as { data?: Assignment; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось опубликовать задание.");
      setPublished(true);
      window.sessionStorage.removeItem(ASSIGNMENT_TARGET_MODULE_KEY);
      window.dispatchEvent(new CustomEvent<Assignment & { materialsHandled: true; moduleId?: string }>(assignmentPublishedEvent, { detail: { ...payload.data, materialsHandled: true, moduleId: isPractice ? undefined : selectedModule?.id } }));
    } catch (error) {
      for (const fileId of uploadedFileIds) void fetch(`${API_ORIGIN}/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
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
    setReviewRequired(true);
    setPublished(false);
    setPublishError("");
  };

  return <form className="create-assignment-layout" onSubmit={publish}>
    <section className="content-panel create-assignment-form">
      <div className="form-body">
        <div className="assignment-type-toggle" role="tablist" aria-label="Тип задания">
          <button type="button" className={`assignment-type-chip ${!isPractice ? "active" : ""}`} onClick={() => { setIsPractice(false); setPublished(false); }} aria-pressed={!isPractice}>Обычное ДЗ</button>
          <button type="button" className={`assignment-type-chip ${isPractice ? "active" : ""}`} onClick={() => { setIsPractice(true); setPublished(false); }} aria-pressed={isPractice}>Практическое задание</button>
        </div>
        {isPractice && <div className="module-action-feedback">Без срока сдачи, урока и формальных критериев. Ученик увидит задание в «Задания» и ответит куратору в переписке — куратор пишет «ок»/«не ок» с рекомендацией, без кнопок «Принять»/«На доработку».</div>}
        {!isPractice && courseLoading && <div className="module-action-feedback">Загружаем актуальные уроки программы…</div>}
        {!isPractice && courseError && <div className="file-error" role="alert">{courseError}</div>}
        <label className="form-field form-field-wide"><span>Название задания</span><input value={title} onChange={(event) => { setTitle(event.target.value); setPublished(false); }} placeholder="Например, Разметка зон на истории" /></label>
        {!isPractice && <div className="form-grid">
          <label className="form-field form-field-wide"><span>Урок</span><select value={moduleId} disabled={courseLoading || courseModules.length === 0} onChange={(event) => { setModuleId(event.target.value); setPublished(false); }}>{courseModules.map((module) => <option value={module.id} key={module.id}>{module.number} · {module.title}</option>)}</select></label>
        </div>}
        <label className="form-field form-field-wide"><span>Описание и контекст</span><textarea value={description} onChange={(event) => { setDescription(event.target.value); setPublished(false); }} placeholder="Объясни, что ученик должен сделать и зачем это нужно в системе…" rows={5} /></label>
        {!isPractice && <div className="form-section">
          <div className="form-section-heading"><div><span>Критерии выполнения</span><small>Ученик будет ориентироваться на них при выполнении.</small></div><button type="button" className="secondary-button compact-button" onClick={() => setShowCriteria((current) => !current)}>{showCriteria ? "Скрыть" : "Добавить критерии"}</button></div>
          {showCriteria && <><div className="requirement-editor">{requirements.map((requirement, index) => <div className="requirement-input" key={index}><span>{String(index + 1).padStart(2, "0")}</span><input value={requirement} onChange={(event) => updateRequirement(index, event.target.value)} placeholder="Добавить критерий проверки" />{requirements.length > 1 && <button type="button" className="icon-button compact" aria-label={`Удалить критерий ${index + 1}`} onClick={() => setRequirements((current) => current.filter((_, requirementIndex) => requirementIndex !== index))}><X size={14} /></button>}</div>)}</div><button type="button" className="secondary-button compact-button requirement-add-button" onClick={() => setRequirements((current) => [...current, ""])}><Plus size={14} /> Добавить ещё критерий</button></>}
        </div>}
        {!isPractice && <label className="form-field"><span>Срок сдачи</span><input type="date" value={deadline} onChange={(event) => { setDeadline(event.target.value); setPublished(false); }} /></label>}
        {!isPractice && <div className="form-section"><div className="form-section-heading"><div><span>Проверка куратором</span><small>Без проверки — ученик сам отмечает задание выполненным, минуя очередь.</small></div></div><label className={`review-toggle-option ${!reviewRequired ? "active" : ""}`}><input type="checkbox" checked={!reviewRequired} onChange={(event) => { setReviewRequired(!event.target.checked); setPublished(false); }} /><CheckCircle2 size={16} /><span>ДЗ без проверки</span></label></div>}
        {!isPractice && <div className="form-section"><div className="form-section-heading"><div><span>Формат ответа</span><small>Что ученик сможет приложить к работе.</small></div></div><div className="format-options"><label className={`format-option ${formats.includes("comment") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("comment")} onChange={() => toggleFormat("comment")} /><MessageSquareText size={16} /><span>Комментарий</span></label><label className={`format-option ${formats.includes("image") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("image")} onChange={() => toggleFormat("image")} /><FileCheck2 size={16} /><span>Изображение</span></label><label className={`format-option ${formats.includes("video") ? "active" : ""}`}><input type="checkbox" checked={formats.includes("video")} onChange={() => toggleFormat("video")} /><Play size={16} /><span>Видео</span></label></div></div>}
        <div className="create-actions"><button type="button" className="secondary-button" onClick={clearForm}>Очистить</button><button type="submit" className="primary-button" disabled={!canPublish || published || publishing}>{published ? "Задание опубликовано" : publishing ? "Публикуем…" : "Опубликовать задание"} <ChevronRight size={16} /></button></div>
        {publishError && <div className="file-error" role="alert">{publishError}</div>}
        {published && <div className="detail-feedback curator-decision"><Target size={17} /><div><strong>{isPractice ? "Практическое задание опубликовано" : "Задание опубликовано в выбранный урок"}</strong><p>{isPractice ? "Ученики потока увидят его в разделе «Задания» и получат уведомление на почту." : "Ученики увидят его в разделе «Задания» и внутри связанного урока."}</p></div></div>}
      </div>
    </section>
    <aside className="content-panel assignment-preview"><div className="section-heading"><div><span className="section-kicker">ПРЕДПРОСМОТР</span><h2>Так увидит ученик</h2></div><EyeIcon /></div><div className="preview-body"><div className="preview-module">{isPractice ? "Практическое задание" : selectedModule ? `${selectedModule.number} · ${selectedModule.title}` : "Урок не выбран"}</div><h3>{title || "Название нового задания"}</h3><p>{description || "Здесь появится описание задания и контекст, который увидит ученик перед началом работы."}</p>{!isPractice && <div className="preview-meta"><span><Clock3 size={14} /> {deadline || "Срок не выбран"}</span></div>}{!isPractice && <div className="preview-requirements"><span className="detail-label">ЧТО НУЖНО СДЕЛАТЬ</span>{requirements.filter((requirement) => requirement.trim()).length > 0 ? requirements.filter((requirement) => requirement.trim()).map((requirement) => <div key={requirement}><span />{requirement}</div>) : <div className="preview-empty">Критерии появятся после заполнения формы.</div>}</div>}</div></aside>
  </form>;
}

function CreateAssignmentMaterialPanel() {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const materialFiles = useDiscussionAttachments();
  const [status, setStatus] = useState("");
  const handled = useRef(new Set<string>());
  const files = useMemo(() => materialFiles.attachments.map((attachment) => attachment.file), [materialFiles.attachments]);

  useEffect(() => {
    window.dispatchEvent(new CustomEvent<AssignmentMaterialDraft>("assignment-material-draft", {
      detail: { title, url, files },
    }));
  }, [title, url, files]);

  useEffect(() => {
    const handlePublished = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isAssignment(event.detail) || Boolean((event.detail as Assignment & { materialsHandled?: boolean }).materialsHandled) || handled.current.has(event.detail.id)) return;
      if (files.length === 0 && !url.trim()) return;
      handled.current.add(event.detail.id);
      void (async () => {
        try {
          const materials = [
            ...(url.trim() ? [{ kind: "LINK" as const, title: title.trim() || "Ссылка к заданию", url: url.trim() }] : []),
            ...(await Promise.all(files.map(async (file) => ({ kind: "FILE" as const, title: file.name, fileId: await uploadPrivateFile(file) })))),
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
  }, [files, title, url]);

  return <section className="content-panel assignment-material-panel"><div className="section-heading"><div><span className="section-kicker">ДОПОЛНИТЕЛЬНЫЕ МАТЕРИАЛЫ</span><h2>Что увидит ученик перед ответом</h2><p className="section-heading-note">Не обязательно — можно добавить ссылку Vimeo/Notion и файлы, если они нужны для этого задания.</p></div><button type="button" className="secondary-button" onClick={() => setExpanded((current) => !current)}>{expanded ? "Скрыть" : "Прикрепить материал"}</button></div>{expanded && <div className="assignment-material-editor"><div className="form-grid"><label className="form-field"><span>Название ссылки</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Запись разбора или пример" /></label><label className="form-field"><span>Ссылка Vimeo/Notion</span><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://vimeo.com/..." /></label></div><label className={`file-dropzone ${materialFiles.attachments.length > 0 ? "has-file" : ""}`} htmlFor="curator-assignment-material"><FileCheck2 size={17} /><span>{materialFiles.attachments.length > 0 ? `Прикреплено файлов: ${materialFiles.attachments.length}` : "Прикрепить изображение, PDF или видео"}</span><small>PNG, JPG, PDF, MP4 или WebM · до 10 МБ за файл · можно прикрепить сразу несколько</small><input id="curator-assignment-material" type="file" multiple accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => { materialFiles.addFiles(event.target.files); event.target.value = ""; }} /></label>{materialFiles.error && <div className="file-error" role="alert">{materialFiles.error}</div>}<DiscussionAttachmentPreviewList attachments={materialFiles.attachments} onRemove={materialFiles.removeAt} />{status && <div className="detail-feedback"><Target size={17} /><div><strong>{status}</strong><p>Сначала опубликуй задание основной кнопкой выше. Материалы сохранятся в защищённом хранилище.</p></div></div>}</div>}</section>;
}

function AssignmentMaterialLivePreview({ draft }: { draft: AssignmentMaterialDraft }) {
  const previewUrls = useObjectUrls(draft.files);
  const embedUrl = draft.url.trim() ? assignmentMaterialEmbed(draft.url.trim()) : null;
  const host = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".assignment-preview .preview-body");

  if ((draft.files.length === 0 && !draft.url.trim()) || !host) return null;

  return createPortal(<div className="assignment-material-live-preview">
    <div className="assignment-material-live-heading"><span className="section-kicker">МАТЕРИАЛ К ЗАДАНИЮ</span><strong>Предпросмотр для ученика</strong></div>
    {draft.files.map((file, index) => <div className="assignment-material-live-body" key={`${file.name}-${index}`}>
      <div className="assignment-material-live-head"><strong>{file.name}</strong><span>{file.type}</span></div>
      {previewUrls[index] && file.type.startsWith("image/") && <div className="assignment-material-live-image"><Image src={previewUrls[index]} alt="Предпросмотр материала" fill sizes="(max-width: 900px) 100vw, 560px" unoptimized /></div>}
      {previewUrls[index] && file.type.startsWith("video/") && <video className="assignment-material-live-video" src={previewUrls[index]} controls preload="metadata" />}
      {previewUrls[index] && file.type === "application/pdf" && <iframe className="assignment-material-live-pdf" src={previewUrls[index]} title="Предпросмотр PDF" />}
    </div>)}
    {(embedUrl || draft.url.trim()) && <div className="assignment-material-live-body">
      <div className="assignment-material-live-head"><strong>{draft.title.trim() || "Ссылка к заданию"}</strong><span>Ссылка</span></div>
      {embedUrl ? <iframe className="assignment-material-live-embed" src={embedUrl} title="Предпросмотр ссылки" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" /> : <a className="secondary-button" href={draft.url} target="_blank" rel="noreferrer">Открыть ссылку <ArrowUpRight size={15} /></a>}
    </div>}
  </div>, host);
}

function CreateAssignmentForm() {
  const [materialDraft, setMaterialDraft] = useState<AssignmentMaterialDraft>({ title: "", url: "", files: [] });

  useEffect(() => {
    const handleDraft = (event: Event) => {
      if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== "object") return;
      const draft = event.detail as Partial<AssignmentMaterialDraft>;
      if (typeof draft.title !== "string" || typeof draft.url !== "string" || !Array.isArray(draft.files) || !draft.files.every((file) => file instanceof File)) return;
      setMaterialDraft({ title: draft.title, url: draft.url, files: draft.files });
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

// content is only undefined in the total-API-outage fallback (see CourseView's courseLoadError
// — "Показаны демонстрационные данные"). A real, genuinely empty module always has a content
// entry (see normalizeCourse's contentByModule), just with empty media/assignments — that
// falls through to an honest empty list instead of pretending a lesson/stream/task exists.
function moduleContentFor(content?: CourseApiModule): ModuleContentItem[] {
  if (!content) return [];
  const mediaItems: ModuleContentItem[] = content.media
    .filter((media) => media.status === "PUBLISHED")
    .map((media) => {
      const isLessonVideo = media.kind === "LESSON_VIDEO";
      return { id: media.id, kind: isLessonVideo ? "Урок" : "Стрим", tone: isLessonVideo ? "lesson" : "stream", title: media.title ?? "Материал без названия", meta: `Запись · ${formatDuration(media.durationSec)}` };
    });
  const assignmentItems: ModuleContentItem[] = content.assignments
    .map((assignment) => ({ id: assignment.id, kind: "Задание", tone: "task", title: assignment.title, meta: "Отправка работы" }));
  return [...mediaItems, ...assignmentItems];
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

  // Demo data is a graceful-degradation fallback for a genuinely failed fetch (see courseLoadError
  // below) — never for the ordinary gap before the first successful fetch resolves. Falling back
  // to it unconditionally used to flash the hardcoded 7-lesson demo course (with lessons that
  // don't exist in the real one, e.g. "Delivery A.B.") for a moment on every load before the real,
  // shorter course replaced it — see isInitialLoad below for the fix.
  const isInitialLoad = !liveCourse && !courseLoadError;
  const courseModules = liveCourse?.modules ?? (courseLoadError ? defaultCourseModules : []);
  const courseContent = liveCourse?.contentByModule ?? {};
  // During local visual QA keep every module interactive so the full course
  // composition can be reviewed without changing production access rules.
  const effectiveUnlockedModuleIds = process.env.NODE_ENV === "development"
    ? new Set(courseModules.map((module) => module.id))
    : (liveUnlockedModuleIds ?? initialUnlockedModuleIds);
  const unlockedModuleIds = effectiveUnlockedModuleIds;
  const [selectedId, setSelectedId] = useState("week-1");
  const [hasUserSelectedModule, setHasUserSelectedModule] = useState(false);
  const [continued, setContinued] = useState(false);
  const [selectedContentId, setSelectedContentId] = useState("week-1-lesson");
  const [openedModuleId, setOpenedModuleId] = useState<string | null>(null);
  // "Практика" starts as an empty track for every existing practicum — see Module.section
  // and the curator's "Программа" page, which is what actually populates it over time.
  const [courseTrack, setCourseTrack] = useState<"theory" | "practice" | "advanced">("theory");
  const isAdvancedViewer = liveCourse?.isAdvanced ?? false;
  const sectionOrder: PracticumSection[] = courseTrack === "practice" ? ["Practice"] : courseTrack === "advanced" ? ["Advanced"] : ["Welcome", "Education", "Q&A"];
  const practicumModules = courseModules.filter((module) => sectionOrder.includes(module.section));
  const selectedModule = practicumModules.find((module) => module.id === selectedId) ?? practicumModules.find((module) => module.position === 1) ?? practicumModules[0];
  const openedModule = courseModules.find((module) => module.id === openedModuleId);
  const moduleToOpen = continued ? (openedModule ?? selectedModule) : undefined;
  // Per track, not the whole practicum — a freshly-started Практика shouldn't drag down a
  // Теория that's already mostly finished (or vice versa). See the Теория/Практика toggle above.
  const practicumProgress = calculatePracticumProgress(practicumModules);
  const moduleContents = selectedModule ? moduleContentFor(courseContent[selectedModule.id]) : [];
  const selectedContent = moduleContents.find((item) => item.id === selectedContentId) ?? moduleContents[0];
  const moduleUnlocked = selectedModule ? effectiveUnlockedModuleIds.has(selectedModule.id) : false;

  if (moduleToOpen) return <ModuleOverviewPage module={moduleToOpen} content={courseContent[moduleToOpen.id]} practicumCompleted={liveCourse?.practicumCompleted ?? false} onOpenAssignment={onOpenAssignment} onOpenDiscussion={onOpenDiscussion} onBack={() => { setOpenedModuleId(null); setContinued(false); }} />;

  if (isInitialLoad) return <div className="course-page"><div className="empty-state"><BookOpen size={22} /><strong>Загружаем практикум…</strong></div></div>;

  const moduleSteps = !selectedModule ? [] : [
    { label: "Материалы урока", description: `${pluralizeMaterials(selectedModule.lessons)} в уроке`, icon: <BookOpen size={16} />, complete: selectedModule.progress > 0 },
    { label: "Практическое задание", description: moduleUnlocked ? "Закрепи материал в своей работе" : "Откроется после предыдущего блока", icon: <Target size={16} />, complete: selectedModule.progress === 100 },
    { label: "Проверка куратора", description: selectedModule.progress === 100 ? "Урок завершён" : "После отправки задания", icon: <FileCheck2 size={16} />, complete: selectedModule.progress === 100 },
  ];

  return <div className="course-page">
    {courseLoadError && <div className="file-error" role="alert">{courseLoadError}</div>}
    {courseTrack === "theory" && <section className="course-progress-panel content-panel">
      <div className="course-progress-copy"><span className="section-kicker">ПРОГРЕСС ПРАКТИКУМА</span><strong>{practicumProgress}%</strong><div className="course-progress-figma-bar" aria-hidden="true"><b style={{ width: `${practicumProgress}%` }} /></div><span>Завершённый прогресс по доступным блокам. Двигайся дальше в своём темпе.</span></div>
      <div className="course-progress-track"><div><span>Общий прогресс</span><strong>{practicumProgress}% выполнено</strong></div><i><b style={{ width: `${practicumProgress}%` }} /></i></div>
      <div className="course-progress-fact"><span>ДОСТУП</span><div className="course-progress-fact-highlight"><strong>Материалы останутся после завершения</strong><small>Записи, уроки и проверенные работы будут сохранены в профиле.</small></div></div>
    </section>}

    <div className="assignment-filter course-track-toggle" role="tablist" aria-label="Раздел практикума">
      <button type="button" role="tab" aria-selected={courseTrack === "theory"} className={`filter-chip ${courseTrack === "theory" ? "active" : ""}`} onClick={() => { setCourseTrack("theory"); setHasUserSelectedModule(false); }}>Теория</button>
      <button type="button" role="tab" aria-selected={courseTrack === "practice"} className={`filter-chip ${courseTrack === "practice" ? "active" : ""}`} onClick={() => { setCourseTrack("practice"); setHasUserSelectedModule(false); }}>Практика</button>
      {isAdvancedViewer && <button type="button" role="tab" aria-selected={courseTrack === "advanced"} className={`filter-chip ${courseTrack === "advanced" ? "active" : ""}`} onClick={() => { setCourseTrack("advanced"); setHasUserSelectedModule(false); }}>Advanced</button>}
    </div>

    <div className="course-workspace"><section className="content-panel course-map"><div className="section-heading"><div><h2>{courseTrack === "practice" ? "Структура практики" : courseTrack === "advanced" ? "Структура Advanced" : "Структура курса"}</h2></div><span className="progress-inline">{pluralizeLessons(practicumModules.length)}</span></div>{practicumModules.length === 0 ? <div className="empty-state compact"><BookOpen size={20} /><strong>Уроков пока нет</strong><span>{courseTrack === "practice" ? "Появятся, когда начнётся практика." : courseTrack === "advanced" ? "Куратор ещё не добавил уроки Advanced." : "Появятся, когда куратор опубликует программу."}</span></div> : <><div className="module-sections">{sectionOrder.map((section) => { const sectionModules = practicumModules.filter((module) => module.section === section); return <section className="module-section" key={section}><div className="module-section-heading"><strong>{section}</strong><span>{pluralizeLessons(sectionModules.length)}</span></div><div className="module-list">{sectionModules.map((module) => { const unlocked = unlockedModuleIds.has(module.id); return <button className={`module-row ${hasUserSelectedModule && selectedModule.id === module.id ? "selected" : ""} ${unlocked ? "" : "locked"}`} key={module.id} onClick={() => { if (unlocked) { setSelectedId(module.id); setSelectedContentId(`${module.id}-lesson`); setOpenedModuleId(module.id); setHasUserSelectedModule(true); } }} aria-pressed={hasUserSelectedModule && selectedModule.id === module.id} disabled={!unlocked}><div className="module-copy"><strong>{module.title}</strong><span>{unlocked ? module.status : "Закрыт"} · {pluralizeMaterials(module.lessons)}</span></div><div className="module-progress"><span>{module.progress}%</span><i><b style={{ width: `${module.progress}%` }} /></i></div>{unlocked ? <ChevronRight size={16} /> : <LockKeyhole size={15} />}</button>; })}</div></section>; })}</div><div className="course-map-footer"><span>Закрытые уроки откроются после завершения предыдущего этапа и разблокировки куратором.</span><button className="text-button" onClick={() => { setSelectedId("week-1"); setSelectedContentId("week-1-lesson"); setHasUserSelectedModule(true); }}>Вернуться к текущему <ChevronRight size={15} /></button></div></>}</section><section className="content-panel module-detail">{!selectedModule ? <div className="empty-state"><Target size={22} /><strong>Здесь появятся детали урока</strong><span>{courseTrack === "practice" ? "Как только откроется первый урок практики, тут будут запись, материалы и задание." : courseTrack === "advanced" ? "Как только откроется первый урок Advanced, тут будут запись и материалы." : "Как только куратор опубликует первый урок, тут будут запись, материалы и задание."}</span></div> : <><div className="module-detail-head"><div><span className="section-kicker">УРОК {selectedModule.number}</span><h2>{selectedModule.title}</h2></div>{moduleUnlocked ? <Target size={19} className="heading-icon" /> : <LockKeyhole size={19} className="heading-icon" />}</div><div className="module-detail-body"><div className="module-detail-summary"><div className="module-progress-large"><strong>{selectedModule.progress}%</strong><span>пройдено</span></div><p>{selectedModule.description}</p></div><div className="module-detail-meta"><span><BookOpen size={14} /> {pluralizeMaterials(selectedModule.lessons)}</span><span><FileCheck2 size={14} /> {moduleUnlocked ? "Материалы доступны" : "Доступ ограничен"}</span></div><div className="module-content-block"><div className="module-content-heading"><span>СОДЕРЖАНИЕ УРОКА</span><small>{moduleContents.length === 0 ? "пока пусто" : `${moduleContents.length} элемента`}</small></div>{moduleContents.length === 0 ? <div className="module-empty-copy">Куратор ещё не добавил сюда запись, стрим или задание.</div> : <><div className="module-content-list">{moduleContents.map((item) => <button className={`module-content-item ${item.tone} ${selectedContent?.id === item.id ? "selected" : ""}`} key={item.id} onClick={() => setSelectedContentId(item.id)} disabled={!moduleUnlocked}><span className="module-content-kind">{item.kind}</span><span className="module-content-copy"><strong>{item.title}</strong><small>{item.meta}</small></span><ChevronRight size={16} /></button>)}</div><div className="module-content-preview"><span>ВЫБРАНО</span><strong>{selectedContent?.title}</strong><small>{selectedContent?.kind} · {selectedContent?.meta} · Откроется внутри платформы</small></div></>}</div><div className="module-steps"><span className="detail-label">КАК ПРОХОДИТ УРОК</span>{moduleSteps.map((step, index) => <div className={`module-step ${step.complete ? "complete" : ""} ${moduleUnlocked ? "" : "locked"}`} key={step.label}><div className="module-step-icon">{moduleUnlocked ? step.icon : <LockKeyhole size={15} />}</div><div><strong>{String(index + 1).padStart(2, "0")} · {step.label}</strong><span>{step.description}</span></div><small>{moduleUnlocked ? (step.complete ? "Готово" : "Дальше") : "Закрыто"}</small></div>)}</div>{moduleUnlocked ? <><div className="next-lesson"><span className="section-kicker">СЛЕДУЮЩИЙ ШАГ</span><strong>{selectedModule.progress === 100 ? "Повторить ключевые уроки" : "Продолжить с последнего урока"}</strong><span>{continued ? "Шаг отмечен для продолжения" : "Материалы и прогресс сохранятся в профиле"}</span></div><button className="primary-button open-module-button" onClick={() => setContinued(true)}><span>{continued ? "Продолжение открыто" : selectedModule.progress === 100 ? "Открыть урок" : "Продолжить обучение"}</span><span className="open-module-button-arrow" aria-hidden="true"><ChevronRight size={17} /></span></button></> : <div className="locked-note"><LockKeyhole size={17} /><div><strong>Урок пока закрыт</strong><span>Дождись разблокировки куратором, чтобы открыть материалы.</span></div></div>}</div></>}</section></div>
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

function ModuleOverviewPage({ module, content: courseContent, practicumCompleted, onOpenAssignment, onOpenDiscussion, onBack }: { module: PracticumModule; content?: CourseApiModule; practicumCompleted: boolean; onOpenAssignment: (assignmentId: string) => void; onOpenDiscussion: (context: DiscussionContext) => void; onBack: () => void }) {
  const baseContent = modulePageContentFor(module);
  const assignments = courseContent?.assignments ?? [];
  const hasRealAssignments = assignments.length > 0;
  // Same distinction as moduleContentFor: courseContent is only undefined in the total-API-outage
  // fallback — a real, genuinely assignment-less module still has a courseContent entry.
  const isOfflineDemo = courseContent === undefined;
  const [discussionOpened, setDiscussionOpened] = useState(false);
  const mediaEntries = (courseContent?.media ?? []).filter((media) => media.status === "PUBLISHED" && media.embedUrl);
  const thematicMediaEntries = mediaEntries.filter((media) => media.kind !== "QA");
  const qaMediaEntries = mediaEntries.filter((media) => media.kind === "QA");
  // Same "no block required" rule as the curator's own lesson editor — see ungroupedMedia there.
  const ungroupedMediaEntries = mediaEntries.filter((media) => !media.groupId && media.kind !== "QA");
  const practiceBlocks = courseContent?.mediaGroups ?? [];
  // Real, per-lesson curator-written prompts (Module.qaQuestions) — the old hardcoded demo list
  // only stands in for a total API outage, same as baseContent.homework above.
  const qaQuestionsToShow = courseContent?.qaQuestions.length ? courseContent.qaQuestions : isOfflineDemo ? baseContent.questions : [];
  useEffect(() => {
    if (!discussionOpened) return;
    onOpenDiscussion({ module: `${module.number} · ${module.title}`, coverPath: module.coverPath, moduleId: module.id, practicumCompleted });
  }, [discussionOpened, module.coverPath, module.id, module.number, module.title, practicumCompleted, onOpenDiscussion]);

  return <div className="module-page">
    <div className="module-page-toolbar"><button className="secondary-button" onClick={onBack}><ArrowLeft size={16} /> Вернуться к структуре</button><span className="module-page-breadcrumb">{module.section} / {module.title}</span></div>
    <header className="module-page-header"><div><span className="eyebrow"><BookOpen size={14} /> УРОК {module.number}</span><h2>{module.title}</h2><p>{module.description}</p></div>{!isBlockLayoutSection(module.section) && <div className="module-page-progress"><strong>{module.progress}%</strong><span>пройдено</span><i><b style={{ width: `${module.progress}%` }} /></i></div>}</header>
    {isBlockLayoutSection(module.section) ? <div className="module-resource-grid practice-lesson-layout">
      {(ungroupedMediaEntries.length > 0 || practiceBlocks.length === 0) && <section className="module-resource-card module-block-card"><div className="module-resource-heading"><Play size={17} /><h3>Материалы урока</h3></div>{ungroupedMediaEntries.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Записей пока нет</strong><span>Куратор скоро добавит сюда записи.</span></div> : <div className="module-video-stack">{[...ungroupedMediaEntries].reverse().map((media) => <div className="module-video-item" key={media.id}><div className="module-video-heading"><span className="module-video-label">{media.title ?? module.title}</span><span className="stream-duration">{formatDuration(media.durationSec)}</span></div><div className="module-video-stage">{media.embedUrl && <TrackedVideo mediaId={media.id} src={media.embedUrl} title={media.title ?? module.title} />}</div><ArchivedChatPanel mediaId={media.id} /></div>)}</div>}</section>}
      {practiceBlocks.map((group) => { const groupMedia = group.media.filter((media) => media.status === "PUBLISHED" && media.embedUrl); return <section className="module-resource-card module-block-card" key={group.id}><div className="module-resource-heading"><Play size={17} /><h3>{group.title}</h3><span>{groupMedia.length} {groupMedia.length === 1 ? "запись" : "записей"}</span></div>{groupMedia.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Записей пока нет</strong><span>Куратор опубликует их по ходу этого урока.</span></div> : <div className="module-video-stack">{[...groupMedia].reverse().map((media) => <div className="module-video-item" key={media.id}><div className="module-video-heading"><span className="module-video-label">{media.title ?? group.title}</span><span className="stream-duration">{formatDuration(media.durationSec)}</span></div><div className="module-video-stage">{media.embedUrl && <TrackedVideo mediaId={media.id} src={media.embedUrl} title={media.title ?? group.title} />}</div><ArchivedChatPanel mediaId={media.id} /></div>)}</div>}</section>; })}
      <section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>{qaMediaEntries.length} {qaMediaEntries.length === 1 ? "запись" : "записей"}</span></div>{qaMediaEntries.length > 0 && <div className="module-video-stack">{qaMediaEntries.map((media) => <div className="module-video-item" key={media.id}><div className="module-qa-video-stage">{media.embedUrl && <TrackedVideo mediaId={media.id} src={media.embedUrl} title={media.title ?? "Q&A с куратором"} />}<span>{media.title ?? "Q&A с куратором"}</span></div><ArchivedChatPanel mediaId={media.id} /></div>)}</div>}{qaQuestionsToShow.length > 0 && <ul>{qaQuestionsToShow.map((question) => <li key={question}>{question}</li>)}</ul>}{practicumCompleted ? <div className="module-action-feedback">Поток завершён — новые вопросы уже не задать, но переписка с куратором осталась доступна для чтения.</div> : <button className="secondary-button resource-action-button" onClick={() => setDiscussionOpened((current) => !current)}><span>{discussionOpened ? "Обсуждение открыто" : "Открыть обсуждение"}</span><span className="resource-action-button-arrow" aria-hidden="true"><ChevronRight size={16} /></span></button>}{qaMediaEntries.length === 0 && <div className="module-action-feedback">Здесь появится Q&A-запись, когда куратор добавит её к этому уроку.</div>}</section>
    </div> : <div className="module-resource-grid">
      <section className="module-resource-card module-stream-card"><div className="module-resource-heading"><Play size={17} /><h3>Тематические записи</h3><span>{thematicMediaEntries.length} {thematicMediaEntries.length === 1 ? "запись" : "записей"}</span></div>{thematicMediaEntries.length === 0 ? <div className="module-media-empty"><Play size={20} /><strong>Тематических записей пока нет</strong><span>Куратор опубликует их по ходу этого урока.</span></div> : <div className="module-video-stack">{thematicMediaEntries.map((media) => <div className="module-video-item" key={media.id}><div className="module-video-heading"><span className="module-video-label">{media.title ?? module.title}</span><span className="stream-duration">{formatDuration(media.durationSec)}</span></div><div className="module-video-stage">{media.embedUrl && <TrackedVideo mediaId={media.id} src={media.embedUrl} title={media.title ?? module.title} />}</div><ArchivedChatPanel mediaId={media.id} /></div>)}</div>}</section>
      <section className="module-resource-card module-homework-card"><div className="module-resource-heading"><FileCheck2 size={17} /><h3>Домашнее задание</h3><span>{hasRealAssignments ? (assignments.length === 1 ? "1 задание" : `${assignments.length} задания`) : isOfflineDemo ? `${baseContent.homework.length} пункта` : "0 заданий"}</span></div>{hasRealAssignments ? <div className="curator-assignment-list">{assignments.map((assignment) => <article className="curator-assignment-card" key={assignment.id}><div><strong>{assignment.title}</strong><p>{assignment.description}</p></div>{assignment.requirements.length > 0 && <ol>{assignment.requirements.map((requirement, index) => <li key={`${assignment.id}-${index}`}>{requirement}</li>)}</ol>}<AssignmentMaterialsInline materials={assignment.materials} /><button className="primary-button resource-action-button" onClick={() => onOpenAssignment(assignment.id)}><span>Открыть задание</span><span className="resource-action-button-arrow" aria-hidden="true"><ChevronRight size={16} /></span></button></article>)}</div> : isOfflineDemo ? <><ol>{baseContent.homework.map((item) => <li key={item}>{item}</li>)}</ol><p className="module-resource-note">К каждому вопросу требуется как текстовое описание, так и схема с графическим описанием вопроса.</p><button className="primary-button resource-action-button" onClick={() => onOpenAssignment("")}><span>Открыть задание</span><span className="resource-action-button-arrow" aria-hidden="true"><ChevronRight size={16} /></span></button></> : <div className="module-empty-copy">В этом уроке пока нет домашних заданий.</div>}</section>
      <section className="module-resource-card module-qa-card"><div className="module-resource-heading"><MessageSquareText size={17} /><h3>Q&A с куратором</h3><span>{qaMediaEntries.length} {qaMediaEntries.length === 1 ? "запись" : "записей"}</span></div>{qaMediaEntries.length > 0 && <div className="module-video-stack">{qaMediaEntries.map((media) => <div className="module-video-item" key={media.id}><div className="module-qa-video-stage">{media.embedUrl && <TrackedVideo mediaId={media.id} src={media.embedUrl} title={media.title ?? "Q&A с куратором"} />}<span>{media.title ?? "Q&A с куратором"}</span></div><ArchivedChatPanel mediaId={media.id} /></div>)}</div>}{qaQuestionsToShow.length > 0 && <ul>{qaQuestionsToShow.map((question) => <li key={question}>{question}</li>)}</ul>}{practicumCompleted ? <div className="module-action-feedback">Поток завершён — новые вопросы уже не задать, но переписка с куратором осталась доступна для чтения.</div> : <button className="secondary-button resource-action-button" onClick={() => setDiscussionOpened((current) => !current)}><span>{discussionOpened ? "Обсуждение открыто" : "Открыть обсуждение"}</span><span className="resource-action-button-arrow" aria-hidden="true"><ChevronRight size={16} /></span></button>}{qaMediaEntries.length === 0 && <div className="module-action-feedback">Здесь появится Q&A-запись, когда куратор добавит её к этому уроку.</div>}</section>
    </div>}
  </div>;
}

function AssignmentsView({ requestedAssignmentId = "", onOpenDiscussion }: { requestedAssignmentId?: string; onOpenDiscussion: (context: DiscussionContext) => void }) {
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

  return <div className="assignment-workspace"><section className="content-panel assignment-inbox"><div className="section-heading"><div><h2>Мои задания</h2></div></div><div className="assignment-filter">{filters.map((item) => { const count = item.id === "all" ? allAssignments.length : allAssignments.filter((assignment) => assignment.status === item.id).length; return <button className={`filter-chip ${filter === item.id ? "active" : ""}`} key={item.id} onClick={() => setFilter(item.id)} aria-pressed={filter === item.id}>{item.label} <span>{count}</span></button>; })}</div><div className="assignment-list">{filteredAssignments.length > 0 ? filteredAssignments.map((assignment) => <AssignmentRow assignment={assignment} key={assignment.id} selected={assignment.id === selectedAssignment.id} onOpen={() => setSelectedId(assignment.id)} />) : <div className="empty-state"><FileCheck2 size={22} /><strong>В этом фильтре пока пусто</strong><span>Новые статусы появятся после отправки работы или проверки куратором.</span></div>}</div></section><AssignmentDetail assignment={selectedAssignment} onOpenDiscussion={onOpenDiscussion} key={selectedAssignment.id} /></div>;
}

type ScheduleApiEvent = CourseScheduleEvent;

function scheduleApiTypeToUi(type: ScheduleApiEvent["type"]): ScheduleEvent["type"] {
  if (type === "QA") return "Q&A";
  if (type === "BREAKDOWN") return "Разбор ДЗ";
  if (type === "BACKTEST") return "Бэктест";
  if (type === "LECTURE") return "Лекция";
  if (type === "PRE_SESSION") return "Пресессия";
  return "Практическая часть";
}

/**
 * Time zone schedule times are shown in — null = as stored (Kyiv). Module-level because
 * scheduleApiToUi is called from many views' fetch callbacks; Home sets it from the session.
 */
let viewerTimeZone: string | null = null;
function setViewerTimeZone(zone: string | null) {
  viewerTimeZone = zone && zone !== EVENT_TIMEZONE ? zone : null;
}

function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || EVENT_TIMEZONE;
    // Older ICU data still reports Kyiv under its pre-2022 spelling.
    return zone === "Europe/Kiev" ? "Europe/Kyiv" : zone;
  } catch {
    return EVENT_TIMEZONE;
  }
}

/** UTC instant → { date "YYYY-MM-DD", time "HH:MM" } as seen in `timeZone`. */
function wallClockIn(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/**
 * Kyiv "YYYY-MM-DD" + "13:00 — 14:00" → the same moment in the viewer's zone. Converted per event
 * date, so a different DST schedule (Kyiv switches, Kazakhstan doesn't) is right on both sides of
 * the switch. Free-text times that aren't "HH:MM[ — HH:MM]" are left as typed.
 */
export function convertEventTime(date: string, time: string, timeZone: string): { date: string; time: string } | null {
  const match = time.match(/^\s*(\d{1,2}:\d{2})\s*(?:[—–-]\s*(\d{1,2}:\d{2}))?\s*$/);
  if (!match) return null;
  const start = wallClockIn(zonedTimeToUtc(date, match[1]), timeZone);
  const end = match[2] ? wallClockIn(zonedTimeToUtc(date, match[2]), timeZone) : null;
  return { date: start.date, time: end ? `${start.time} — ${end.time}` : start.time };
}

/** Common zones for this audience, labelled "Страна — город" (the IANA id carries the DST rules). */
const COMMON_TIME_ZONES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "Europe/Kyiv", label: "Украина — Киев" },
  { id: "Europe/Warsaw", label: "Польша — Варшава" },
  { id: "Europe/Berlin", label: "Германия — Берлин" },
  { id: "Europe/Prague", label: "Чехия — Прага" },
  { id: "Europe/Vienna", label: "Австрия — Вена" },
  { id: "Europe/Bratislava", label: "Словакия — Братислава" },
  { id: "Europe/Budapest", label: "Венгрия — Будапешт" },
  { id: "Europe/Bucharest", label: "Румыния — Бухарест" },
  { id: "Europe/Chisinau", label: "Молдова — Кишинёв" },
  { id: "Europe/Vilnius", label: "Литва — Вильнюс" },
  { id: "Europe/Riga", label: "Латвия — Рига" },
  { id: "Europe/Tallinn", label: "Эстония — Таллин" },
  { id: "Europe/Helsinki", label: "Финляндия — Хельсинки" },
  { id: "Europe/Stockholm", label: "Швеция — Стокгольм" },
  { id: "Europe/Oslo", label: "Норвегия — Осло" },
  { id: "Europe/Copenhagen", label: "Дания — Копенгаген" },
  { id: "Europe/Amsterdam", label: "Нидерланды — Амстердам" },
  { id: "Europe/Brussels", label: "Бельгия — Брюссель" },
  { id: "Europe/Paris", label: "Франция — Париж" },
  { id: "Europe/Zurich", label: "Швейцария — Цюрих" },
  { id: "Europe/Rome", label: "Италия — Рим" },
  { id: "Europe/Madrid", label: "Испания — Мадрид" },
  { id: "Europe/Lisbon", label: "Португалия — Лиссабон" },
  { id: "Europe/London", label: "Великобритания — Лондон" },
  { id: "Europe/Dublin", label: "Ирландия — Дублин" },
  { id: "Europe/Athens", label: "Греция — Афины" },
  { id: "Asia/Nicosia", label: "Кипр — Никосия" },
  { id: "Europe/Istanbul", label: "Турция — Стамбул" },
  { id: "Asia/Tbilisi", label: "Грузия — Тбилиси" },
  { id: "Asia/Yerevan", label: "Армения — Ереван" },
  { id: "Asia/Baku", label: "Азербайджан — Баку" },
  { id: "Asia/Jerusalem", label: "Израиль — Иерусалим" },
  { id: "Asia/Dubai", label: "ОАЭ — Дубай" },
  { id: "Asia/Almaty", label: "Казахстан — Алматы" },
  { id: "Asia/Tashkent", label: "Узбекистан — Ташкент" },
  { id: "Asia/Bishkek", label: "Кыргызстан — Бишкек" },
  { id: "Asia/Bangkok", label: "Таиланд — Бангкок" },
  { id: "Asia/Makassar", label: "Индонезия — Бали" },
  { id: "Asia/Singapore", label: "Сингапур" },
  { id: "Asia/Tokyo", label: "Япония — Токио" },
  { id: "America/New_York", label: "США — Нью-Йорк" },
  { id: "America/Chicago", label: "США — Чикаго" },
  { id: "America/Denver", label: "США — Денвер" },
  { id: "America/Los_Angeles", label: "США — Лос-Анджелес" },
  { id: "America/Toronto", label: "Канада — Торонто" },
  { id: "America/Vancouver", label: "Канада — Ванкувер" },
  { id: "America/Mexico_City", label: "Мексика — Мехико" },
  { id: "America/Sao_Paulo", label: "Бразилия — Сан-Паулу" },
  { id: "America/Argentina/Buenos_Aires", label: "Аргентина — Буэнос-Айрес" },
  { id: "Australia/Sydney", label: "Австралия — Сидней" },
];

function timeZoneTitle(zone: string): string {
  return COMMON_TIME_ZONES.find((item) => item.id === zone)?.label ?? zone.replace(/_/g, " ");
}

function allTimeZones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? []; } catch { return []; }
}

/** The reverse of convertEventTime: a curator's own-zone form input → Kyiv date/time for storage. */
export function convertToKyivTime(date: string, time: string, timeZone: string): { date: string; time: string } | null {
  const match = time.match(/^\s*(\d{1,2}:\d{2})\s*(?:[—–-]\s*(\d{1,2}:\d{2}))?\s*$/);
  if (!match) return null;
  const start = wallClockIn(zonedTimeToUtc(date, match[1], timeZone), EVENT_TIMEZONE);
  const end = match[2] ? wallClockIn(zonedTimeToUtc(date, match[2], timeZone), EVENT_TIMEZONE) : null;
  return { date: start.date, time: end ? `${start.time} — ${end.time}` : start.time };
}

/** "UTC+2" style offset of `timeZone` right now — for labels. */
function timeZoneOffsetLabel(timeZone: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    return name.replace("GMT", "UTC").replace(/^UTC$/, "UTC+0");
  } catch {
    return "";
  }
}

function scheduleApiToUi(event: ScheduleApiEvent): ScheduleEvent {
  const converted = viewerTimeZone ? convertEventTime(event.date, event.time, viewerTimeZone) : null;
  const kyivTimeLabel = converted && (converted.time !== event.time || converted.date !== event.date) ? event.time : undefined;
  if (converted && kyivTimeLabel) {
    return { ...scheduleApiToUiAsStored({ ...event, date: converted.date, time: converted.time }), kyivDate: event.date, kyivTime: event.time, kyivTimeLabel };
  }
  return scheduleApiToUiAsStored(event);
}

function scheduleApiToUiAsStored(event: ScheduleApiEvent): ScheduleEvent {
  const parsedDate = new Date(`${event.date}T12:00:00`);
  return { id: event.id, date: event.date, day: event.date.slice(-2), month: parsedDate.toLocaleDateString("ru-RU", { month: "short" }).replace(".", "").toUpperCase(), weekday: parsedDate.toLocaleDateString("ru-RU", { weekday: "long" }), type: scheduleApiTypeToUi(event.type), title: event.title, time: event.time, live: event.live, description: event.description, recordingAvailable: event.recordingAvailable, recordingIds: event.recordings.filter((recording) => recording.status === "PUBLISHED").map((recording) => recording.id), coverPath: event.coverPath ?? undefined, bookedByStudentId: event.bookedByStudentId, bookedByStudentName: event.bookedByStudentName, isBookedByActor: event.isBookedByActor, slotLimit: event.slotLimit , streamEndedAt: event.streamEndedAt ?? null };
}

function scheduleUiTypeToApi(type: ScheduleEvent["type"]): "PRACTICE" | "QA" | "BREAKDOWN" | "BACKTEST" | "LECTURE" | "PRE_SESSION" {
  if (type === "Q&A") return "QA";
  if (type === "Разбор ДЗ") return "BREAKDOWN";
  if (type === "Бэктест") return "BACKTEST";
  if (type === "Лекция") return "LECTURE";
  if (type === "Пресессия") return "PRE_SESSION";
  return "PRACTICE";
}

function ScheduleView({ onOpenStreams, onJoinLive }: { onOpenStreams: (recordingId?: string) => void; onJoinLive: () => void }) {
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [bookingEventId, setBookingEventId] = useState("");
  const [bookingError, setBookingError] = useState("");
  const [liveScheduleEventId, setLiveScheduleEventId] = useState<string | null>(null);
  const selectedEvent = events.find((event) => event.id === selectedId) ?? events[0];
  const detailsEvent = events.find((event) => event.id === detailsId);
  const hasReachedSlotLimit = (type: ScheduleEvent["type"]) => {
    const limit = events.find((event) => event.type === type)?.slotLimit ?? null;
    if (limit === null) return false;
    return events.filter((event) => event.type === type && event.isBookedByActor).length >= limit;
  };
  // Slots someone else has already taken, and events whose day has already passed, clutter
  // the "Участие" list — the calendar grid still shows them (so a day's own history stays
  // browsable: click a past day's event for details and a link to the recording), but this
  // side list only surfaces what's still upcoming, or a taken slot the viewer holds themselves.
  const todayKey = toDateKey(new Date());
  const visibleEvents = events.filter((event) => (!isBookableSlotType(event.type) || !event.bookedByStudentId || event.isBookedByActor) && event.date >= todayKey);
  useEffect(() => {
    const load = async () => {
      const response = await fetch(`${API_ORIGIN}/api/schedule`, { credentials: "include", cache: "no-store" });
      if (!response.ok) return;
      const payload = await response.json() as { data?: ScheduleApiEvent[] };
      if (Array.isArray(payload.data)) setEvents(payload.data.map(scheduleApiToUi));
    };
    void load().catch(() => undefined);
  }, []);
  useEffect(() => {
    const refreshLiveStatus = async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json() as { data?: { liveScheduleEventId: string | null } };
        setLiveScheduleEventId(payload.data?.liveScheduleEventId ?? null);
      } catch { /* keep last known state */ }
    };
    void refreshLiveStatus();
    const poll = window.setInterval(() => { void refreshLiveStatus(); }, 15_000);
    return () => window.clearInterval(poll);
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

  return <>{<div className="calendar-layout"><section className="content-panel calendar-panel"><CalendarGrid events={events} selectedId={selectedId} onSelect={openEvent} /></section><section className="content-panel calendar-events"><div className="section-heading"><div><span className="section-kicker">СОБЫТИЯ</span><h2>Участие</h2><span className="section-count">Время указано по Киеву</span></div><CalendarDays size={18} className="heading-icon" /></div>{bookingError && <div className="file-error" role="alert">{bookingError}</div>}{visibleEvents.length > 0 ? visibleEvents.map((event) => <ScheduleEventCard event={event} selected={event.id === selectedEvent?.id} liveNow={event.id === liveScheduleEventId} onOpen={() => openEvent(event.id)} onOpenStreams={onOpenStreams} onJoinLive={onJoinLive} onBook={() => void runBooking(event.id, "book")} onCancelBooking={() => void runBooking(event.id, "cancel-booking")} bookingBusy={bookingEventId === event.id} hasReachedSlotLimit={hasReachedSlotLimit(event.type)} key={event.id} />) : <div className="empty-state"><CalendarDays size={22} /><strong>Событий пока нет</strong><span>Куратор ещё не опубликовал встречи потока — они появятся здесь.</span></div>}</section></div>}{detailsEvent && <RichScheduleEventDetails event={detailsEvent} liveNow={detailsEvent.id === liveScheduleEventId} onOpenStreams={onOpenStreams} onJoinLive={onJoinLive} onBook={() => void runBooking(detailsEvent.id, "book")} onCancelBooking={() => void runBooking(detailsEvent.id, "cancel-booking")} bookingBusy={bookingEventId === detailsEvent.id} hasReachedSlotLimit={hasReachedSlotLimit(detailsEvent.type)} onClose={() => setDetailsId(null)} />}</>;
}

function CalendarGrid({ events, selectedId, onSelect, onDateSelect }: { events: readonly ScheduleEvent[]; selectedId: string; onSelect: (eventId: string) => void; onDateSelect?: (date: string) => void }) {
  const [currentMonth, setCurrentMonth] = useState(() => startOfMonth(new Date()));
  const days = buildCalendarDays(currentMonth);
  const todayKey = toDateKey(new Date());
  const eventsByDate = new Map<string, ScheduleEvent[]>();
  for (const event of events) eventsByDate.set(event.date, [...(eventsByDate.get(event.date) ?? []), event]);
  const shiftMonth = (amount: number) => setCurrentMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));

  return <><div className="calendar-toolbar"><div><span className="section-kicker">РАСПИСАНИЕ ПОТОКА</span><h2>{formatCalendarMonth(currentMonth)}</h2></div><div className="calendar-controls"><button className="icon-button compact" aria-label="Предыдущий месяц" onClick={() => shiftMonth(-1)}><ChevronRight size={16} className="rotate-left" /></button><button className="today-button" onClick={() => setCurrentMonth(startOfMonth(new Date()))}>Сегодня</button><button className="icon-button compact" aria-label="Следующий месяц" onClick={() => shiftMonth(1)}><ChevronRight size={16} /></button></div></div><div className="calendar-weekdays"><span>ПН</span><span>ВТ</span><span>СР</span><span>ЧТ</span><span>ПТ</span><span>СБ</span><span>ВС</span></div><div className="calendar-grid">{days.map(({ date, isOutside }) => { const dateKey = toDateKey(date); const dayEvents = [...(eventsByDate.get(dateKey) ?? [])].sort((a, b) => startMinutes(a.time) - startMinutes(b.time)); const isToday = dateKey === todayKey; return <div className={`calendar-day ${isToday ? "today" : ""} ${isOutside ? "outside" : ""} ${dayEvents.length > 0 ? "has-event" : ""}`} key={dateKey} aria-label={dayEvents.length > 0 ? `${formatEventDate(dateKey)}: ${dayEvents.map((event) => `${event.time} ${event.title}`).join(", ")}` : formatEventDate(dateKey)} onClick={() => onDateSelect?.(dateKey)}><span className="calendar-day-number">{date.getDate()}</span>{dayEvents.map((event) => { const bookingClass = isBookableSlotType(event.type) ? (event.bookedByStudentId ? "is-booked" : "is-open") : ""; const startTime = event.time.match(/^\d{1,2}:\d{2}/)?.[0] ?? event.time; return <button className={`calendar-event ${eventTone(event)} ${bookingClass} ${event.id === selectedId ? "selected" : ""}`} key={event.id} onClick={(clickEvent) => { clickEvent.stopPropagation(); onSelect(event.id); }}><span>{startTime} · {event.type}</span><strong>{event.title}</strong></button>; })}</div>; })}</div></>;
}

function RichScheduleEventDetails({ event, liveNow, onOpenStreams: navigateToStreams, onJoinLive, onBook, onCancelBooking, bookingBusy, hasReachedSlotLimit, onClose }: { event: ScheduleEvent; liveNow: boolean; onOpenStreams: (recordingId?: string) => void; onJoinLive: () => void; onBook: () => void; onCancelBooking: () => void; bookingBusy: boolean; hasReachedSlotLimit: boolean; onClose: () => void }) {
  const formattedDate = formatEventDate(event.date);
  const coverPath = eventCoverPath(event);
  const isBookable = isBookableSlotType(event.type);
  // Mirrors the server-side date lock in schedule-service.ts (book/cancelBooking) — a past slot
  // can no longer be self-booked or self-cancelled, only released by a curator, so the button
  // shouldn't invite a click that the API will just reject.
  const isPastEvent = toDateKey(event.date) < toDateKey(new Date());
  const onOpenStreams = () => {
    const recordingId = event.recordingIds?.[0];
    if (recordingId && typeof window !== "undefined") window.sessionStorage.setItem("fix-target-stream", recordingId);
    navigateToStreams(recordingId);
  };
  useEffect(() => { const handleKeyDown = (keyboardEvent: KeyboardEvent) => { if (keyboardEvent.key === "Escape") onClose(); }; window.addEventListener("keydown", handleKeyDown); return () => window.removeEventListener("keydown", handleKeyDown); }, [onClose]);
  let footerAction: ReactNode;
  const phase = eventBroadcastPhase(event, liveNow);
  if (!isBookable && phase === "live") {
    footerAction = <button className="primary-button is-joined" onClick={() => { onClose(); onJoinLive(); }}>Присоединиться</button>;
  } else if (event.recordingAvailable) {
    footerAction = <button className="primary-button" onClick={() => { onClose(); onOpenStreams(); }}>Открыть запись <Play size={15} /></button>;
  } else if (isBookable) {
    if (event.isBookedByActor) footerAction = isPastEvent
      ? <button className="primary-button is-joined" disabled>Слот прошёл · снять может куратор</button>
      : <button className="primary-button is-joined" onClick={onCancelBooking} disabled={bookingBusy}>{bookingBusy ? "Отменяем…" : "Вы записаны · отменить"}</button>;
    else if (event.bookedByStudentId) footerAction = <button className="primary-button" disabled>Слот уже занят</button>;
    else if (isPastEvent) footerAction = <button className="primary-button" disabled>Дата прошла</button>;
    else if (hasReachedSlotLimit) footerAction = <button className="primary-button" disabled>Слоты этого типа исчерпаны</button>;
    else footerAction = <button className="primary-button" onClick={onBook} disabled={bookingBusy}>{bookingBusy ? "Записываем…" : "Записаться"}</button>;
  } else {
    footerAction = <button className="primary-button" disabled>{phase === "ended" ? "Эфир завершён" : phase === "past" ? "Событие прошло" : "Эфир ещё не начался"}</button>;
  }
  return <div className="event-details-overlay" role="presentation" onMouseDown={(mouseEvent) => { if (mouseEvent.target === mouseEvent.currentTarget) onClose(); }}><section className="event-details-modal rich-event-modal" role="dialog" aria-modal="true" aria-labelledby="rich-schedule-event-title"><div className="rich-event-topbar"><h2 id="rich-schedule-event-title">{event.title}</h2><button className="icon-button compact" aria-label="Закрыть детали события" onClick={onClose}><X size={20} /></button></div>{coverPath && <div className="rich-event-cover" role="img" aria-label={`Обложка события: ${event.title}`} style={{ backgroundImage: `url("${coverPath}")` }} />}<div className="rich-event-tabs"><span className="active">Сведения о событии</span><span>Участники потока</span></div><div className="rich-event-body"><div className="rich-event-date"><Clock3 size={17} /><strong>{event.weekday} · {event.time}</strong>{event.kyivTimeLabel && <span className="event-kyiv-time">по Киеву {event.kyivTimeLabel}</span>}</div><h3>{event.title}</h3><div className="rich-event-line"><span>◉</span><span>Project FIX</span></div><div className="rich-event-line"><CalendarDays size={16} /><span>{formattedDate}</span></div><div className="rich-event-description">{event.description}</div>{isBookable && event.isBookedByActor && <div className="event-recording-note"><Target size={16} /><div><strong>Слот забронирован за вами</strong><span>Куратор свяжется с вами по расписанному времени.</span></div></div>}{event.recordingAvailable && <div className="event-recording-note"><Play size={16} /><div><strong>Запись уже добавлена</strong><span>Запись доступна в разделе «Стримы» и останется там после завершения события.</span></div></div>}{!isBookable && !event.recordingAvailable && phase === "ended" && <div className="event-recording-note"><Play size={16} /><div><strong>Эфир завершён</strong><span>Запись скоро появится — куратор опубликует её здесь после проверки.</span></div></div>}</div><div className="rich-event-footer">{footerAction}</div></section></div>;
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

function ScheduleEventCard({ event, selected, liveNow = false, mode = "student", onOpen, onOpenStreams: navigateToStreams, onJoinLive, onBook, onCancelBooking, bookingBusy = false, hasReachedSlotLimit = false }: {
  event: ScheduleEvent;
  selected: boolean;
  liveNow?: boolean;
  mode?: "student" | "curator";
  onOpen: () => void;
  onOpenStreams?: (recordingId?: string) => void;
  onJoinLive?: () => void;
  onBook?: () => void;
  onCancelBooking?: () => void;
  bookingBusy?: boolean;
  hasReachedSlotLimit?: boolean;
}) {
  const coverPath = eventCoverPath(event);
  const coverStyle = coverPath ? { backgroundImage: `linear-gradient(90deg, #030303 0%, rgba(3,3,3,.97) 58%, rgba(3,3,3,.82) 78%, rgba(3,3,3,.35) 100%), url("${coverPath}")` } : undefined;
  const onOpenStreams = navigateToStreams ? () => {
    const recordingId = event.recordingIds?.[0];
    if (recordingId && typeof window !== "undefined") window.sessionStorage.setItem("fix-target-stream", recordingId);
    navigateToStreams(recordingId);
  } : undefined;
  const isBookable = isBookableSlotType(event.type);
  // See RichScheduleEventDetails — same past-date lock, mirroring the server-side one.
  const isPastEvent = toDateKey(event.date) < toDateKey(new Date());
  const stop = (handler?: () => void) => (clickEvent: ReactMouseEvent<HTMLButtonElement>) => { clickEvent.stopPropagation(); handler?.(); };

  let actionButton: ReactNode;
  const phase = eventBroadcastPhase(event, liveNow);
  if (mode === "curator") {
    actionButton = <button className="event-action" aria-label={`Открыть событие: ${event.title}`} onClick={onOpen}><ArrowUpRight size={17} /></button>;
  } else if (!isBookable && phase === "live") {
    actionButton = <button className="event-register joined" onClick={stop(onJoinLive)}>Присоединиться</button>;
  } else if (event.recordingAvailable) {
    actionButton = <button className="event-register joined" onClick={onOpen}>Смотреть запись</button>;
  } else if (isBookable) {
    if (event.isBookedByActor) actionButton = isPastEvent
      ? <button className="event-register joined" disabled>Слот прошёл</button>
      : <button className="event-register joined" onClick={stop(onCancelBooking)} disabled={bookingBusy}>{bookingBusy ? "…" : "Вы записаны"}</button>;
    else if (event.bookedByStudentId) actionButton = <button className="event-register" disabled>Занято</button>;
    else if (isPastEvent) actionButton = <button className="event-register" disabled>Дата прошла</button>;
    else if (hasReachedSlotLimit) actionButton = <button className="event-register" disabled>Использовано</button>;
    else actionButton = <button className="event-register" onClick={stop(onBook)} disabled={bookingBusy}>{bookingBusy ? "…" : "Записаться"}</button>;
  } else {
    actionButton = <button className="event-register" disabled>{phase === "ended" ? "Эфир завершён" : phase === "past" ? "Прошло" : "Скоро"}</button>;
  }

  return <div className={`event-card schedule-event-card ${coverPath ? "has-cover" : ""} ${selected ? "selected" : ""}`} style={coverStyle}><button className="event-card-main" onClick={onOpen}><div className={`event-date ${eventTone(event)}`}><strong>{event.day}</strong><span>{event.month}</span></div><div className="event-info"><div className="event-type">{event.live && <span className="live-dot" />} {event.type.toUpperCase()}</div><h3>{event.title}</h3><p><Clock3 size={14} /> {event.weekday} · {event.time}{event.kyivTimeLabel && <span className="event-kyiv-time">по Киеву {event.kyivTimeLabel}</span>}</p>{isBookable && mode === "curator" && <p className="event-backtest-status">{event.bookedByStudentName ? `Записан: ${event.bookedByStudentName}` : "Слот свободен"}</p>}{!isBookable && mode === "curator" && event.streamEndedAt && <p className="event-backtest-status">Эфир завершён</p>}</div></button>{actionButton}{mode === "student" && event.recordingAvailable && onOpenStreams && <button className="event-recording-link" onClick={(clickEvent) => { clickEvent.stopPropagation(); onOpenStreams(); }}><Play size={14} /> Запись добавлена · смотреть в «Стримах»</button>}</div>;
}

function eventCoverPath(event: ScheduleEvent): string | undefined {
  if (event.coverPath) return scheduleCoverImageUrl(event.coverPath);
  if (event.type === "Q&A") return "/event-covers/QA.png";
  if (event.type === "Бэктест") return "/event-covers/BACKTEST.png";
  if (event.type === "Практическая часть") return "/event-covers/pre-session-cover.webp";
  if (event.type === "Лекция") return "/event-covers/LECTURE.png";
  return undefined;
}

// event.time is free text the curator types (e.g. "19:00 — 20:30"), not a real time value — a
// plain string sort would misorder "9:00" after "10:00". Parsing just the leading HH:MM into
// minutes sorts correctly regardless of leading zeros; an unparseable value sorts last rather
// than crashing the whole day's order.
function startMinutes(time: string): number {
  const match = time.match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.MAX_SAFE_INTEGER;
}

function eventTone(event: ScheduleEvent) {
  return event.type === "Практическая часть" ? "blue" : event.type === "Q&A" ? "cyan" : "amber";
}

function isBookableSlotType(type: ScheduleEvent["type"]): boolean {
  return type === "Бэктест" || type === "Пресессия";
}

function StudentLiveStreamView({ onNavigate }: { onNavigate: (nextNav: DashboardNav) => void }) {
  const [upcoming, setUpcoming] = useState<ScheduleEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [isFullscreen, setIsFullscreen] = useState(false);
  const liveWrapRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PlaybackStatusDto | null>(null);
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
      const payload = await response.json() as { data?: PlaybackStatusDto };
      if (payload.data) setStatus(payload.data);
    } catch { /* keep last known state */ }
  }, []);

  useEffect(() => {
    void fetch(`${API_ORIGIN}/api/streams/status`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: PlaybackStatusDto };
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

  // Two independent fullscreen entry points: this one (theater mode — video + chat side by
  // side) and the one on the video surface itself (video only). Some viewers want to keep chat
  // visible while fullscreen, others don't — both are kept rather than picking one.
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
            <RecordingBadge status={status} audience="student" />
            <button className="icon-button compact live-room-theater-toggle" type="button" aria-label={isFullscreen ? "Свернуть" : "Видео + чат на весь экран"} onClick={toggleFullscreen}>{isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
          </div>
        </div>
        {status?.isLive && status.viewerToken && status.roomName ? (
          <div className="live-room-player-frame">
            <TrackedVideo livekit={{ token: status.viewerToken, roomName: status.roomName }} title="Прямой эфир" />
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
      {upcoming.length > 0 ? <div className="live-room-upcoming-list">{upcoming.map((event) => <button className="live-room-upcoming-row" type="button" key={event.id} onClick={() => onNavigate("Расписание")}><div><strong>{event.title}</strong><span>{event.weekday}, {formatEventDate(event.date)} · {event.time}{event.kyivTimeLabel ? ` (по Киеву ${event.kyivTimeLabel})` : ""}</span></div><ChevronRight size={16} /></button>)}</div> : <div className="empty-state compact"><CalendarDays size={20} /><strong>Эфиров пока не запланировано</strong><span>Загляни в «Расписание» — там появятся ближайшие встречи.</span></div>}
    </section>
  </div>;
}

// The two "Раздел" buckets that aren't a lesson. Kept as constants because the select below
// groups options by comparing against them.
const SCHEDULE_SCOPE = "Расписание";
const GLOBAL_SCOPE = "Общая медиатека";

// stream.module carries a leading "01 · " index (module.position) so lessons with the same
// title in different tracks stay distinct as filter values and sort in program order — that
// index is plumbing, not something a curator/student needs to read. Stripped wherever the
// scope is actually shown (dropdown options, card meta, player header); the raw value with the
// number stays the <select>'s value/key so filtering and sorting are unaffected.
function stripLessonNumber(scope: string): string {
  return scope.replace(/^\d+\s*·\s*/, "");
}

// Preferred chip order; anything a curator invented (a custom block name) sorts after these.
const CATEGORY_ORDER = ["Бектест", "Пресессия", "WPA", "Разбор", "Q&A", "Урок", "Лекция", "Практика", "Стрим", "Talks"];

/**
 * "Бэктест" (the schedule event type) and "Бектест" (the lesson block preset) are the same thing
 * to a student, so they have to collapse into one chip instead of sitting next to each other as
 * near-identical twins. Anything unrecognised is kept verbatim — a curator can name a block
 * whatever they like and it becomes its own category.
 */
function normalizeCategory(raw: string): string {
  const key = raw.trim().toLowerCase().replace(/[\s\-.]+/g, "");
  if (key === "бэктест" || key === "бектест" || key === "backtest") return "Бектест";
  if (key === "пресессия" || key === "presession" || key === "предсессия") return "Пресессия";
  if (key === "wpa" || key === "впа") return "WPA";
  if (key === "разбор" || key === "разбордз") return "Разбор";
  if (key === "практика" || key === "практическаячасть") return "Практика";
  if (key === "qa" || key === "q&a") return "Q&A";
  return raw.trim();
}

function mediaKindCategory(mediaKind: string): string {
  if (mediaKind === "BREAKDOWN") return "Разбор";
  if (mediaKind === "QA") return "Q&A";
  if (mediaKind === "TALKS") return "Talks";
  if (mediaKind === "LESSON_VIDEO") return "Урок";
  return "Стрим";
}

function scheduleTypeCategory(type: CourseScheduleEvent["type"]): string {
  if (type === "BACKTEST") return "Бектест";
  if (type === "PRE_SESSION") return "Пресессия";
  if (type === "BREAKDOWN") return "Разбор";
  if (type === "QA") return "Q&A";
  if (type === "LECTURE") return "Лекция";
  return "Практика";
}

/**
 * One category per record, resolved from the most specific thing known about it: the lesson block
 * it sits in, else the schedule event it was recorded from, else its media kind. Deliberately a
 * single axis — a student looks for "бектест", not for "стрим, привязанный к уроку 07" — and
 * Advanced stays out of it entirely, because that's an access level, not a topic (it gets its own
 * toggle in the toolbar).
 */
function streamCategoryFor(mediaKind: string, blockTitle?: string | null, eventType?: CourseScheduleEvent["type"]): StreamKind {
  if (blockTitle) return normalizeCategory(blockTitle);
  if (eventType) return scheduleTypeCategory(eventType);
  return mediaKindCategory(mediaKind);
}

function StreamsView() {
  const [filter, setFilter] = useState<"all" | StreamKind>("all");
  const [advancedOnly, setAdvancedOnly] = useState(false);
  const [moduleFilter, setModuleFilter] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [playerOpen, setPlayerOpen] = useState(false);
  const [courseStreams, setCourseStreams] = useState<StreamItem[] | null>(null);
  const [streamsLoadError, setStreamsLoadError] = useState("");
  const [isAdvanced, setIsAdvanced] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/course`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (cancelled) return;
      if (!response.ok) { setStreamsLoadError("Не удалось загрузить записи. Показаны демонстрационные данные."); return; }
       const payload = await response.json() as { data?: { modules?: CourseApiModule[]; media?: CourseLessonMedia[]; scheduleEvents?: CourseScheduleEvent[]; isAdvanced?: boolean } };
       setIsAdvanced(payload.data?.isAdvanced ?? false);
       const lessonStreams: Array<StreamItem & { sortAt: number }> = (payload.data?.modules ?? []).flatMap((module) => module.media.filter((media) => media.status === "PUBLISHED" && media.embedUrl).map((media) => ({
         id: media.id,
         title: media.title ?? module.title,
         kind: streamCategoryFor(media.kind, media.groupId ? module.mediaGroups?.find((group) => group.id === media.groupId)?.title : null),
         // Two independent ways a recording ends up Advanced-only: tagged as such itself, or
         // sitting in an Advanced-section lesson (which non-Advanced students never receive at
         // all). The toggle has to cover both, or it reads "0" next to a visible Advanced record.
         advanced: media.audience === "ADVANCED" || module.section === "Advanced",
        module: `${String(module.position).padStart(2, "0")} · ${module.title}`,
        date: media.publishedAt ? new Date(media.publishedAt).toLocaleDateString("ru-RU") : "Опубликовано",
        sortAt: media.publishedAt ? new Date(media.publishedAt).getTime() : 0,
        duration: formatDuration(media.durationSec),
        description: media.description ?? `Запись урока «${module.title}».`,
        cover: media.thumbnailUrl,
        isNew: Boolean(media.publishedAt && Date.now() - new Date(media.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000),
        embedUrl: media.embedUrl,
       })));
       const globalStreams: Array<StreamItem & { sortAt: number }> = (payload.data?.media ?? []).filter((media) => media.status === "PUBLISHED" && media.embedUrl).map((media) => ({
         id: media.id,
         title: media.title ?? "Talks",
         kind: streamCategoryFor(media.kind),
         advanced: media.audience === "ADVANCED",
         module: GLOBAL_SCOPE,
         date: media.publishedAt ? new Date(media.publishedAt).toLocaleDateString("ru-RU") : "Опубликовано",
         sortAt: media.publishedAt ? new Date(media.publishedAt).getTime() : 0,
         duration: formatDuration(media.durationSec),
         description: media.description ?? "Свободная встреча и общение с командой.",
         cover: media.thumbnailUrl,
         isNew: Boolean(media.publishedAt && Date.now() - new Date(media.publishedAt).getTime() < 7 * 24 * 60 * 60 * 1000),
         embedUrl: media.embedUrl,
       }));
       const scheduleStreams: Array<StreamItem & { sortAt: number }> = (payload.data?.scheduleEvents ?? []).flatMap((event) => event.recordings.filter((recording) => recording.status === "PUBLISHED" && recording.embedUrl).map((recording) => ({
         id: recording.id,
         title: recording.title ?? event.title,
         kind: streamCategoryFor(recording.kind, null, event.type),
         advanced: recording.audience === "ADVANCED",
         module: SCHEDULE_SCOPE,
         date: new Date(`${event.date}T12:00:00`).toLocaleDateString("ru-RU"),
         sortAt: new Date(`${event.date}T12:00:00`).getTime(),
         duration: "Видео",
         description: event.description || `Запись события «${event.title}».`,
         cover: recording.thumbnailUrl,
         isNew: false,
         embedUrl: recording.embedUrl,
       })));
       // Newest first, independent of the filter chips above — matches the curator's expectation
       // that a just-published recording appears at the top of the grid, not buried at the end.
       const nextStreams = [...lessonStreams, ...globalStreams, ...scheduleStreams]
         .sort((a, b) => b.sortAt - a.sortAt)
         .map((stream): StreamItem => stream);
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
      setAdvancedOnly(false);
      setModuleFilter("all");
      setSelectedId(targetId);
      window.sessionStorage.removeItem("fix-target-stream");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [courseStreams]);
  // Empty (not seeded with demo rows) while the real fetch is in flight — a demo recording here
  // used to flash on screen for a moment before the actual API response landed, same class of
  // bug `events` above already had to be fixed for.
  const allStreams: readonly StreamItem[] = courseStreams ?? [];
  const lessonScopes = Array.from(new Set(allStreams.map((stream) => stream.module))).filter((scope) => scope !== SCHEDULE_SCOPE && scope !== GLOBAL_SCOPE).sort();
  const otherScopes = [SCHEDULE_SCOPE, GLOBAL_SCOPE].filter((scope) => allStreams.some((stream) => stream.module === scope));
  // Facet counts: each chip reports what it would actually show under the *other* two filters, so
  // "Бектест 2" can never sit above an empty grid after picking a different lesson.
  const inScope = allStreams.filter((stream) => (moduleFilter === "all" || stream.module === moduleFilter) && (!advancedOnly || stream.advanced));
  const categories = Array.from(new Set(inScope.map((stream) => stream.kind)))
    .sort((a, b) => {
      const rankA = CATEGORY_ORDER.indexOf(a);
      const rankB = CATEGORY_ORDER.indexOf(b);
      if (rankA !== rankB) return (rankA < 0 ? CATEGORY_ORDER.length : rankA) - (rankB < 0 ? CATEGORY_ORDER.length : rankB);
      return a.localeCompare(b, "ru");
    });
  // A chip that just vanished (its category has nothing left in the new scope) must not keep
  // filtering invisibly — fall back to "Все" for this render instead of showing an empty grid
  // with no active chip to explain it.
  const activeCategory = filter !== "all" && categories.includes(filter) ? filter : "all";
  const streams = inScope.filter((stream) => activeCategory === "all" || stream.kind === activeCategory);
  const selectedStream = streams.find((stream) => stream.id === selectedId) ?? streams[0];
  const openStream = (streamId: string) => { setSelectedId(streamId); setPlayerOpen(true); };
  const closePlayer = () => setPlayerOpen(false);
  useEffect(() => {
    if (!playerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") closePlayer(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playerOpen]);

  return <div className="stream-library">{streamsLoadError && <div className="file-error" role="alert">{streamsLoadError}</div>}<div className="stream-library-toolbar">
    <div className="assignment-filter">
      <button className={`filter-chip ${activeCategory === "all" ? "active" : ""}`} onClick={() => setFilter("all")}>Все <span>{inScope.length}</span></button>
      {categories.map((category) => <button className={`filter-chip ${activeCategory === category ? "active" : ""}`} key={category} onClick={() => setFilter(category)}>{category} <span>{inScope.filter((stream) => stream.kind === category).length}</span></button>)}
      {isAdvanced && <button className={`filter-chip filter-chip-advanced ${advancedOnly ? "active" : ""}`} aria-pressed={advancedOnly} onClick={() => setAdvancedOnly((current) => !current)}>Только Advanced <span>{allStreams.filter((stream) => stream.advanced).length}</span></button>}
    </div>
    <label className="stream-module-filter"><span>Раздел</span><select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}>
      <option value="all">Все разделы</option>
      {lessonScopes.length > 0 && <optgroup label="Уроки">{lessonScopes.map((scope) => <option value={scope} key={scope}>{stripLessonNumber(scope)}</option>)}</optgroup>}
      {otherScopes.length > 0 && <optgroup label="Вне уроков">{otherScopes.map((scope) => <option value={scope} key={scope}>{stripLessonNumber(scope)}</option>)}</optgroup>}
    </select></label>
    <span className="stream-count">{streams.length} записи</span>
  </div><section className="stream-grid">{streams.length > 0 ? streams.map((stream) => <StreamCard stream={stream} selected={stream.id === selectedStream?.id} key={stream.id} onOpen={() => openStream(stream.id)} />) : courseStreams === null ? <div className="empty-state"><Play size={22} /><strong>Загружаем записи…</strong></div> : <div className="empty-state"><Play size={22} /><strong>Здесь пока нет записей</strong><span>Выбери другую категорию или раздел.</span></div>}</section>{playerOpen && selectedStream && <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={`Плеер: ${selectedStream.title}`} onMouseDown={(event) => { if (event.currentTarget === event.target) closePlayer(); }}><div className="video-modal"><div className="video-modal-head"><div><span className="section-kicker">{selectedStream.kind.toUpperCase()} · {stripLessonNumber(selectedStream.module)}</span><strong>{selectedStream.title}</strong></div><button className="icon-button" aria-label="Закрыть плеер" onClick={closePlayer}><X size={18} /></button></div>{selectedStream.embedUrl ? <TrackedVideo mediaId={selectedStream.id} src={selectedStream.embedUrl} title={selectedStream.title} /> : <div className="stream-player-unavailable"><Play size={22} /><span>Видео для этой записи ещё не подключено.</span></div>}<div className="video-modal-foot"><span>{selectedStream.description}</span><ArchivedChatPanel mediaId={selectedStream.id} /></div></div></div>}</div>;
}

function StreamCard({ stream, selected, onOpen }: { stream: StreamItem; selected: boolean; onOpen: () => void }) {
  return <article className={`stream-card ${selected ? "selected" : ""}`}><button className="stream-card-button" onClick={onOpen} aria-pressed={selected}><div className={`stream-preview ${stream.cover ? "has-cover" : ""}`}>{stream.cover ? <div className="stream-cover" role="img" aria-label={`Обложка: ${stream.title}`} style={{ backgroundImage: `url("${stream.cover}")` }} /> : <div className="mini-candles"><i /><i /><i /><i /><i /></div>}<div className="stream-preview-label">{stream.isNew ? "НОВАЯ ЗАПИСЬ" : stream.kind.toUpperCase()}</div><span className="play-button" aria-hidden="true"><Play size={17} fill="currentColor" /></span><span className="stream-duration">{stream.duration}</span></div><div className="stream-card-copy"><span>{stripLessonNumber(stream.module)} · {stream.date}</span><h3>{stream.title}</h3><p>{stream.description}</p></div></button></article>;
}

function discussionCoverForModule(position?: number, coverPath?: string | null): string {
  if (coverPath) return coverPath;
  const number = typeof position === "number" ? String(position).padStart(2, "0") : "01";
  const covers: Record<string, string> = {
    "00": "/welcome-cover.webp",
    "01": "/market-logic-cover.webp",
    "02": "/eq-point-narrative-cover.webp",
    "03": "/delivery-ab-part-12-cover.webp",
    "04": "/delivery-ab-part-3-cover.webp",
    "05": "/entry-models-qa-cover.webp",
    "06": "/qa-cover.webp",
    "07": "/pre-session-cover.webp",
  };
  return covers[number] ?? "/market-logic-cover.webp";
}

function discussionCoverForContext(context: DiscussionContext): string {
  if (context.coverPath) return context.coverPath;
  const position = Number.parseInt(context.module.slice(0, 2), 10);
  return discussionCoverForModule(Number.isNaN(position) ? undefined : position);
}

function DiscussionCreatedState({ thread, context, onOpenHistory }: { thread: DiscussionApiThread; context: DiscussionContext; onOpenHistory: () => void }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isAssignmentAnswer = Boolean(context.assignmentId);
  const firstMessage = thread.messages[0];
  const attachment = firstMessage?.attachments[0];
  const attachmentUrl = attachment?.contentUrl ? `${API_ORIGIN}${attachment.contentUrl}` : "";
  const statusLabel = thread.status === "ANSWERED" ? "Ответ куратора" : thread.status === "CLOSED" ? "Тема закрыта" : "Ожидает ответа куратора";
  return <section className="content-panel discussion-created-state"><div className="discussion-created-heading"><div className="section-kicker">{isAssignmentAnswer ? "ОТВЕТ ОТПРАВЛЕН" : "ВОПРОС СОЗДАН"}</div><h2>{isAssignmentAnswer ? "Ответ отправлен куратору" : "Вопрос отправлен куратору"}</h2></div><button className={`discussion-created-card ${detailsOpen ? "expanded" : ""}`} type="button" onClick={() => setDetailsOpen((current) => !current)}><span className="discussion-created-cover" role="img" aria-label={`Обложка ${context.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(7,14,23,.9), rgba(7,14,23,.25)), url("${discussionCoverForContext(context)}")` }} /><span className="discussion-created-copy"><small>{isAssignmentAnswer ? "Практическое задание" : context.module}</small><strong>{thread.title}</strong><span className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{statusLabel}</span></span><ChevronDown size={20} className="discussion-created-chevron" /></button>{detailsOpen && <div className="discussion-created-details"><div className="discussion-created-status"><Clock3 size={16} /><strong>{statusLabel}</strong><span>{isAssignmentAnswer ? "Куратор увидит ответ в очереди обсуждений." : "Куратор увидит вопрос в очереди обсуждений."}</span></div><div className="discussion-created-message"><span className="detail-label">{isAssignmentAnswer ? "ТВОЙ ОТВЕТ" : "ТЕКСТ ВОПРОСА"}</span><p>{firstMessage?.body}</p>{attachmentUrl && attachment?.mimeType.startsWith("image/") && <div className="discussion-created-attachment-image" role="img" aria-label={attachment.originalName} style={{ backgroundImage: `url("${attachmentUrl}")` }} />}{attachment && <a href={attachment.sourceUrl ? attachment.sourceUrl : (attachmentUrl || undefined)} target="_blank" rel="noreferrer"><FileCheck2 size={15} /> {attachment.originalName} <ArrowUpRight size={14} /></a>}</div></div>}<div className="discussion-created-actions"><button className="secondary-button" type="button" onClick={onOpenHistory}>{isAssignmentAnswer ? "Перейти к переписке" : "Задать ещё вопрос"}</button></div></section>;
}

function DiscussionContextBanner({ context, onOpenHistory }: { context: DiscussionContext; onOpenHistory: () => void }) {
  // A practice assignment already has a name — asking the student to also invent a "topic"
  // for their own answer is redundant busywork, so this mode skips that field entirely and
  // uses the assignment's own title (context.module, set by PracticeAssignmentDetail) instead.
  const isAssignmentAnswer = Boolean(context.assignmentId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const attachments = useDiscussionAttachments();
  const [submitError, setSubmitError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [createdThread, setCreatedThread] = useState<DiscussionApiThread | null>(null);
  const effectiveTitle = isAssignmentAnswer ? context.module : title;
  const canSubmit = effectiveTitle.trim().length > 0 && body.trim().length > 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || saving) return;
    setSaving(true);
    setSubmitError("");
    let uploadedFileIds: string[] = [];
    try {
      const uploaded = await attachments.uploadAll();
      uploadedFileIds = uploaded.uploadedFileIds;
      const response = await fetch(`${API_ORIGIN}/api/discussions`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: effectiveTitle, body, moduleId: context.moduleId, assignmentId: context.assignmentId, attachments: uploaded.payload }) });
      const payload = await response.json().catch(() => ({})) as { message?: string; data?: DiscussionApiThread };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось создать тему.");
      setCreatedThread(payload.data);
      setSubmitted(true);
    } catch (error: unknown) {
      for (const fileId of uploadedFileIds) void fetch(`${API_ORIGIN}/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
      setSubmitError(error instanceof Error ? error.message : "Не удалось создать тему.");
    } finally {
      setSaving(false);
    }
  };

  const handleBodyPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    const files = imageItems.map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      const extension = item.type.split("/")[1] || "png";
      return new File([file], `screenshot-${Date.now()}-${index}.${extension}`, { type: item.type });
    }).filter((file): file is File => file !== null);
    attachments.addFiles(files);
  };

  if (createdThread) return <DiscussionCreatedState thread={createdThread} context={context} onOpenHistory={onOpenHistory} />;

  return <section className="content-panel discussion-context-banner"><div className="discussion-context-heading"><h2>{isAssignmentAnswer ? "Отправить ответ куратору" : "Задать вопрос куратору"}</h2></div><div className="discussion-context-chips"><span><BookOpen size={14} /> {context.module}</span></div><form className="discussion-composer" onSubmit={submit}>{!isAssignmentAnswer && <label className="form-field"><span>Тема вопроса</span><input value={title} onChange={(event) => { setTitle(event.target.value); setSubmitted(false); }} placeholder="Например: Как определить точку входа в этом сценарии?" /></label>}<label className="form-field"><span>{isAssignmentAnswer ? "Твой ответ" : "Вопрос и описание"}</span><textarea value={body} onKeyDown={continueNumberedList} onChange={(event) => { setBody(event.target.value); setSubmitted(false); }} onPaste={handleBodyPaste} rows={6} placeholder={isAssignmentAnswer ? "Опиши, что сделал: разметку, сценарий входа, наблюдения… Скриншот можно вставить сюда через Ctrl+V" : "Опиши, что именно непонятно. Можно добавить уровни, таймфрейм и свои наблюдения… Скриншот можно вставить сюда через Ctrl+V"} /></label><label className={`discussion-attachment-picker ${attachments.attachments.length > 0 ? "has-file" : ""}`} htmlFor="discussion-attachment"><FileCheck2 size={17} /><span>{attachments.attachments.length > 0 ? `Прикреплено файлов: ${attachments.attachments.length}` : "Прикрепить скриншот, график, PDF или видео"}</span><small>PNG, JPG, PDF, MP4, WebM · до 10 МБ за файл · можно прикрепить сразу несколько, или вставить скриншот через Ctrl+V в поле {isAssignmentAnswer ? "ответа" : "вопроса"}</small><input id="discussion-attachment" type="file" multiple accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => { attachments.addFiles(event.target.files); event.target.value = ""; }} /></label>{attachments.error && <div className="file-error" role="alert">{attachments.error}</div>}<DiscussionAttachmentPreviewList attachments={attachments.attachments} onRemove={attachments.removeAt} /><div className="discussion-composer-actions"><button className="support-card" type="submit" disabled={!canSubmit || submitted || saving}><span className="support-card-label">{saving ? "Отправляем…" : submitted ? (isAssignmentAnswer ? "Ответ отправлен" : "Вопрос отправлен") : (isAssignmentAnswer ? "Отправить ответ" : "Задать вопрос")}</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button></div>{submitError && <div className="file-error" role="alert">{submitError}</div>}{submitted && <div className="detail-feedback accepted"><Target size={16} /><div><strong>{isAssignmentAnswer ? "Ответ сохранён" : "Тема сохранена"}</strong><p>{isAssignmentAnswer ? "Ответ записан в базу и появится у куратора." : "Вопрос записан в базу и появится у куратора."}</p></div></div>}</form></section>;
}

const OTHER_QUESTION_VALUE = "__other__";

function DiscussionViewDb({ onOpenDiscussion }: { onOpenDiscussion: (context: DiscussionContext) => void }) {
  const [threads, setThreads] = useState<CuratorDiscussion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [courseModules, setCourseModules] = useState<CourseApiModule[]>([]);
  const [pickerModuleId, setPickerModuleId] = useState("");
  const [practicumCompleted, setPracticumCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`${API_ORIGIN}/api/course`, { credentials: "include", cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({})) as CourseApiPayload;
      if (!cancelled) {
        setCourseModules((payload.data?.modules ?? []).filter((module) => !module.locked));
        setPracticumCompleted(payload.data?.practicumCompleted ?? false);
      }
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  // The picker asks "which урок", meaning the top-level module (Welcome,
  // Контекст и структура рынка…) — not the VIDEO sub-record living inside it.
  // "Другой вопрос" is the escape hatch for anything not tied to a specific lesson — omitting
  // moduleId entirely is already a fully-supported case end to end (see discussion-service.ts's
  // validateContext, which only checks module/assignment consistency when one is actually given,
  // and mapDiscussionApiThread's existing "Без урока" fallback on the curator's side).
  const startPicked = () => {
    if (pickerModuleId === OTHER_QUESTION_VALUE) { onOpenDiscussion({ module: "Другой вопрос", practicumCompleted }); return; }
    const courseModule = courseModules.find((item) => item.id === pickerModuleId);
    if (!courseModule) return;
    onOpenDiscussion({ module: `${courseModule.number} · ${courseModule.title}`, coverPath: courseModule.coverPath, moduleId: courseModule.id, practicumCompleted });
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
      {practicumCompleted ? <div className="module-action-feedback">Поток завершён — новые вопросы уже не задать. Переписка ниже осталась доступна для чтения.</div> : <div className="discussion-new-question-picker">
        <label className="form-field"><select value={pickerModuleId} onChange={(event) => setPickerModuleId(event.target.value)}><option value="">Выбери урок…</option><option value={OTHER_QUESTION_VALUE}>Другой вопрос</option>{courseModules.map((courseModule) => <option value={courseModule.id} key={courseModule.id}>{courseModule.title}</option>)}</select></label>
        <button className="support-card" type="button" disabled={!pickerModuleId} onClick={startPicked}><span className="support-card-label">Задать вопрос</span><span className="support-card-arrow" aria-hidden="true"><ArrowRight size={16} /></span></button>
      </div>}
    </section>
    <div className="student-discussion-layout">
      <section className="content-panel student-discussion-list-panel">
        <div className="section-heading"><div><span className="section-kicker">ПОТОК 04</span><h2>Мои обсуждения</h2></div><span className="progress-inline">{threads.length} тем</span></div>
        {loading ? <div className="empty-state"><MessageSquareText size={22} /><strong>Загружаем обсуждения…</strong><span>Проверяем сохранённые вопросы.</span></div> : error ? <div className="empty-state"><MessageSquareText size={22} /><strong>Не удалось загрузить обсуждения</strong><span>{error}</span></div> : threads.length === 0 ? <div className="empty-state"><MessageSquareText size={22} /><strong>Обсуждений пока нет</strong><span>Выбери урок выше и задай первый вопрос куратору.</span></div> : <div className="discussion-list">{threads.map((thread) => <button className={`discussion-row student-discussion-row ${thread.id === selectedId ? "selected" : ""}`} type="button" key={thread.id} onClick={() => setSelectedId(thread.id)}><div className="discussion-row-cover" role="img" aria-label={`Обложка ${thread.module}`} style={{ backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.4), rgba(8,17,27,.82)), url("${thread.coverPath ?? discussionCoverForContext({ module: thread.module })}")` }} /><div><strong>{thread.title}</strong><span>{thread.module}</span><small>{thread.updatedAt} · {thread.messages.length} сообщений</small></div><b className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(thread.status)}</b><ChevronRight size={16} /></button>)}</div>}
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
  const [moduleFilter, setModuleFilter] = useState("all");

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
  const moduleOptions = Array.from(new Map(threads.map((thread) => [thread.module, thread.module] as const)).entries());
  const filteredThreads = moduleFilter === "all" ? threads : threads.filter((thread) => thread.module === moduleFilter);

  return <section className="content-panel cohort-discussion-panel">
    <div className="section-heading discussion-answered-heading"><h2>Отвечено ранее</h2><span className="progress-inline">{filteredThreads.length} тем</span></div>
    {!loading && !error && moduleOptions.length > 1 && <label className="stream-module-filter cohort-discussion-module-filter"><span>Урок</span><select value={moduleFilter} onChange={(event) => setModuleFilter(event.target.value)}><option value="all">Все уроки</option>{moduleOptions.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>}
    {loading ? <div className="empty-state"><MessageSquareText size={22} /><strong>Загружаем вопросы потока…</strong></div>
      : error ? <div className="empty-state"><MessageSquareText size={22} /><strong>Не удалось загрузить</strong><span>{error}</span></div>
      : filteredThreads.length === 0 ? <div className="empty-state"><MessageSquareText size={22} /><strong>Ничего не нашлось</strong><span>В этом уроке пока нет отвеченных вопросов.</span></div>
      : <div className="discussion-list cohort-discussion-list">{filteredThreads.map((thread) => {
          const isOpen = thread.id === openId;
          return <div className="cohort-discussion-item" key={thread.id}>
            <button className="discussion-row student-discussion-row" type="button" onClick={() => setOpenId((current) => current === thread.id ? "" : thread.id)} aria-expanded={isOpen}>
              <div className="discussion-row-cover" role="img" aria-label={`Обложка ${thread.module}`} style={{ backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.4), rgba(8,17,27,.82)), url("${thread.coverPath ?? discussionCoverForContext({ module: thread.module })}")` }} />
              <div><strong>{thread.title}</strong><span>{thread.module}</span><small>{thread.messages.length} {thread.messages.length === 1 ? "сообщение" : "сообщений"}</small></div>
              <ChevronRight size={16} className={isOpen ? "rotate-down" : ""} />
            </button>
            {isOpen && <div className="cohort-discussion-thread">{thread.messages.map((message) => <article className={`student-discussion-message ${message.author}`} key={message.id}><div className="student-discussion-message-meta"><strong>{message.name}</strong></div><p>{linkifyText(message.body)}</p><DiscussionMessageAttachments message={message} /></article>)}</div>}
          </div>;
        })}</div>}
  </section>;
}

function StudentDiscussionDetail({ thread, onClose, onUpdate }: { thread: CuratorDiscussion; onClose: () => void; onUpdate: (thread: CuratorDiscussion) => void }) {
  const [reply, setReply] = useState("");
  const [replyOpen, setReplyOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // Files in follow-ups too, same as the curator's reply (2026-10-04: only the first question could
  // carry a screenshot — the reply form had no picker at all).
  const replyAttachments = useDiscussionAttachments();
  const handleReplyPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    replyAttachments.addFiles(images.flatMap((item, index) => {
      const file = item.getAsFile();
      return file ? [new File([file], `screenshot-${Date.now()}-${index}.${item.type.split("/")[1] || "png"}`, { type: item.type })] : [];
    }));
  };
  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if ((!reply.trim() && replyAttachments.attachments.length === 0) || saving || thread.status === "CLOSED") return;
    setSaving(true);
    setError("");
    let uploadedFileIds: string[] = [];
    try {
      const uploaded = await replyAttachments.uploadAll();
      uploadedFileIds = uploaded.uploadedFileIds;
      const response = await fetch(`${API_ORIGIN}/api/discussions/${thread.id}/messages`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: reply.trim(), attachments: uploaded.payload }) });
      const payload = await response.json().catch(() => ({})) as { data?: DiscussionApiThread; message?: string };
      if (!response.ok || !payload.data) throw new Error(payload.message ?? "Не удалось отправить ответ.");
      onUpdate(mapDiscussionApiThread(payload.data));
      setReply("");
      replyAttachments.clear();
      setReplyOpen(false);
    } catch (reason: unknown) {
      for (const fileId of uploadedFileIds) void fetch(`${API_ORIGIN}/api/files/${fileId}`, { method: "DELETE", credentials: "include" });
      setError(reason instanceof Error ? reason.message : "Не удалось отправить ответ.");
    } finally {
      setSaving(false);
    }
  };
  return <section className="content-panel student-discussion-detail">
    <div className="student-discussion-detail-head"><div><span className="section-kicker">{thread.module}</span><h2>{thread.title}</h2><p>{thread.updatedAt}</p></div><button className="icon-button compact" type="button" aria-label="Закрыть историю вопроса" onClick={onClose}><X size={17} /></button></div>
    <div className="student-discussion-messages">{thread.messages.map((message) => <article className={`student-discussion-message ${message.author}`} key={message.id}><div className="student-discussion-message-meta"><strong>{message.name}</strong><span>{message.time}</span></div><p>{linkifyText(message.body)}</p><DiscussionMessageAttachments message={message} /></article>)}</div>
    <div className="student-discussion-status-note"><span className={`curator-discussion-status ${thread.status.toLowerCase()}`}>{curatorDiscussionStatusLabel(thread.status)}</span><span>{thread.practicumCompleted ? "Поток завершён — переписка доступна только для чтения." : thread.status === "CLOSED" ? "Вопрос закрыт. Для нового обращения создай отдельную тему." : "История сохраняется, а диалог можно продолжить в любой момент."}</span></div>
    {thread.status !== "CLOSED" && !thread.practicumCompleted && <div className="student-discussion-actions"><button className="primary-button" type="button" onClick={() => setReplyOpen((current) => !current)}>{replyOpen ? "Скрыть ответ" : "Ответить ещё"}</button></div>}
    {replyOpen && thread.status !== "CLOSED" && !thread.practicumCompleted && <form className="student-discussion-reply" onSubmit={sendReply}><label htmlFor="student-discussion-reply">ОТВЕТ В ЭТОЙ ТЕМЕ</label><div className="student-discussion-input-wrap"><textarea id="student-discussion-reply" onKeyDown={continueNumberedList} value={reply} onChange={(event) => setReply(event.target.value)} onPaste={handleReplyPaste} rows={4} placeholder="Напиши уточнение или следующий вопрос куратору… Скриншот можно вставить через Ctrl+V" /><label className="discussion-reply-attach-button" htmlFor="student-discussion-reply-attachment" title="Прикрепить файлы" aria-label="Прикрепить файлы"><Plus size={18} /><input id="student-discussion-reply-attachment" type="file" multiple accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => { replyAttachments.addFiles(event.target.files); event.target.value = ""; }} /></label></div>{replyAttachments.error && <div className="file-error" role="alert">{replyAttachments.error}</div>}<DiscussionAttachmentPreviewList attachments={replyAttachments.attachments} onRemove={replyAttachments.removeAt} /><div><span>Ответ добавится в историю и снова передаст тему куратору.</span><button className="primary-button" type="submit" disabled={(!reply.trim() && replyAttachments.attachments.length === 0) || saving}>{saving ? "Отправляем…" : "Отправить ответ"} <ChevronRight size={15} /></button></div></form>}
    {error && <div className="file-error student-discussion-error" role="alert">{error}</div>}
  </section>;
}

// Legacy demo markup kept temporarily for visual reference; it is no longer rendered.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function DiscussionView({ hideDemo = false }: { hideDemo?: boolean }) {
  if (hideDemo) return null;
  return <div className="section-grid"><section className="content-panel"><div className="section-heading"><div><span className="section-kicker">ПОТОК 04</span><h2>Последние обсуждения</h2></div><button className="primary-button compact-button"><Plus size={15} /> Новая тема</button></div><div className="discussion-list"><div className="discussion-row"><div className="profile-avatar">АК</div><div><strong>Как отличить возврат в зону от ложного пробоя?</strong><span>Алексей К. · 4 ответа · 18 минут назад</span></div><ChevronRight size={16} /></div><div className="discussion-row"><div className="profile-avatar curator">МК</div><div><strong>Дополнительное ДЗ по уроку 03</strong><span>Мария, куратор · 9 ответов · вчера</span></div><ChevronRight size={16} /></div><div className="discussion-row"><div className="profile-avatar">ЕС</div><div><strong>Поделитесь разметкой перед завтрашним стримом</strong><span>Елена С. · 6 ответов · вчера</span></div><ChevronRight size={16} /></div></div></section><section className="content-panel discussion-note"><div className="section-heading"><div><span className="section-kicker">ПРАВИЛА ОБЩЕНИЯ</span><h2>Рабочее пространство</h2></div><MessageSquareText size={18} className="heading-icon" /></div><p>Здесь удобно задавать вопросы по урокам и ДЗ. Для быстрых обсуждений и стримов пока используется Discord.</p><button className="secondary-button">Открыть Discord <ArrowUpRight size={15} /></button></section></div>;
}

function ChartScene() {
  const candles = [
    { x: 6, h: 82, top: 110, positive: true }, { x: 15, h: 44, top: 138, positive: false }, { x: 25, h: 100, top: 84, positive: true },
    { x: 35, h: 60, top: 124, positive: false }, { x: 45, h: 128, top: 52, positive: true }, { x: 55, h: 72, top: 104, positive: false },
    { x: 65, h: 91, top: 96, positive: true }, { x: 75, h: 54, top: 146, positive: false }, { x: 85, h: 138, top: 33, positive: true },
  ];
  return <section className="chart-panel" aria-label="Учебный график EUR/USD с уровнями поддержки и сопротивления"><div className="chart-topline"><span>EUR / USD</span><span className="chart-timeframe">1H <ChevronRight size={13} /></span></div><div className="chart-gridlines"><i /><i /><i /><i /></div><div className="resistance-line"><span>Сопротивление</span></div><div className="support-line"><span>Поддержка</span></div><div className="candles">{candles.map((candle) => <div className={`candle ${candle.positive ? "positive" : "negative"}`} key={candle.x} style={{ left: `${candle.x}%`, height: `${candle.h}px`, top: `${candle.top}px` }}><i /></div>)}</div><svg className="chart-path" viewBox="0 0 500 260" preserveAspectRatio="none" aria-hidden="true"><path d="M0 218 C44 215 44 170 85 177 S118 222 154 181 S195 103 225 131 S273 192 311 137 S346 66 372 111 S421 160 442 98 S475 35 500 18" /></svg><div className="chart-label chart-label-top">КЛЮЧЕВОЙ УРОВЕНЬ</div><div className="chart-label chart-label-bottom">Учебный пример · смотри на реакцию цены</div><div className="chart-axis"><span>09:00</span><span>12:00</span><span>15:00</span><span>18:00</span></div><div className="chart-scanline" /></section>;
}

function StatCard({ icon, label, value, detail, accent, onClick }: { icon: React.ReactNode; label: string; value: string; detail: string; accent: string; onClick?: () => void }) {
  const content = <><div className={`stat-icon ${accent}`}>{icon}</div><div className="stat-copy"><span>{label}</span><strong className={`stat-value ${accent}`}>{value}</strong><small>{detail}</small></div></>;
  if (onClick) return <button type="button" className="stat-card" onClick={onClick}>{content}</button>;
  return <div className="stat-card">{content}</div>;
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
  return <button className={`assignment-row ${selected ? "selected" : ""}`} onClick={onOpen} aria-pressed={selected}><div className={`assignment-status assignment-status-cover ${effectiveTone}`} role="img" aria-label={`Обложка: ${assignment.module}`} style={{ backgroundImage: `linear-gradient(135deg, rgba(8,17,27,.28), rgba(8,17,27,.78)), url("${coverPath}")` }}><span className="assignment-status-cover-icon">{assignmentStatusIcon(assignment.status, assignment.tone)}</span></div><div className="assignment-copy"><strong>{assignment.title}</strong><span>{assignment.isPractice && <b className="assignment-practice-tag">ПРАКТИКА</b>}{assignment.module}</span>{assignmentHint(assignment.status) && <small className="assignment-hint">{assignmentHint(assignment.status)}</small>}</div><div className={`assignment-badge ${effectiveTone}`}><span className="assignment-badge-icon">{assignmentStatusIcon(assignment.status, assignment.tone)}</span>{assignment.status}</div><span className="assignment-date">{assignment.date}</span><ChevronRight size={16} className="assignment-chevron" /></button>;
}

function assignmentHint(status: AssignmentStatus) {
  // "Работа принята" duplicated the badge right next to it — the other hints stay because
  // they add information the badge alone doesn't ("Есть комментарий куратора" tells the
  // student there's a note attached to "Нужна доработка", not just the status word again).
  return status === "На проверке" ? "Отправлено сегодня" : status === "Нужна доработка" ? "Есть комментарий куратора" : status === "Не начато" ? "Ещё не отправлено" : "";
}

function LegacyAssignmentDetail({ assignment }: { assignment: Assignment }) {
  const [draft, setDraft] = useState("");
  const attachments = useDiscussionAttachments();
  const [fileError, setFileError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const isAccepted = assignment.status === "Принято";
  // The backend rejects a second submission outright while one is already SUBMITTED/IN_REVIEW
  // (see assignment-service.ts) — the "Можно отправлять заново после доработки" copy only applies
  // once a curator has actually responded, so the editable form stays hidden until then. Without
  // this, a student could type a new answer, hit submit, and land on a raw "already awaiting
  // review" error with no form left to explain why.
  const isPending = submitted || assignment.status === "На проверке";
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState("");
  const completeWork = async () => {
    if (!assignment.id || completing) return;
    setCompleteError("");
    setCompleting(true);
    try {
      const response = await fetch(`${API_ORIGIN}/api/assignments/${assignment.id}/complete`, { method: "POST", credentials: "include" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? "Не удалось отметить задание выполненным.");
      }
      window.dispatchEvent(new Event(assignmentSubmittedEvent));
    } catch (error: unknown) {
      setCompleteError(error instanceof Error ? error.message : "Не удалось отметить задание выполненным.");
    } finally {
      setCompleting(false);
    }
  };
  const submitWork = async () => {
    if (!assignment.id || submitted) return;
    setFileError("");
    try {
      const uploaded = await attachments.uploadAll();
      const fileIds = uploaded.payload.map((item) => item.fileId);
      const response = await fetch(`${API_ORIGIN}/api/assignments/${assignment.id}/submissions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answerText: draft.trim(), fileIds }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        // The form being hidden while isPending is the main guard against ever hitting this —
        // this translation is just a fallback for a stale second tab or similar edge case.
        throw new Error(payload.message === "Submission is already awaiting review" ? "Работа уже на проверке — дождитесь ответа куратора." : payload.message ?? "Не удалось отправить работу.");
      }
      setSubmitted(true);
      // Clears the composer so a fresh attempt doesn't start pre-filled with what was just sent —
      // the form itself is now hidden while isPending (see below), so this only matters for
      // whenever it next reappears (after a curator requests revision).
      setDraft("");
      attachments.clear();
      window.dispatchEvent(new Event(assignmentSubmittedEvent));
    } catch (error: unknown) {
      setFileError(error instanceof Error ? error.message : "Не удалось отправить работу.");
    }
  };
  const handleFileChange = (fileList: FileList | File[] | null | undefined) => {
    attachments.addFiles(fileList);
    setSaved(false);
    setSubmitted(false);
  };
  const handleAnswerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageItems = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    event.preventDefault();
    const files = imageItems.map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      const extension = item.type.split("/")[1] || "png";
      return new File([file], `screenshot-${Date.now()}-${index}.${extension}`, { type: item.type });
    }).filter((file): file is File => file !== null);
    handleFileChange(files);
  };

  if (!assignment.id) {
    return <section className="content-panel assignment-detail directory-empty"><div className="empty-state"><FileCheck2 size={24} /><strong>Выбери опубликованное задание</strong><span>Когда куратор опубликует ДЗ, оно появится в этом списке.</span></div></section>;
  }

  return <section className="content-panel assignment-detail"><div className="detail-header"><div><span className="section-kicker">{assignment.module}</span><h2>{assignment.title}</h2></div><div className={`assignment-badge ${assignment.status === "Принято" ? "green" : assignment.tone}`}>{submitted ? "На проверке" : assignment.status}</div></div><div className="detail-meta"><span><Clock3 size={14} /> {assignment.deadline}</span><span><FileCheck2 size={14} /> {isAccepted ? (assignment.reviewRequired === false ? "Отмечено выполненным" : "Проверено куратором") : isPending ? "Ждёт решения куратора" : assignment.reviewRequired === false ? "Проверка не требуется" : "Можно отправлять заново после доработки"}</span></div><div className="detail-body"><p className="detail-description">{assignment.description}</p><div className="detail-section"><span className="detail-label">ЧТО НУЖНО СДЕЛАТЬ</span><ul className="detail-checklist">{assignment.requirements.map((requirement) => <li key={requirement}><span />{requirement}</li>)}</ul></div>{isAccepted ? <div className="detail-feedback accepted"><CheckCircle2 size={17} /><div><strong>Задание принято</strong><p>{assignment.reviewRequired === false ? "Отмечено выполненным без проверки куратора." : "Куратор подтвердил работу. Материал сохранён в истории практикума."}</p></div></div> : isPending ? <div className="detail-feedback submitted"><CheckCircle2 size={17} /><div><strong>Работа отправлена куратору</strong><p>Ответ и вложения сохранены и ждут очереди проверки. Новый ответ можно будет отправить, если куратор попросит доработку — статус обновится здесь автоматически.</p></div></div> : assignment.practicumCompleted ? <div className="detail-feedback locked"><LockKeyhole size={17} /><div><strong>Поток завершён</strong><p>Отправить или досдать эту работу уже нельзя — но описание, требования и материалы задания остались доступны для просмотра.</p></div></div> : assignment.blockedByModuleTitle ? <div className="detail-feedback locked"><LockKeyhole size={17} /><div><strong>Пока недоступно</strong><p>Сначала сдайте ДЗ урока «{assignment.blockedByModuleTitle}» — вернитесь туда и отправьте работу, тогда это задание откроется.</p></div></div> : assignment.reviewRequired === false ? <div className="detail-section"><div className="detail-feedback"><Target size={17} /><div><strong>Проверка куратором не требуется</strong><p>Отметь задание выполненным, чтобы открыть следующий урок.</p></div></div>{completeError && <div className="file-error" role="alert">{completeError}</div>}<div className="detail-actions"><button className="primary-button" onClick={() => void completeWork()} disabled={completing}>{completing ? "Отмечаем…" : "Отметить выполненным"} <ChevronRight size={16} /></button></div></div> : <><div className="detail-section"><label className="detail-label" htmlFor="assignment-answer">ТВОЙ КОММЕНТАРИЙ</label><textarea id="assignment-answer" onKeyDown={continueNumberedList} value={draft} onChange={(event) => { setDraft(event.target.value); setSaved(false); setSubmitted(false); }} onPaste={handleAnswerPaste} placeholder="Опиши логику решения или добавь контекст к файлу... Скриншот можно вставить сюда через Ctrl+V" rows={5} /></div><label className={`file-dropzone ${attachments.attachments.length > 0 ? "has-file" : ""}`} htmlFor="assignment-file"><FileCheck2 size={19} /><span>{attachments.attachments.length > 0 ? `Прикреплено файлов: ${attachments.attachments.length}` : "Прикрепить разметку, PDF или видео"}</span><small>PNG, JPG, PDF, MP4 или WebM · до 10 МБ за файл · можно прикрепить сразу несколько, или вставить скриншот через Ctrl+V в поле комментария</small><input id="assignment-file" type="file" multiple accept="image/png,image/jpeg,application/pdf,video/mp4,video/webm" onChange={(event) => { handleFileChange(event.target.files); event.target.value = ""; }} /></label>{(attachments.error || fileError) && <div className="file-error" role="alert">{attachments.error || fileError}</div>}{attachments.attachments.map((attachment, index) => <div className="assignment-preview" key={`${attachment.file.name}-${index}`}><div className="assignment-preview-heading"><span>ПРЕДПРОСМОТР</span><div className="assignment-preview-heading-row"><strong>{attachment.file.name}</strong><button type="button" className="icon-button compact" onClick={() => attachments.removeAt(index)} aria-label={`Убрать файл ${attachment.file.name}`}><X size={14} /></button></div></div>{attachment.kind === "image" && <div className="assignment-preview-image-wrap"><Image src={attachment.previewUrl} alt={`Предпросмотр файла ${attachment.file.name}`} fill sizes="(max-width: 700px) 100vw, 420px" unoptimized className="assignment-preview-image" /></div>}{attachment.kind === "file" && <iframe src={attachment.previewUrl} title={`Предпросмотр файла ${attachment.file.name}`} />}{attachment.kind === "video" && <video src={attachment.previewUrl} controls preload="metadata" />}</div>)}{saved && <div className="detail-feedback"><Target size={17} /><div><strong>Черновик сохранён в этой сессии</strong><p>Можно вернуться к заданию и продолжить подготовку ответа.</p></div></div>}<div className="detail-actions"><button className="secondary-button" onClick={() => setSaved(true)} disabled={!draft.trim() && attachments.attachments.length === 0}>Сохранить черновик</button><button className="primary-button" onClick={() => void submitWork()} disabled={!draft.trim() && attachments.attachments.length === 0}>Отправить на проверку <ChevronRight size={16} /></button></div></>}</div></section>;
}

/**
 * Turns a Vimeo/YouTube link a curator pasted into an embeddable player URL (null = not a video,
 * show it as a plain link). Curators' Vimeo videos are typically hidden on vimeo.com and only
 * play embedded, so an unrecognized format silently degrades into a dead link — every common
 * share format has to be covered, notably Vimeo's unlisted "vimeo.com/<id>/<hash>".
 */
export function assignmentMaterialEmbed(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (/(^|\.)vimeo\.com$/.test(host)) {
      // vimeo.com/<id>, vimeo.com/<id>/<hash>, player.vimeo.com/video/<id>?h=<hash>,
      // vimeo.com/channels/<name>/<id>, vimeo.com/groups/<name>/videos/<id>
      const idIndex = segments.findIndex((segment) => /^\d+$/.test(segment));
      if (idIndex === -1) return null;
      const id = segments[idIndex];
      const pathHash = segments[idIndex + 1];
      const hash = parsed.searchParams.get("h") ?? (pathHash && /^[0-9a-f]+$/i.test(pathHash) ? pathHash : null);
      return `https://player.vimeo.com/video/${id}${hash ? `?h=${encodeURIComponent(hash)}` : ""}`;
    }
    if (host === "youtu.be") return segments[0] ? `https://www.youtube.com/embed/${encodeURIComponent(segments[0])}` : null;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(host)) {
      const watchId = parsed.searchParams.get("v");
      if (watchId) return `https://www.youtube.com/embed/${encodeURIComponent(watchId)}`;
      if (["embed", "shorts", "live"].includes(segments[0] ?? "") && segments[1]) return `https://www.youtube.com/embed/${encodeURIComponent(segments[1])}`;
    }
  } catch {
    return null;
  }
  return null;
}

// Compact preview for a summary card (curator's "Программа" lesson editor, the student's
// per-module homework card) — the full-size version with embeds lives in AssignmentMaterials
// below, reserved for the actual assignment detail page.
function AssignmentMaterialsInline({ materials }: { materials: Assignment["materials"] }) {
  // A Vimeo/YouTube material opens in an on-page player, not as a link: curators' Vimeo videos
  // are usually "embed only" (hidden on vimeo.com itself), so the plain link from a lesson's
  // homework card landed students on Vimeo's "couldn't find that page" (2026-10-01), while the
  // same video played fine embedded on the assignment page.
  const [playing, setPlaying] = useState<{ title: string; embedUrl: string } | null>(null);
  useEffect(() => {
    if (!playing) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setPlaying(null); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playing]);
  if (!materials || materials.length === 0) return null;
  return <div className="assignment-materials-inline">{materials.map((material) => {
    const url = material.url?.startsWith("http") ? material.url : material.url ? `${API_ORIGIN}${material.url}` : "";
    const isImage = material.kind === "FILE" && material.mimeType?.startsWith("image/");
    const embedUrl = material.kind === "LINK" && material.url ? assignmentMaterialEmbed(material.url) : null;
    if (embedUrl) return <button type="button" className="assignment-materials-inline-file" key={material.id} onClick={() => setPlaying({ title: material.title, embedUrl })}><Play size={13} /><span>{material.title}</span></button>;
    return isImage
      ? <a className="assignment-materials-inline-image" key={material.id} href={url} target="_blank" rel="noreferrer" aria-label={material.title}><Image src={url} alt={material.title} fill sizes="80px" unoptimized /></a>
      : <a className="assignment-materials-inline-file" key={material.id} href={material.kind === "LINK" ? material.url : url} target="_blank" rel="noreferrer">{material.kind === "LINK" ? <ArrowUpRight size={13} /> : <FileCheck2 size={13} />}<span>{material.title}</span></a>;
  })}
    {playing && typeof document !== "undefined" && createPortal(
      <div className="video-modal-backdrop" role="dialog" aria-modal="true" aria-label={playing.title} onMouseDown={(event) => { if (event.currentTarget === event.target) setPlaying(null); }}>
        <div className="video-modal">
          <div className="video-modal-head"><div><span className="section-kicker">МАТЕРИАЛ К ЗАДАНИЮ</span><strong>{playing.title}</strong></div><button type="button" className="icon-button" aria-label="Закрыть" onClick={() => setPlaying(null)}><X size={18} /></button></div>
          <iframe src={playing.embedUrl} title={playing.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
        </div>
      </div>,
      document.body,
    )}
  </div>;
}

function AssignmentMaterials({ materials }: { materials: Assignment["materials"] }) {
  const [zoomImageUrl, setZoomImageUrl] = useState("");
  if (!materials || materials.length === 0) return null;
  return <section className="content-panel assignment-materials-panel"><div className="section-heading"><div><span className="section-kicker">МАТЕРИАЛ К ЗАДАНИЮ</span><h2>Перед началом работы</h2><p className="section-heading-note">Материалы, которые добавил куратор к этому заданию.</p></div></div><div className="assignment-materials-list">{materials.map((material) => { const url = material.url?.startsWith("http") ? material.url : material.url ? `${API_ORIGIN}${material.url}` : ""; const embedUrl = material.kind === "LINK" && material.url ? assignmentMaterialEmbed(material.url) : null; return <article className="assignment-material-card" key={material.id}><div className="assignment-material-card-head"><strong>{material.title}</strong><span>{material.kind === "LINK" ? "Ссылка" : material.mimeType ?? "Файл"}</span></div>{embedUrl && <iframe src={embedUrl} title={material.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}{!embedUrl && material.kind === "FILE" && material.mimeType?.startsWith("image/") && <button type="button" className="assignment-material-image assignment-material-image-button" aria-label={`Увеличить изображение ${material.title}`} onClick={() => setZoomImageUrl(url)}><Image src={url} alt={material.title} fill sizes="(max-width: 950px) 100vw, 50vw" unoptimized /></button>}{!embedUrl && material.kind === "FILE" && material.mimeType?.startsWith("video/") && <video src={url} controls preload="metadata" />}{!embedUrl && material.kind === "FILE" && material.mimeType === "application/pdf" && <iframe src={url} title={material.title} />}{!embedUrl && material.kind === "LINK" && <a className="secondary-button" href={material.url} target="_blank" rel="noreferrer">Открыть материал <ArrowUpRight size={15} /></a>}</article>; })}</div>
    {zoomImageUrl && typeof document !== "undefined" && createPortal(
      <div className="chat-image-lightbox-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setZoomImageUrl(""); }}>
        <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть просмотр" onClick={() => setZoomImageUrl("")}><X size={22} /></button>
        <img className="chat-image-lightbox-image" src={zoomImageUrl} alt="Просмотр материала" />
      </div>,
      document.body,
    )}
  </section>;
}

function AssignmentModuleCover({ assignment }: { assignment: Assignment }) {
  const modulePosition = Number.parseInt(assignment.module.slice(0, 2), 10);
  const coverPath = assignment.coverPath ?? discussionCoverForModule(Number.isNaN(modulePosition) ? undefined : modulePosition);
  return <section className="content-panel assignment-module-cover-panel"><div className="assignment-module-cover" role="img" aria-label={`Обложка ${assignment.module}`} style={{ backgroundImage: `linear-gradient(90deg, rgba(7,14,23,.94), rgba(7,14,23,.42)), url("${coverPath}")` }}><strong>{assignment.module}</strong></div></section>;
}

function PracticeAssignmentDetail({ assignment, onOpenDiscussion }: { assignment: Assignment; onOpenDiscussion: (context: DiscussionContext) => void }) {
  if (!assignment.id) {
    return <section className="content-panel assignment-detail directory-empty"><div className="empty-state"><FileCheck2 size={24} /><strong>Выбери опубликованное задание</strong><span>Когда куратор опубликует практическое задание, оно появится в этом списке.</span></div></section>;
  }
  return <section className="content-panel assignment-detail">
    <div className="detail-header"><div><span className="section-kicker">ПРАКТИЧЕСКОЕ ЗАДАНИЕ</span><h2>{assignment.title}</h2></div></div>
    <div className="detail-meta"><span><MessageSquareText size={14} /> Без срока сдачи</span></div>
    <div className="detail-body">
      <p className="detail-description">{assignment.description}</p>
      <div className="detail-feedback"><MessageSquareText size={17} /><div><strong>Ответ отправляется куратору в переписке</strong><p>Без дедлайна и формальных критериев — куратор проверит работу и оставит комментарий с рекомендациями. При необходимости обсуждение можно продолжить.</p></div></div>
      {assignment.lastMessage && <div className={`detail-feedback ${assignment.lastMessage.fromCurator ? "submitted" : ""}`}><MessageSquareText size={17} /><div><strong>{assignment.lastMessage.fromCurator ? "Куратор ответил" : "Твоё последнее сообщение"}</strong><p>{assignment.lastMessage.text}</p><small>{new Date(assignment.lastMessage.createdAt).toLocaleString("ru-RU")}</small></div></div>}
      {assignment.practicumCompleted ? <div className="detail-feedback locked"><LockKeyhole size={17} /><div><strong>Поток завершён</strong><p>Переписка выше осталась доступна для чтения, но написать куратору здесь уже нельзя.</p></div></div> : <div className="detail-actions"><button className="primary-button" onClick={() => onOpenDiscussion({ module: assignment.title, assignmentId: assignment.id, practicumCompleted: assignment.practicumCompleted })}>Ответить куратору <ChevronRight size={16} /></button></div>}
    </div>
  </section>;
}

function AssignmentDetail({ assignment, onOpenDiscussion }: { assignment: Assignment; onOpenDiscussion: (context: DiscussionContext) => void }) {
  return <div className="assignment-detail-stack">{assignment.id && <AssignmentModuleCover assignment={assignment} />}<AssignmentSubmissionSummary assignment={assignment} />{assignment.isPractice ? <PracticeAssignmentDetail assignment={assignment} onOpenDiscussion={onOpenDiscussion} /> : <LegacyAssignmentDetail assignment={assignment} />}<AssignmentMaterials materials={assignment.materials} /></div>;
}

function AssignmentSubmissionSummary({ assignment }: { assignment: Assignment }) {
  const [zoomImageUrl, setZoomImageUrl] = useState("");
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
        <div className="assignment-history-attempt-head"><span className={`attempt-dot ${dotTone}`} /><strong>Попытка {attempt.attempt}{isCurrent && history.length > 1 ? " · текущая" : ""}</strong></div>
        <div className="assignment-history-grid">
          <div><span className="detail-label">ТВОЙ ОТВЕТ</span><p>{attempt.answerText ? linkifyText(attempt.answerText) : (assignment.reviewRequired === false ? "Отмечено выполненным без ответа." : "Ответ отправлен вложением.")}</p></div>
          {attempt.feedback.length > 0 && <div className="assignment-history-feedback"><span className="detail-label">ОТВЕТ КУРАТОРА</span>{attempt.feedback.map((item) => <div key={item.id}>{item.text && <p>{linkifyText(item.text)}</p>}{item.attachments.map((file) => file.mimeType.startsWith("image/") ? <button type="button" key={file.id} className="assignment-history-feedback-image assignment-history-feedback-image-button" aria-label={`Увеличить изображение ${file.originalName}`} onClick={() => setZoomImageUrl(`${API_ORIGIN}${file.url}`)}><Image src={`${API_ORIGIN}${file.url}`} alt={file.originalName} fill sizes="320px" unoptimized /></button> : <a key={file.id} className="submission-file" href={`${API_ORIGIN}${file.url}`} target="_blank" rel="noreferrer"><FileCheck2 size={14} /><span>{file.originalName}</span><ArrowUpRight size={12} /></a>)}<small>{new Date(item.createdAt).toLocaleString("ru-RU")}</small></div>)}</div>}
        </div>
      </div>;
    })}</div>
    {zoomImageUrl && typeof document !== "undefined" && createPortal(
      <div className="chat-image-lightbox-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setZoomImageUrl(""); }}>
        <button type="button" className="chat-image-lightbox-close" aria-label="Закрыть просмотр" onClick={() => setZoomImageUrl("")}><X size={22} /></button>
        <img className="chat-image-lightbox-image" src={zoomImageUrl} alt="Просмотр вложения" />
      </div>,
      document.body,
    )}
  </section>;
}

function EventCard({ event, onOpen }: { event: (typeof studentDashboard.events)[number]; onOpen?: () => void }) {
  return <div className={`event-card ${event.live ? "" : "muted-event"}`}><div className="event-date"><strong>{event.day}</strong><span>{event.month}</span></div><div className="event-info"><div className="event-type">{event.live && <span className="live-dot" />} {event.type}</div><h3>{event.title}</h3><p><Clock3 size={14} /> {event.time}</p></div><button className="event-action" aria-label={`Открыть событие: ${event.title}`} onClick={onOpen}><ArrowUpRight size={17} /></button></div>;
}
