import { SessionLoading } from "../ui/session-loading.tsx";

/**
 * What the router draws between the press and `/` arriving.
 *
 * It is the entrance's own waiting state, which is now the same one the
 * entrance shows while the session read is in flight — so the route change and
 * the read behind it are one wait rather than two screens replacing each other.
 * **It has no delay, and that is a trade rather than an oversight.** The other
 * route fallbacks in this application wait `--duration-popover-in` before
 * drawing anything, so a warm route is never covered by a box that appears and
 * vanishes. This one is opaque on its first frame instead: a shell is mounted
 * at the root address, and a fifth of a second of transparency here is a fifth
 * of a second of the dashboard showing to somebody who may not be signed in.
 * Being early costs a brief mark on a warm load; being late costs the guess.
 */
export default function EntranceLoading() {
  return <SessionLoading label="Opening Egma" />;
}
