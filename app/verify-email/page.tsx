"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, CircleAlert, MailCheck } from "lucide-react";

type VerifyState = "loading" | "success" | "error";

export default function VerifyEmailPage() {
  const [state, setState] = useState<VerifyState>("loading");
  const [message, setMessage] = useState("Проверяем ссылку…");

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      window.setTimeout(() => {
        setState("error");
        setMessage("Ссылка подтверждения не найдена.");
      }, 0);
      return;
    }

    void fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        if (!response.ok) throw new Error(payload?.message ?? "Ссылка недействительна или уже использована.");
        setState("success");
        setMessage("Email подтверждён. Теперь на него будут приходить уведомления FIX Platform.");
      })
      .catch((error) => {
        setState("error");
        setMessage(error instanceof Error ? error.message : "Не удалось подтвердить email.");
      });
  }, []);

  const isSuccess = state === "success";
  return (
    <main className="auth-shell">
      <div className="auth-background" aria-hidden="true" />
      <div className="email-verify-layout">
        <section className="auth-panel email-verify-card">
          <div className={`email-verify-icon ${isSuccess ? "success" : state === "error" ? "error" : "loading"}`}>
            {isSuccess ? <CheckCircle2 size={30} /> : state === "error" ? <CircleAlert size={30} /> : <MailCheck size={30} />}
          </div>
          <span className="section-kicker">FIX PLATFORM · EMAIL</span>
          <h1>{isSuccess ? "Email подтверждён" : state === "error" ? "Не удалось подтвердить email" : "Подтверждение email"}</h1>
          <p>{message}</p>
          <Link className="auth-back-link" href="/?view=profile"><ArrowLeft size={15} /> Вернуться в платформу</Link>
        </section>
      </div>
    </main>
  );
}
