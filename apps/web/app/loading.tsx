import { SessionLoading } from "../ui/session-loading.tsx";

/**
 * What the router draws between the press and `/` arriving.
 *
 * It is the entrance's own waiting state, which is now the same one the
 * entrance shows while the session read is in flight — so the route change and
 * the read behind it are one wait rather than two screens replacing each other.
 * `SessionLoading` owns the delay before it draws, so a warm route still
 * arrives without this ever having been on screen.
 */
export default function EntranceLoading() {
  return <SessionLoading label="Opening Egma" />;
}
