import { SessionLoading } from "../ui/session-loading.tsx";

/**
 * Cover the root immediately while session resolution and redirect are pending.
 * Unlike delayed route fallbacks, this must not briefly expose the product shell.
 */
export default function EntranceLoading() {
  return <SessionLoading label="Opening Egma" />;
}
