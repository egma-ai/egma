import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";

import { ProductShellBoundary } from "../ui/shell.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "Egma",
  description: "Trust the voice agent you ship to production.",
  icons: {
    icon: [
      {
        url: "/brand/egma-mark-light.svg",
        type: "image/svg+xml",
        sizes: "any",
        media: "(prefers-color-scheme: light)",
      },
      {
        url: "/brand/egma-mark-dark.svg",
        type: "image/svg+xml",
        sizes: "any",
        media: "(prefers-color-scheme: dark)",
      },
    ],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--egma-mono",
  weight: ["400", "500"],
});

const themeScript = `try{var t=localStorage.getItem("egma-theme");document.documentElement.dataset.theme=t==="dark"?"dark":"light"}catch(e){document.documentElement.dataset.theme="light"}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={mono.variable}
      data-theme="light"
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ProductShellBoundary>{children}</ProductShellBoundary>
      </body>
    </html>
  );
}
