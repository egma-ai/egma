import type { Metadata } from "next";
import { IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { notFound } from "next/navigation";

import { ShellPrototype } from "./shells.tsx";

export const metadata: Metadata = {
  title: "Egma UI prototype",
  robots: { index: false, follow: false },
};

const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--prototype-sans",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--prototype-mono",
  weight: ["400", "500", "600"],
});

/**
 * PROTOTYPE ONLY: three application shells around the same real page shapes.
 * Variant C is already the brand direction. This route now answers the open
 * product-shell question and never renders in production.
 */
export default function DesignSystemPrototypePage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <div className={`${sans.variable} ${mono.variable}`}>
      <ShellPrototype />
    </div>
  );
}
