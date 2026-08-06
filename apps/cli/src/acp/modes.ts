/**
 * Picking the mode that stops an agent asking.
 *
 * Zero questions needs both belts: the agent starts in its most permissive
 * mode, *and* the client approves every permission request that still arrives.
 * Either belt alone is unreliable, because an adapter inherits whatever the
 * developer has configured locally. This module is the first belt.
 */

import type { SessionModeState } from "@agentclientprotocol/sdk";

/**
 * Mode ids that mean "do not ask", best first. Different agents name the same
 * posture differently, and the protocol treats a mode id as opaque, so the list
 * is matched against what the agent says it offers and never assumed.
 */
export const ZERO_PROMPT_MODES = [
  "bypassPermissions",
  "agent-full-access",
  "full-access",
  "dontAsk",
  "acceptEdits",
  "auto",
] as const;

/**
 * The mode to switch to, or `null` when the agent already sits in the best one
 * it offers — or offers none at all, which leaves the second belt to carry it.
 */
export function zeroPromptMode(state: SessionModeState | null | undefined): string | null {
  if (!state) return null;
  const available = new Set(state.availableModes.map((mode) => mode.id));
  const best = ZERO_PROMPT_MODES.find((mode) => available.has(mode));
  if (best === undefined || best === state.currentModeId) return null;
  return best;
}
