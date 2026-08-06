/**
 * The browser step: a short code, the address it is already in, and a way back
 * for a machine that has no browser of its own.
 *
 * Nothing secret is ever typed here. The code goes out, the approval happens
 * where the developer can see who they are signing in as, and egma collects a
 * key on its own.
 *
 * Three ways through, in the order they are reached for: the browser that
 * opened by itself, the address copied to the clipboard for a browser on
 * another machine, and the line pasted back when the developer wants to tell
 * this terminal to look now.
 */

import { Box, Text, useInput, useStdout } from "ink";

import { dispatchKey, hintBar, isEnter, type KeyBinding } from "../keybindings.ts";
import type { WizardState } from "../state.ts";
import { addressFits, columnsNeeded } from "../width.ts";

export type LoginScreenProps = {
  readonly state: WizardState;
  readonly onCopy: (url: string) => void;
  readonly onType: (typed: string) => void;
  readonly onSubmit: () => void;
  readonly onQuit: () => void;
};

/** The newest lines only: what is happening now, not the whole history. */
const VISIBLE_STATUS_LINES = 6;

export function LoginScreen({
  state,
  onCopy,
  onType,
  onSubmit,
  onQuit,
}: LoginScreenProps) {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const login = state.login;
  const url = login?.url ?? "";

  const bindings: KeyBinding[] = [
    { match: "c", label: "c", action: "copy link", priority: 0, handler: () => onCopy(url) },
    { match: "return", label: "enter", action: "paste a link back", priority: 1, handler: onSubmit },
    { match: "q", label: "q", action: "quit", priority: 2, handler: onQuit },
  ];

  useInput((input, key) => {
    if (key.escape) {
      onType("");
      return;
    }
    if (key.backspace || key.delete) {
      onType(state.loginTyping.slice(0, -1));
      return;
    }
    // Anything longer than one character arrived as a paste rather than as a
    // keystroke, and a pasted address or code may well begin with a letter that
    // a key is bound to. Length is what tells the two apart, so a code starting
    // with `c` is never read as the copy key.
    if (input.length > 1) {
      onType(state.loginTyping + input);
      return;
    }
    // Once something is on the line, every character belongs to it. Enter sends
    // it; escape clears it and gives the keys back. Enter is read the one way
    // it is read everywhere, so a line feed sends the line as a carriage return
    // does.
    if (state.loginTyping !== "" && !isEnter(input, key)) {
      onType(state.loginTyping + input);
      return;
    }
    dispatchKey(bindings, input, key);
  });

  const fits = addressFits(url, columns);
  const shown = state.statuses.slice(-VISIBLE_STATUS_LINES);

  return (
    // The border and paddingX below are counted in `FRAMING_COLUMNS`, which is
    // what decides whether the address fits. Changing either changes that.
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>
        {login?.browserOpened === true
          ? "Your browser is open on egma. Approve this code there."
          : "Open this address in a browser and approve this code."}
      </Text>
      <Box height={1} />
      <Text bold>{`Code: ${login?.userCode ?? ""}`}</Text>
      <Box height={1} />
      {fits ? (
        <Text>{url}</Text>
      ) : (
        <Text>
          {`The address needs ${columnsNeeded(url)} columns and this terminal has ${columns}. ` +
            "Widen it to see the address, or press [c] to copy it."}
        </Text>
      )}
      <Box height={1} />
      <Text dimColor>
        {state.loginCopied
          ? "Copied. Open it on the machine your browser is on."
          : "No browser on this machine? Copy the address, approve it elsewhere, then paste it back here."}
      </Text>
      {state.loginTyping === "" ? null : (
        <Box marginTop={1}>
          <Text>{`› ${state.loginTyping}`}</Text>
        </Box>
      )}
      <Box flexDirection="column" marginTop={1}>
        {shown.map((line, index) => (
          <Text key={`${index}-${line}`} dimColor>
            {line}
          </Text>
        ))}
      </Box>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
