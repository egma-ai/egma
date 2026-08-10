import { StatePage, styles } from "../../ui.tsx";

/**
 * The code timed out, and saying so specifically is the whole job of this page.
 *
 * A stale code that reached a generic error would read as the product being
 * broken. It is not: codes are short-lived on purpose, so that one left on a
 * screen overnight cannot be used by whoever walks past it in the morning.
 */
export default function DeviceExpiredPage() {
  return (
    <StatePage
      title="That code expired"
      lead="Codes are short-lived, so one left sitting for a while stops working. Nothing went wrong and nothing was granted."
    >
      <p className={styles.linkLine}>
        Run <code>egma login</code> in your terminal again for a fresh code, or{" "}
        <a href="/device">enter a code</a> if you already have a new one.
      </p>
    </StatePage>
  );
}
