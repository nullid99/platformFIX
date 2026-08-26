"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Info, LockKeyhole } from "lucide-react";
import { useEffect, useState } from "react";

type Lang = "ua" | "en";

const translations: Record<Lang, {
  nav: { practicum: string; discordCommunity: string; faq: string };
  consultation: string;
  closedAccess: string;
  heroTitle: string;
  introNote: string;
  personalInvite: string;
  continueSignIn: string;
  panelDescription: string;
  inviteRequiredTitle: string;
  inviteRequiredText: string;
  failedTitle: string;
  failedText: string;
  linkReadyTitle: string;
  linkReadyText: string;
  devicePendingTitle: string;
  devicePendingText: string;
  discordButton: string;
  or: string;
  noLinkTitle: string;
  noLinkText: string;
  devPanelKicker: string;
  devPanelTitle: string;
  devPanelNote: string;
  loginAsCurator: string;
  loginAsStudent: string;
  devLoginError: string;
  backLink: string;
  backToFix: string;
  navAria: string;
  langAria: string;
}> = {
  ua: {
    nav: { practicum: "Практикум", discordCommunity: "Discord community", faq: "Часті питання" },
    consultation: "Отримати консультацію",
    closedAccess: "ЗАКРЫТЫЙ ДОСТУП",
    heroTitle: "Вход в учебное пространство",
    introNote: "Доступ к практикуму открывается только по персональному приглашению.",
    personalInvite: "Персональное приглашение",
    continueSignIn: "Продолжить вход",
    panelDescription: "Открой ссылку из сообщения менеджера и подтверди личность через Discord.",
    inviteRequiredTitle: "Нужна персональная ссылка",
    inviteRequiredText: "Для первого входа открой приглашение менеджера, а затем подтверди Discord-аккаунт.",
    failedTitle: "Не удалось завершить вход",
    failedText: "Попробуй запустить вход ещё раз. Если ошибка повторится, проверь приглашение.",
    linkReadyTitle: "Ссылка готова к активации",
    linkReadyText: "Подтверди вход через Discord, чтобы продолжить.",
    devicePendingTitle: "Устройство отправлено на подтверждение",
    devicePendingText: "Первые два устройства доступны сразу. Для этого устройства владелец или назначенный куратор должен разрешить доступ в карточке участника.",
    discordButton: "Продолжить через Discord",
    or: "или",
    noLinkTitle: "Нет ссылки?",
    noLinkText: "Напиши менеджеру, чтобы получить персональное приглашение.",
    devPanelKicker: "ЛОКАЛЬНЫЙ ТЕСТ",
    devPanelTitle: "Проверить роли без Discord",
    devPanelNote: "Тестовые аккаунты не используются в production.",
    loginAsCurator: "Войти как куратор",
    loginAsStudent: "Войти как ученик",
    devLoginError: "Локальный тестовый вход отключён или аккаунт не найден.",
    backLink: "Вернуться к просмотру платформы",
    backToFix: "Вернуться в FIX",
    navAria: "Навігація",
    langAria: "Мова",
  },
  en: {
    nav: { practicum: "Practicum", discordCommunity: "Discord community", faq: "FAQ" },
    consultation: "Get a consultation",
    closedAccess: "PRIVATE ACCESS",
    heroTitle: "Sign in to the learning space",
    introNote: "Access to the practicum is available by personal invitation only.",
    personalInvite: "Personal invitation",
    continueSignIn: "Continue signing in",
    panelDescription: "Open the link from your manager's message and confirm your identity via Discord.",
    inviteRequiredTitle: "Personal link required",
    inviteRequiredText: "For your first sign-in, open the manager's invitation, then confirm your Discord account.",
    failedTitle: "Sign-in failed",
    failedText: "Try signing in again. If the error repeats, check your invitation.",
    linkReadyTitle: "Link ready to activate",
    linkReadyText: "Confirm sign-in via Discord to continue.",
    devicePendingTitle: "Device sent for approval",
    devicePendingText: "The first two devices are approved automatically. For this device, the owner or assigned curator must grant access in the participant's card.",
    discordButton: "Continue with Discord",
    or: "or",
    noLinkTitle: "No link?",
    noLinkText: "Message your manager to get a personal invitation.",
    devPanelKicker: "LOCAL TEST",
    devPanelTitle: "Check roles without Discord",
    devPanelNote: "Test accounts are not used in production.",
    loginAsCurator: "Sign in as curator",
    loginAsStudent: "Sign in as student",
    devLoginError: "Local test sign-in is disabled or the account was not found.",
    backLink: "Back to platform overview",
    backToFix: "Back to FIX",
    navAria: "Navigation",
    langAria: "Language",
  },
};

