import { StatePage } from "../ui.tsx";

/**
 * Match the invitation page's access shell and waiting header. Do not show
 * project navigation before the recipient has a session or add a transient card.
 */
export default function InviteLoading() {
  return (
    <div data-slot="route-loading">
      <StatePage
        title="Loading invitation"
        lead="Checking the invitation link."
      />
    </div>
  );
}
