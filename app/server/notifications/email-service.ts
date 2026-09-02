const RESEND_ENDPOINT = "https://api.resend.com/emails";

type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  // HTML-only mail (no multipart/alternative plain-text part) is a well-known spam-filter
  // signal on its own — every sender below now supplies one alongside the HTML.
  text: string;
};

type ReviewNotificationInput = {
  to: string;
  assignmentTitle: string;
  decision: "accepted" | "revision";
  feedback?: string;
};

type InvitationNotificationInput = {
  to: string;
  token: string;
  expiresAt: Date;
  role: string;
};

type EmailVerificationNotificationInput = {
  to: string;
  token: string;
};

type ContentNotificationInput = {
  eyebrow: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaPath: string;
  accent?: string;
};

type DiscussionNotificationInput = {
  to: string;
  threadTitle: string;
  senderName: string;
  body: string;
  threadId: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>\"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] ?? character);
}

function webOrigin(): string {
  return process.env.PUBLIC_WEB_ORIGIN?.trim() || process.env.WEB_ORIGIN?.trim() || "http://localhost:3000";
}

function logoUrl(): string {
  return process.env.EMAIL_LOGO_URL?.trim() || `${webOrigin().replace(/\/$/, "")}/fix-logo.jpg`;
}

function notificationHtml(input: ContentNotificationInput): string {
  const accent = input.accent ?? "#78adff";
  const href = `${webOrigin().replace(/\/$/, "")}${input.ctaPath.startsWith("/") ? input.ctaPath : `/${input.ctaPath}`}`;
  return `<!doctype html><html><body style="margin:0;background:#080d14;font-family:Arial,sans-serif;color:#dce8f5"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080d14;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#101923;border:1px solid #29405a"><tr><td style="padding:22px 26px;background:#14263e;border-bottom:1px solid #315b88"><img src="${escapeHtml(logoUrl())}" width="42" height="42" alt="FIX" style="display:block;border-radius:8px;margin-bottom:14px"><div style="font-size:11px;letter-spacing:2px;color:#82b4ff">FIX PLATFORM</div><h1 style="margin:10px 0 0;font-size:24px;color:#fff">${escapeHtml(input.title)}</h1></td></tr><tr><td style="padding:26px"><div style="display:inline-block;padding:7px 10px;border:1px solid ${accent};color:${accent};font-size:11px;letter-spacing:1px">${escapeHtml(input.eyebrow)}</div><p style="margin:22px 0 0;color:#c4d4e5;font-size:15px;line-height:1.6">${escapeHtml(input.body)}</p><a href="${escapeHtml(href)}" style="display:inline-block;margin-top:24px;padding:12px 18px;background:#78adff;color:#08111b;text-decoration:none;font-weight:bold;font-size:13px">${escapeHtml(input.ctaLabel)}</a></td></tr><tr><td style="padding:16px 26px;border-top:1px solid #22354a;color:#63778d;font-size:11px">FIX Platform · Это автоматическое уведомление, отвечать на него не нужно.</td></tr></table></td></tr></table></body></html>`;
}

function notificationText(input: ContentNotificationInput): string {
  const href = `${webOrigin().replace(/\/$/, "")}${input.ctaPath.startsWith("/") ? input.ctaPath : `/${input.ctaPath}`}`;
  return `${input.eyebrow}\n\n${input.title}\n\n${input.body}\n\n${input.ctaLabel}: ${href}\n\n—\nFIX Platform. Это автоматическое уведомление, отвечать на него не нужно.`;
}

export async function sendEmail(message: EmailMessage): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || "FIX Platform <onboarding@resend.dev>";
  if (!apiKey) return false;
  const backgroundUrl = process.env.EMAIL_BACKGROUND_URL?.trim();
  const logoSafeHtml = message.html.replace(/<img src="http:\/\/localhost[^\"]*"[^>]*alt="FIX"[^>]*>/i, "<div style=\"width:42px;height:42px;line-height:42px;text-align:center;border-radius:8px;background:#1877f2;color:#fff;font-weight:bold;margin-bottom:14px\">FIX</div>");
  const html = backgroundUrl
    ? logoSafeHtml.replace("style=\"background:#080d14;padding:28px 12px\"", `style=\"background:#080d14 url('${escapeHtml(backgroundUrl)}') center / cover no-repeat;padding:28px 12px\"`)
    : logoSafeHtml;

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [message.to], subject: message.subject, html, text: message.text }),
  });
  if (!response.ok) throw new Error(`Resend request failed with status ${response.status}`);
  return true;
}

