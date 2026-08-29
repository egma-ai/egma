/**
 * The whole terminal UI: read state, resolve a screen, draw it.
 *
 * There is no navigation here and there is none anywhere else. The router works
 * out which screen applies from the state the flow has written.
 */

import { useSyncExternalStore } from "react";
import { useInput, useStdout } from "ink";

import { copyLink } from "../../platform/clipboard.ts";
import { openInBrowser } from "../../platform/browser.ts";
import { ExistingTestsScreen } from "./screens/ExistingTestsScreen.tsx";
import { ConnectionFieldScreen } from "./screens/ConnectionFieldScreen.tsx";
import { ConnectionFieldsScreen } from "./screens/ConnectionFieldsScreen.tsx";
import { CodingAgentScreen } from "./screens/CodingAgentScreen.tsx";
import { GateScreen } from "./screens/GateScreen.tsx";
import { GeneratingScreen } from "./screens/GeneratingScreen.tsx";
import { GoalScreen } from "./screens/GoalScreen.tsx";
import { IntroScreen } from "./screens/IntroScreen.tsx";
import { LoginScreen } from "./screens/LoginScreen.tsx";
import { MonitoringAgentScreen } from "./screens/MonitoringAgentScreen.tsx";
import { PhoneNumberScreen } from "./screens/PhoneNumberScreen.tsx";
import { LaneScreen } from "./screens/LaneScreen.tsx";
import { RetellAgentScreen } from "./screens/RetellAgentScreen.tsx";
import { RetellKeyScreen } from "./screens/RetellKeyScreen.tsx";
import { RunScreen } from "./screens/RunScreen.tsx";
import { SkillsOfferScreen } from "./screens/SkillsOfferScreen.tsx";
import { TaskScreen } from "./screens/TaskScreen.tsx";
import { WelcomeScreen } from "./screens/WelcomeScreen.tsx";
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

  if (screen === "welcome") {
    return <WelcomeScreen onContinue={() => store.welcome()} onQuit={onQuit} />;
  }
  if (screen === "coding-agent") {
    return (
      <CodingAgentScreen
        state={state}
        onAnswer={(id) => store.answer("coding-agent", id)}
        onQuit={onQuit}
      />
    );
  }
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
  if (screen === "goal" && state.goalAsk !== null) {
    return (
      <GoalScreen
        ask={state.goalAsk}
        onAnswer={(goal) => store.answer("goal", goal)}
        onQuit={onQuit}
      />
    );
  }
  if (screen === "retell-key") {
    return (
      <RetellKeyScreen state={state} onAnswer={(key) => store.answer("retell-key", key)} />
    );
  }
  if (screen === "connection-field" && state.connectionAsk !== null) {
    return (
      <ConnectionFieldScreen
        key={state.connectionAsk.id}
        ask={state.connectionAsk}
        onAnswer={(answer) => store.answer(state.connectionAsk!.id, answer)}
      />
    );
  }
  if (screen === "connection-fields" && state.connectionFieldsAsk !== null) {
    return (
      <ConnectionFieldsScreen
        key={state.connectionFieldsAsk.fields.map((field) => field.id).join(":")}
        ask={state.connectionFieldsAsk}
        onAnswer={(answer) => store.answerConnectionFields(answer)}
      />
    );
  }
  if (screen === "retell-agent") {
    return (
      <RetellAgentScreen state={state} onAnswer={(id) => store.answer("retell-agent", id)} />
    );
  }
  if (screen === "monitoring-agent") {
    return (
      <MonitoringAgentScreen
        state={state}
        onAnswer={(id) => store.answer("monitoring-agent", id)}
      />
    );
  }
  if (screen === "lanes") {
    return (
      <LaneScreen
        options={state.laneOptions ?? []}
        // One answer channel carries every question, so the set travels as the
        // one word the channel takes and is read back by `lanesFrom`.
        onAnswer={(lanes) =>
          store.answer("lanes", lanes === null ? null : lanes.join(","))
        }
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
        onRun={() => store.runTests()}
        onQuit={onQuit}
      />
    );
  }
  if (screen === "generating" && state.generation !== null) {
    return <GeneratingScreen progress={state.generation} state={state} />;
  }
  if (screen === "skills-offer" && state.skillPlaces !== null) {
    return (
      <SkillsOfferScreen
        places={state.skillPlaces}
        result={state.run?.firstResult ?? null}
        onAnswer={(choice) => store.answer("skills-offer", choice)}
      />
    );
  }
  if (screen === "run" && state.run !== null) {
    return (
      <RunScreen
        run={state.run}
        onOpen={() =>
          openInBrowser(state.run!.resultsUrl, {
            instanceUrl: state.platform?.url ?? state.run!.resultsUrl,
          })
        }
      />
    );
  }
  return <TaskScreen state={state} />;
}
