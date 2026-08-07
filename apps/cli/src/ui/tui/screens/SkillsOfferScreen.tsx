/**
 * The last question the wizard asks: shall egma teach your coding agent to
 * drive egma?
 *
 * Three keys, and the third is not a lesser answer. Installing a file into
 * somebody's coding agent adds to the context that agent carries into every
 * future task, and that context is theirs. So the offer is explicit, it says
 * exactly which file goes exactly where before anything is written, and skip
 * costs nothing — the CLI is fully drivable from `egma --help` either way, and
 * the exit line says so.
 *
 * Nothing is written by this screen. It answers the question; the flow writes
 * the file, and it writes it with egma's own code — one directory and one
 * file, at a path printed here first.
 */

import { Box, Text, useInput } from "ink";

import type { SkillPlaces } from "../../../skills/install.ts";
import { dispatchKey, hintBar, type KeyBinding } from "../keybindings.ts";

export type SkillsOfferScreenProps = {
  readonly places: SkillPlaces;
  /** `project`, `global`, or `null` for skip. */
  readonly onAnswer: (choice: string | null) => void;
};

export function SkillsOfferScreen({ places, onAnswer }: SkillsOfferScreenProps) {
  const bindings: KeyBinding[] = [
    {
      match: "p",
      label: "p",
      action: "project",
      priority: 0,
      handler: () => onAnswer("project"),
    },
    {
      match: "g",
      label: "g",
      action: "global",
      priority: 1,
      handler: () => onAnswer("global"),
    },
    {
      match: ["s", "escape"],
      label: "s",
      action: "skip",
      priority: 2,
      handler: () => onAnswer(null),
    },
  ];

  useInput((input, key) => {
    dispatchKey(bindings, input, key);
  });

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={2} paddingY={1}>
      <Text bold>egma</Text>
      <Box height={1} />
      <Text>
        {`Install the egma skill into ${places.name}, so it can drive egma on its own next time?`}
      </Text>
      <Box height={1} />
      {/* Said before anything is written, because a path a developer reads
          afterwards is a path they were not asked about. */}
      <Text dimColor>{`[p] writes ${places.project}`}</Text>
      <Text dimColor>{`[g] writes ${places.global}`}</Text>
      <Text dimColor>[s] writes nothing at all</Text>
      <Box height={1} />
      <Text dimColor>egma writes the one file itself. Nothing is downloaded.</Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
