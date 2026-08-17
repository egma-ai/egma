/**
 * The whole terminal UI: read state, resolve a screen, draw it.
 *
 * There is no navigation here and there is none anywhere else. The router works
 * out which screen applies from the state the flow has written.
 */

import { useSyncExternalStore } from "react";
import { useApp, useInput, useStdout } from "ink";

import { copyLink } from "../../platform/clipboard.ts";
import { openInEditor } from "./editor.ts";
import { ExistingTestsScreen } from "./screens/ExistingTestsScreen.tsx";
import { GateScreen } from "./screens/GateScreen.tsx";
import { GeneratingScreen } from "./screens/GeneratingScreen.tsx";
import { IntroScreen } from "./screens/IntroScreen.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";
import { PhoneNumberScreen } from "./screens/PhoneNumberScreen.tsx";
import { PromptsPointerScreen } from "./screens/PromptsPointerScreen.tsx";
import { ReachScreen } from "./screens/ReachScreen.tsx";
import { RetellAgentScreen } from "./screens/RetellAgentScreen.tsx";
import { RetellKeyScreen } from "./screens/RetellKeyScreen.tsx";
import { RunScreen } from "./screens/RunScreen.tsx";
import { SkillsOfferScreen } from "./screens/SkillsOfferScreen.tsx";
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
  const { suspendTerminal } = useApp();

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
  if (screen === "retell-key") {
    return (
      <RetellKeyScreen state={state} onAnswer={(key) => store.answer("retell-key", key)} />
    );
  }
  if (screen === "retell-agent") {
    return (
      <RetellAgentScreen state={state} onAnswer={(id) => store.answer("retell-agent", id)} />
    );
  }
  if (screen === "reach") {
    return (
      <ReachScreen
        options={state.reachOptions ?? []}
        onAnswer={(reach) => store.answer("reach", reach)}
      />
    );
  }
  if (screen === "phone-number") {
    return (
      <PhoneNumberScreen
        state={state}
        onAnswer={(number) => store.answer("phone-number", number)}
      />
    );
  }
  if (screen === "existing-tests") {
    return (
      <ExistingTestsScreen onAnswer={(path) => store.answer("existing-tests", path)} />
    );
  }
  if (screen === "gate" && state.gate !== null) {
    return (
      <GateScreen
        gate={state.gate}
        at={state.gateAt}
        problem={state.editorProblem}
        onMove={(by) => store.moveGate(by)}
        onRun={() => store.runTests()}
        onQuit={onQuit}
        onEdit={() => {
          const file = store.selectedGateFile();
          if (file === null) return;
          // The editor owns the terminal while it runs, so egma owns none of
          // it: Ink is suspended, egma's own alternate screen comes off, and
          // both are put back when the child is gone.
          void openInEditor(file, {
            ...(stdout === undefined ? {} : { stdout }),
            suspend: (during) => suspendTerminal(during),
          }).then((said) => store.setEditorProblem(said));
        }}
      />
    );
  }
  if (screen === "generating" && state.generation !== null) {
    return <GeneratingScreen progress={state.generation} />;
  }
  if (screen === "skills-offer" && state.skillPlaces !== null) {
    return (
      <SkillsOfferScreen
        places={state.skillPlaces}
        onAnswer={(choice) => store.answer("skills-offer", choice)}
      />
    );
  }
  if (screen === "run" && state.run !== null) {
    return <RunScreen run={state.run} />;
  }
  return <TaskScreen state={state} />;
}