export async function sendReviewNotification(input: ReviewNotificationInput): Promise<void> {
  const accepted = input.decision === "accepted";
  const title = accepted ? "Домашнее задание принято" : "Домашнее задание отправлено на доработку";
  const feedback = input.feedback?.trim();
  const webOrigin = process.env.PUBLIC_WEB_ORIGIN?.trim() || process.env.WEB_ORIGIN?.trim() || "http://localhost:3000";
  const logoUrl = process.env.EMAIL_LOGO_URL?.trim() || `${webOrigin.replace(/\/$/, "")}/fix-logo.jpg`;
  const accent = accepted ? "#58d3c7" : "#eab46b";
  try {
    await sendEmail({
      to: input.to,
      subject: `${title} · ${input.assignmentTitle}`,
      html: `<!doctype html><html><body style="margin:0;background:#080d14;font-family:Arial,sans-serif;color:#dce8f5"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080d14;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#101923;border:1px solid #29405a"><tr><td style="padding:22px 26px;background:#14263e;border-bottom:1px solid #315b88"><img src="${escapeHtml(logoUrl)}" width="42" height="42" alt="FIX" style="display:block;border-radius:8px;margin-bottom:14px"><div style="font-size:11px;letter-spacing:2px;color:#82b4ff">FIX PLATFORM</div><h1 style="margin:10px 0 0;font-size:24px;color:#fff">${title}</h1></td></tr><tr><td style="padding:26px"><div style="display:inline-block;padding:7px 10px;border:1px solid ${accent};color:${accent};font-size:11px;letter-spacing:1px">${accepted ? "ПРИНЯТО" : "НУЖНА ДОРАБОТКА"}</div><p style="margin:22px 0 8px;color:#8297ad;font-size:12px">ДОМАШНЕЕ ЗАДАНИЕ</p><h2 style="margin:0;color:#fff;font-size:20px">${escapeHtml(input.assignmentTitle)}</h2>${feedback ? `<div style="margin-top:22px;padding:16px;background:#152333;border-left:3px solid ${accent}"><div style="margin-bottom:8px;color:#8297ad;font-size:11px">КОММЕНТАРИЙ КУРАТОРА</div><div style="color:#dce8f5;font-size:14px;line-height:1.6">${escapeHtml(feedback)}</div></div>` : ""}<a href="${escapeHtml(webOrigin)}" style="display:inline-block;margin-top:24px;padding:12px 18px;background:#78adff;color:#08111b;text-decoration:none;font-weight:bold;font-size:13px">Открыть платформу</a></td></tr><tr><td style="padding:16px 26px;border-top:1px solid #22354a;color:#63778d;font-size:11px">FIX Platform · Это автоматическое уведомление, отвечать на него не нужно.</td></tr></table></td></tr></table></body></html>`,
      text: `${title}\n\n${input.assignmentTitle}${feedback ? `\n\nКомментарий куратора: ${feedback}` : ""}\n\nОткрыть платформу: ${webOrigin}\n\n—\nFIX Platform. Это автоматическое уведомление, отвечать на него не нужно.`,
    });
  } catch (error) {
    console.error("Email notification delivery failed", error instanceof Error ? error.message : "unknown error");
  }
}

