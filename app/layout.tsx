import type { Metadata } from "next";
import { DM_Mono, Inter, Roboto_Mono } from "next/font/google";
import "./globals.css";

// Same three Google families and the same discrete weights the stylesheet used to @import from
// fonts.googleapis.com — now downloaded once at build time and served from our own origin, so
// first paint no longer waits on a three-hop round trip to Google. Discrete weights (not the
// variable range) keep the one `font-weight: 750` snapping to 700/800 exactly as before.
const inter = Inter({ subsets: ["latin", "cyrillic"], weight: ["400", "500", "600", "700", "800"], display: "swap", variable: "--font-inter" });
const robotoMono = Roboto_Mono({ subsets: ["latin", "cyrillic"], weight: ["400", "500", "700"], display: "swap", variable: "--font-roboto-mono" });
// DM Mono has no Cyrillic glyphs on Google Fonts; Cyrillic in these elements fell through to the
// generic monospace fallback before, and still does.
const dmMono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--font-dm-mono" });

export const metadata: Metadata = {
  title: "FIX | Практикум",
  description: "Учебный кабинет трейдера",
};

// Runs before React hydrates (blocking, inline) so the light theme doesn't flash dark-then-light
// on load — a `useEffect` doing this same read would paint the wrong theme first. Kept a plain
// string of JS (not a shared .ts file) since it must inline into the HTML, not load as a module.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("fix-theme");if(t==="light")document.documentElement.setAttribute("data-theme","light");}catch(e){}})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={`${inter.variable} ${robotoMono.variable} ${dmMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
