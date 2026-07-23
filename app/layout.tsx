import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FIX | Практикум",
  description: "Учебный кабинет трейдера",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
