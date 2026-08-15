"use client";

import { useEffect, useState } from "react";

import {
  nextTheme,
  THEME_STORAGE_KEY,
  themeFromStored,
  type Theme,
} from "../lib/presentation.ts";

/**
 * Light or dark, and the one place that changes it.
 *
 * Two controls offer the switch — the access pages carry one in a corner, the
 * product carries one in the account menu — and both read the same document
 * attribute and write the same key, so a page holding two of them never shows
 * them disagreeing.
 */

const THEME_CHANGE_EVENT = "egma:theme-change";

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const readTheme = () => {
      setTheme(themeFromStored(document.documentElement.dataset.theme ?? null));
    };
    readTheme();
    window.addEventListener(THEME_CHANGE_EVENT, readTheme);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, readTheme);
  }, []);

  function toggle(): void {
    const next = nextTheme(theme);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Theme still changes for this page when storage is unavailable.
    }
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }

  return { theme, toggle };
}
