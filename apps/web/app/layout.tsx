import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import type { ReactNode } from "react";

import "./globals.css";

export const metadata: Metadata = {
  title: "egma",
  description: "Trust the voice agent you ship to production.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const sans = Instrument_Sans({ subsets: ["latin"], variable: "--egma-sans" });
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--egma-mono",
  weight: ["400", "500", "600"],
});

const themeScript = `try{var t=localStorage.getItem("egma-theme");document.documentElement.dataset.theme=t==="dark"?"dark":"light"}catch(e){document.documentElement.dataset.theme="light"}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable}`}
      data-theme="light"
      suppressHydrationWarning
    >
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>{children}</body>
    </html>
  );
}
