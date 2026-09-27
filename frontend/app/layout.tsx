import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";

import { ThemeWatcher } from "@/lib/themeMode";
import { THEME_BAR, THEME_SCRIPT } from "@/lib/themeScript";
import "./globals.css";

// Figtree for everything: body 400/500, labels 600, headings and the logo 700-800 (a variable font: every weight).
const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BlindSpot",
  description: "Maps show you traffic. BlindSpot shows you why, and when to leave.",
  // "default", not "black-translucent": the page must not run under the iOS status bar (no safe-area offsets).
  appleWebApp: { capable: true, title: "BlindSpot", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_BAR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_BAR.dark },
  ],
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme script sets data-theme before the first paint, so the server's html differs from the DOM on purpose.
    <html lang="en" className={`${figtree.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full bg-bg text-ink">
        <ThemeWatcher />
        {children}
      </body>
    </html>
  );
}
