import { StatePage } from "../../ui.tsx";

/**
 * What the router draws between the press and the approval page arriving.
 *
 * The device flow is an access surface, not a product page, so this composes
 * `StatePage` and never `ProductStatePage`. No indicator, deliberately: the
 * page's own waiting state is this exact header and nothing under it, so the
 * fallback says the same words the page says the moment it mounts.
 */
export default function DeviceApproveLoading() {
  return (
    <div data-slot="route-loading">
      <StatePage
        title="Loading authorization"
        lead="Checking the terminal code."
      />
    </div>
  );
}
