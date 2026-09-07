import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Flatten conditional classes with clsx, then resolve conflicts recognized
 * by tailwind-merge. Keep this import path in step with components.json.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
