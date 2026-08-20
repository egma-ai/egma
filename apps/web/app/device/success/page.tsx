import { LinkLine, StatePage } from "../../ui.tsx";

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
      <LinkLine>
        The key it received is stored on that machine and was never shown here.
        You can see and revoke it later from your keys.
      </LinkLine>
      <LinkLine>
        You can close this window.
      </LinkLine>
    </StatePage>
  );
}
