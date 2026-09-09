import { Loading } from "../../../../../ui/page-state.tsx";

/** Match the API keys page title while the route loads. */
export default function KeysSettingsLoading() {
  return <Loading what="your keys" />;
}
