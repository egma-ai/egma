import { StatePage, styles } from "../../ui.tsx";

/**
 * The end of it. The browser has nothing left to do and says so, because a page
 * that just sits there leaves a person waiting for something that already
 * happened.
 */
export default function DeviceApprovedPage() {
  return (
    <StatePage
      title="Your terminal is connected"
      lead="Go back to your terminal — it has what it needs and has already carried on."
    >
      <p className={styles.linkLine}>
        The key it received is stored on that machine and was never shown here.
        You can see and revoke it later from your keys.
      </p>
      <p className={styles.linkLine}>
        You can close this window.
      </p>
    </StatePage>
  );
}