export async function sendInvitationNotification(input: InvitationNotificationInput): Promise<boolean> {
  const webOrigin = process.env.PUBLIC_WEB_ORIGIN?.trim() || process.env.WEB_ORIGIN?.trim() || "http://localhost:3000";
  const logoUrl = process.env.EMAIL_LOGO_URL?.trim() || `${webOrigin.replace(/\/$/, "")}/fix-logo.jpg`;
  const inviteUrl = `${webOrigin.replace(/\/$/, "")}/?invite=${encodeURIComponent(input.token)}`;
  try {
    return await sendEmail({
      to: input.to,
      subject: "Персональное приглашение в FIX Platform",
      html: `<!doctype html><html><body style="margin:0;background:#080d14;font-family:Arial,sans-serif;color:#dce8f5"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080d14;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#101923;border:1px solid #29405a"><tr><td style="padding:22px 26px;background:#14263e;border-bottom:1px solid #315b88"><img src="${escapeHtml(logoUrl)}" width="42" height="42" alt="FIX" style="display:block;border-radius:8px;margin-bottom:14px"><div style="font-size:11px;letter-spacing:2px;color:#82b4ff">FIX PLATFORM</div><h1 style="margin:10px 0 0;font-size:24px;color:#fff">Тебя пригласили в практикум</h1></td></tr><tr><td style="padding:26px"><p style="margin:0;color:#a9bdd2;font-size:14px;line-height:1.6">Персональная ссылка готова. Подтверди вход через Discord, чтобы открыть учебное пространство.</p><div style="margin-top:20px;padding:15px;background:#102b2c;border-left:3px solid #58d3c7;color:#bcece7;font-size:13px">Роль: ${input.role === "STUDENT" ? "Ученик" : "Куратор"}<br>Ссылка действует до: ${escapeHtml(input.expiresAt.toLocaleString("ru-RU"))}</div><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;margin-top:24px;padding:12px 18px;background:#78adff;color:#08111b;text-decoration:none;font-weight:bold;font-size:13px">Активировать приглашение</a></td></tr><tr><td style="padding:16px 26px;border-top:1px solid #22354a;color:#63778d;font-size:11px">FIX Platform · Ссылка одноразовая.</td></tr></table></td></tr></table></body></html>`,
      text: `Тебя пригласили в практикум FIX Platform.\n\nРоль: ${input.role === "STUDENT" ? "Ученик" : "Куратор"}\nСсылка действует до: ${input.expiresAt.toLocaleString("ru-RU")}\n\nАктивировать приглашение: ${inviteUrl}\n\n—\nFIX Platform. Ссылка одноразовая.`,
    });
  } catch (error) {
    console.error("Invitation email delivery failed", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

export async function sendEmailVerificationNotification(input: EmailVerificationNotificationInput): Promise<boolean> {
  const webOrigin = process.env.PUBLIC_WEB_ORIGIN?.trim() || process.env.WEB_ORIGIN?.trim() || "http://localhost:3000";
  const logoUrl = process.env.EMAIL_LOGO_URL?.trim() || `${webOrigin.replace(/\/$/, "")}/fix-logo.jpg`;
  const verifyUrl = `${webOrigin.replace(/\/$/, "")}/verify-email?token=${encodeURIComponent(input.token)}`;
  try {
    return await sendEmail({
      to: input.to,
      subject: "Подтвердите email · FIX Platform",
      html: `<!doctype html><html><body style="margin:0;background:#080d14;font-family:Arial,sans-serif;color:#dce8f5"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#080d14;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#101923;border:1px solid #29405a"><tr><td style="padding:22px 26px;background:#14263e;border-bottom:1px solid #315b88"><img src="${escapeHtml(logoUrl)}" width="42" height="42" alt="FIX" style="display:block;border-radius:8px;margin-bottom:14px"><div style="font-size:11px;letter-spacing:2px;color:#82b4ff">FIX PLATFORM</div><h1 style="margin:10px 0 0;font-size:24px;color:#fff">Подтвердите email</h1></td></tr><tr><td style="padding:26px"><p style="margin:0;color:#c4d4e5;font-size:15px;line-height:1.6">Нажмите кнопку, чтобы подтвердить адрес и получать уведомления о заданиях, стримах и обсуждениях.</p><a href="${escapeHtml(verifyUrl)}" style="display:inline-block;margin-top:24px;padding:12px 18px;background:#78adff;color:#08111b;text-decoration:none;font-weight:bold;font-size:13px">Подтвердить email</a><p style="margin:22px 0 0;color:#71859a;font-size:11px;line-height:1.5">Ссылка действует 24 часа и одноразовая.</p></td></tr><tr><td style="padding:16px 26px;border-top:1px solid #22354a;color:#63778d;font-size:11px">FIX Platform · Если вы не меняли email, просто проигнорируйте это письмо.</td></tr></table></td></tr></table></body></html>`,
      text: `Подтвердите email, чтобы получать уведомления о заданиях, стримах и обсуждениях.\n\nПодтвердить: ${verifyUrl}\n\nСсылка действует 24 часа и одноразовая.\n\n—\nFIX Platform. Если вы не меняли email, просто проигнорируйте это письмо.`,
    });
  } catch (error) {
    console.error("Email verification delivery failed", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

export async function sendNewAssignmentNotification(input: { to: string; assignmentTitle: string; moduleTitle: string; assignmentId: string }): Promise<void> {
  try {
    const content: ContentNotificationInput = {
      eyebrow: "НОВОЕ ДОМАШНЕЕ ЗАДАНИЕ",
      title: input.assignmentTitle,
      body: `В модуле «${input.moduleTitle}» опубликовано новое задание. Откройте платформу, чтобы посмотреть условия и срок сдачи.`,
      ctaLabel: "Открыть задания",
      // The app is a single-page client (only "/" is a real route — /assignments,
      // /schedule, /streams, /discussions all 404). Deep-link targets are passed as
      // query params on "/" and resolved client-side once the session loads, same as
      // the existing ?invite= handling.
      ctaPath: `/?assignmentId=${encodeURIComponent(input.assignmentId)}`,
      accent: "#eab46b",
    };
    await sendEmail({ to: input.to, subject: `Новое домашнее задание · ${input.assignmentTitle}`, html: notificationHtml(content), text: notificationText(content) });
  } catch (error) {
    console.error("Assignment email delivery failed", error instanceof Error ? error.message : "unknown error");
  }
}

export async function sendNewEventNotification(input: { to: string; eventTitle: string; eventDate: string; eventId: string }): Promise<void> {
  try {
    const content: ContentNotificationInput = {
      eyebrow: "НОВОЕ СОБЫТИЕ В РАСПИСАНИИ",
      title: input.eventTitle,
      body: `В расписании появилось новое событие на ${input.eventDate}. Откройте расписание, чтобы посмотреть детали.`,
      ctaLabel: "Открыть расписание",
      ctaPath: `/?eventId=${encodeURIComponent(input.eventId)}`,
      accent: "#58d3c7",
    };
    await sendEmail({ to: input.to, subject: `Новое событие · ${input.eventTitle}`, html: notificationHtml(content), text: notificationText(content) });
  } catch (error) {
    console.error("Schedule event email delivery failed", error instanceof Error ? error.message : "unknown error");
  }
}

export async function sendScheduleReminderNotification(input: { to: string; eventTitle: string; eventTypeLabel: string; eventTime: string; eventId: string }): Promise<void> {
  try {
    const content: ContentNotificationInput = {
      eyebrow: "СКОРО НАЧАЛО",
      title: input.eventTitle,
      body: `${input.eventTypeLabel} начнётся через 15 минут (${input.eventTime}). Проверьте, что всё готово к эфиру.`,
      ctaLabel: "Открыть расписание",
      ctaPath: `/?eventId=${encodeURIComponent(input.eventId)}`,
      accent: "#eab46b",
    };
    await sendEmail({ to: input.to, subject: `Через 15 минут · ${input.eventTitle}`, html: notificationHtml(content), text: notificationText(content) });
  } catch (error) {
    console.error("Schedule reminder email delivery failed", error instanceof Error ? error.message : "unknown error");
  }
}

export async function sendStreamLiveNotification(input: { to: string; topic: string | null }): Promise<void> {
  try {
    const content: ContentNotificationInput = {
      eyebrow: "ПРЯМОЙ ЭФИР",
      title: input.topic ?? "Куратор начал трансляцию",
      body: "Эфир уже идёт на платформе — заходите, пока не пропустили начало.",
      ctaLabel: "Смотреть эфир",
      ctaPath: "/",
      accent: "#ed7777",
    };
    await sendEmail({ to: input.to, subject: input.topic ? `Эфир начался · ${input.topic}` : "Эфир начался", html: notificationHtml(content), text: notificationText(content) });
  } catch (error) {
    console.error("Stream live email delivery failed", error instanceof Error ? error.message : "unknown error");
  }
}

export async function sendNewMediaNotification(input: { to: string; mediaTitle: string; kind: string; mediaId: string }): Promise<void> {
  try {
    const content: ContentNotificationInput = {
      eyebrow: input.kind === "QA" ? "НОВАЯ ЗАПИСЬ Q&A" : "НОВАЯ ЗАПИСЬ В МАТЕРИАЛАХ",
      title: input.mediaTitle,
      body: "Куратор добавил новую запись в учебные материалы. Её уже можно открыть на платформе.",
      ctaLabel: "Открыть материалы",
      ctaPath: `/?mediaId=${encodeURIComponent(input.mediaId)}`,
      accent: "#58d3c7",
    };
    await sendEmail({ to: input.to, subject: `Новая запись · ${input.mediaTitle}`, html: notificationHtml(content), text: notificationText(content) });
  } catch (error) {
    console.error("Media email delivery failed", error instanceof Error ? error.message : "unknown error");
  }
}

export async function sendDiscussionNotification(input: DiscussionNotificationInput): Promise<void> {
  try {
    const content: ContentNotificationInput = {
      eyebrow: "ОБСУЖДЕНИЕ",
      title: input.threadTitle,
      body: `${input.senderName} оставил новое сообщение: «${input.body.slice(0, 240)}${input.body.length > 240 ? "…" : ""}»`,
      ctaLabel: "Открыть обсуждение",
      ctaPath: `/?threadId=${encodeURIComponent(input.threadId)}`,
      accent: "#78adff",
    };
    await sendEmail({ to: input.to, subject: `Новое сообщение в обсуждении · ${input.threadTitle}`, html: notificationHtml(content), text: notificationText(content) });
  } catch (error) {
    console.error("Discussion email delivery failed", error instanceof Error ? error.message : "unknown error");
  }
}
