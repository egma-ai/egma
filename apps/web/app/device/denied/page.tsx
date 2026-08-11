import { StatePage, styles } from "../../ui.tsx";

/**
 * Nothing was authorized, and this page says what to do about it.
 *
 * Two things arrive here and they need the same answer: a code that was denied
 * on purpose, and a code egma does not recognise — a character misread, or a
 * code from a terminal that has since been closed. Either way the terminal is
 * still waiting and the way forward is a fresh code, so that is what the page
 * says rather than leaving somebody staring at an error they cannot act on.
 *
 * A code that simply sat too long is a different page, because it means the
 * product did not break, it timed out.
 */
export default function DeviceDeniedPage() {
  return (
    <StatePage
      title="That terminal was not authorized"
      lead="Nothing was granted and no key was created."
    >
      <p className={styles.linkLine}>
        If you did not mean to deny it, check the code on your terminal and{" "}
        <a href="/device">enter it again</a>. If the code no longer matches, run{" "}
        <code>egma login</code> in your terminal for a fresh one.
      </p>
    </StatePage>
  );
}
