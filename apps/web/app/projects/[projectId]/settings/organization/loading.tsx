import { Loading } from "../../../../../ui/page-state.tsx";

/** Match the Organization settings title while the route loads. */
export default function OrganizationSettingsLoading() {
  return <Loading what="this organization" />;
}
