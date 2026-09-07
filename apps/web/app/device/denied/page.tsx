import { LinkLine, StatePage } from "../../ui.tsx";

/**
 * Denied and unknown device codes both direct the user to request a fresh code.
 * Expired codes have a separate page.
 */
export default function DeviceDeniedPage() {
  return (
    <StatePage
      title="That terminal was not authorized"
      lead="Nothing was granted and no key was created."
    >
      <LinkLine>
        If you did not mean to deny it, check the code on your terminal and{" "}
        <a href="/device">enter it again</a>. If the code no longer matches, run{" "}
        <code>egma login</code> in your terminal for a fresh one.
      </LinkLine>
    </StatePage>
  );
}
