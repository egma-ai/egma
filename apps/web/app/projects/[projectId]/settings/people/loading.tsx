import { Loading } from "../../../../../ui/page-state.tsx";

/** Match the People settings title while membership and invitation reads load. */
export default function PeopleSettingsLoading() {
  return <Loading what="this organization's people" />;
}
