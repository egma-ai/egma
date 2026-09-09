import { Loading } from "../../../../ui/page-state.tsx";

/** Match the Project settings title while the route loads. */
export default function SettingsLoading() {
  return <Loading what="this project" />;
}