export default function AuthPage() {
  const [authState, setAuthState] = useState("");
  const [devLoginError, setDevLoginError] = useState("");
  const [lang, setLang] = useState<Lang>("ua");
  const t = translations[lang];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setAuthState(new URLSearchParams(window.location.search).get("auth") ?? "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const handleDiscordLogin = () => {
    const startUrl = new URL("/api/auth/discord/start", window.location.origin);
    const invitationToken = new URLSearchParams(window.location.search).get("invite");
    if (invitationToken) startUrl.searchParams.set("invite", invitationToken);
    window.location.assign(startUrl.toString());
  };

  const handleDevLogin = async (role: "STUDENT" | "CURATOR") => {
    setDevLoginError("");
    const response = await fetch("/api/auth/dev-login", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Device-Name": "Local test browser" },
      body: JSON.stringify({ role }),
    });

    if (!response.ok) {
      setDevLoginError(t.devLoginError);
      return;
    }

    window.location.assign("/");
  };

  return (
    <main className="auth-shell">
      <div className="auth-background" aria-hidden="true" />
      <header className="auth-topbar">
        <Link className="auth-brand" href="/" aria-label={t.backToFix}>
          <span className="auth-wordmark"><Image src="/fix-wordmark.png" alt="FIX" width={64} height={30} priority /></span>
        </Link>
        <nav className="auth-main-nav" aria-label={t.navAria}>
          <span>{t.nav.practicum}</span>
          <span>{t.nav.discordCommunity}</span>
          <span>{t.nav.faq}</span>
        </nav>
        <div className="auth-topbar-actions">
          <div className="auth-languages" aria-label={t.langAria}>
            <button type="button" className={lang === "ua" ? "is-active" : ""} onClick={() => setLang("ua")}>UA</button>
            <button type="button" className={lang === "en" ? "is-active" : ""} onClick={() => setLang("en")}>EN</button>
          </div>
          <button className="auth-consultation-button" type="button">{t.consultation}</button>
        </div>
      </header>

      <section className="auth-layout">
        <div className="auth-intro">
          <span className="eyebrow">
            <Image className="auth-lock-icon" src="/auth-lock.png" alt="" width={24} height={24} priority />
            {t.closedAccess}
          </span>
          <h1>{t.heroTitle}</h1>
          <p className="auth-intro-note">
            <Info aria-hidden="true" size={20} strokeWidth={2.25} />
            <span>{t.introNote}</span>
          </p>
        </div>

        <div className="auth-panel">
          <div className="auth-panel-heading">
            <span className="section-kicker">{t.personalInvite}</span>
            <h2>{t.continueSignIn}</h2>
            <p>{t.panelDescription}</p>
          </div>
          {authState === "invite-required" && <div className="auth-error" role="alert"><strong>{t.inviteRequiredTitle}</strong><span>{t.inviteRequiredText}</span></div>}
          {authState === "failed" && <div className="auth-error" role="alert"><strong>{t.failedTitle}</strong><span>{t.failedText}</span></div>}
          <div className="auth-invitation-state"><strong>{t.linkReadyTitle}</strong><small>{t.linkReadyText}</small></div>
          {authState === "device-pending" && <div className="auth-pending" role="status"><strong>{t.devicePendingTitle}</strong><span>{t.devicePendingText}</span></div>}
          <button className="auth-discord-button" type="button" onClick={handleDiscordLogin}>
            {t.discordButton}
            <ArrowUpRight size={16} />
          </button>
          <div className="auth-divider"><span>{t.or}</span></div>
          <div className="auth-invite-note">
            <div className="auth-note-icon"><LockKeyhole size={16} /></div>
            <div><strong>{t.noLinkTitle}</strong><span>{t.noLinkText}</span></div>
          </div>
          {process.env.NEXT_PUBLIC_DEV_AUTH_ENABLED === "true" && <div className="auth-dev-panel">
            <span className="section-kicker">{t.devPanelKicker}</span>
            <strong>{t.devPanelTitle}</strong>
            <span>{t.devPanelNote}</span>
            <div className="auth-dev-actions">
              <button type="button" onClick={() => void handleDevLogin("CURATOR")}>{t.loginAsCurator}</button>
              <button type="button" onClick={() => void handleDevLogin("STUDENT")}>{t.loginAsStudent}</button>
            </div>
            {devLoginError && <small className="auth-dev-error" role="alert">{devLoginError}</small>}
          </div>}
          <Link className="auth-back-link" href="/"><ArrowLeft size={15} /> {t.backLink}</Link>
        </div>
      </section>
    </main>
  );
}
