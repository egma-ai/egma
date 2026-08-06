/**
 * The whole terminal UI: read state, resolve a screen, draw it.
 *
 * There is no navigation here and there is none anywhere else. The router works
 * out which screen applies from the state the flow has written.
 */

import { useSyncExternalStore } from "react";
import { useInput, useStdout } from "ink";

import { copyLink } from "../../platform/clipboard.ts";
import { IntroScreen } from "./screens/IntroScreen.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";
import { PromptsPointerScreen } from "./screens/PromptsPointerScreen.tsx";
import { TaskScreen } from "./screens/TaskScreen.tsx";
import type { WizardStore } from "./store.ts";

export type AppProps = {
  readonly store: WizardStore;
  readonly onQuit: () => void;
  readonly onInterrupt: () => void;
};

export function App({ store, onQuit, onInterrupt }: AppProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { stdout } = useStdout();

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
  if (screen === "login") {
    return (
      <LoginScreen
        state={state}
        onCopy={(url) => {
          // The terminal is asked to copy, so the address lands on the
          // clipboard of the machine the keyboard is on rather than the one
          // egma happens to be running on.
          copyLink(url, { write: (sequence) => stdout?.write(sequence) });
          store.linkCopied();
        }}
        onType={(typed) => store.typeLogin(typed)}
        onSubmit={() => store.submitLogin()}
        onQuit={onQuit}
      />
    );
  }
  if (screen === "prompts-pointer") {
    return (
      <PromptsPointerScreen
        onAnswer={(pointer) => store.answer("prompts-pointer", pointer)}
      />
    );
  }
  return <TaskScreen state={state} />;
}
