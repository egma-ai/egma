/**
 * The whole terminal UI: read state, resolve a screen, draw it.
 *
 * There is no navigation here and there is none anywhere else. The router works
 * out which screen applies from the state the flow has written.
 */

import { useSyncExternalStore } from "react";
import { useInput } from "ink";

import { IntroScreen } from "./screens/IntroScreen.tsx";
import { TaskScreen } from "./screens/TaskScreen.tsx";
import type { WizardStore } from "./store.ts";

export type AppProps = {
  readonly store: WizardStore;
  readonly onQuit: () => void;
  readonly onInterrupt: () => void;
};

export function App({ store, onQuit, onInterrupt }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Ctrl-C is handled here rather than by the renderer, because stopping means
  // shutting the driven agent down and leaving an honest line behind, not
  // dropping the process where it stands.
  useInput((input, key) => {
    if (key.ctrl && input === "c") onInterrupt();
  });

  const screen = store.router.resolve(state);

  if (screen === "intro") {
    return <IntroScreen state={state} onBegin={() => store.begin()} onQuit={onQuit} />;
  }
  return <TaskScreen state={state} />;
}
