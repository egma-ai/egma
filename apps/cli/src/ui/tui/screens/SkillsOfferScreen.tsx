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
 * Nothing is written by this screen. It answers the question; the flow runs the
 * standard skills installer that shipped inside this package, against the
 * skills this package carries. Where each one lands is that installer's
 * business — it is what tracks the many places a coding agent reads skills from
 * — so what is said here is which tree it writes into, and the lines the
 * installer prints afterwards say the rest.
 */

import { Box, Text, useInput } from "ink";

import { SKILLS_LOCK_FILE, type SkillPlaces } from "../../../skills/install.ts";
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
      <Text bold>Egma</Text>
      <Box height={1} />
      <Text>
        {`Install ${places.skills.length} Egma ${places.skills.length === 1 ? "skill" : "skills"} into ${places.name}, so it can drive Egma on its own next time?`}
      </Text>
      <Text dimColor>{places.skills.join(", ")}</Text>
      <Box height={1} />
      {/* Said before anything is written, because a tree a developer reads
          afterwards is a tree they were not asked about. */}
      <Text dimColor>{`[p] writes into ${places.repository}, and ${SKILLS_LOCK_FILE} beside it`}</Text>
      <Text dimColor>{`[g] writes into ${places.home}`}</Text>
      <Text dimColor>[s] writes nothing at all</Text>
      <Box height={1} />
      <Text dimColor>
        Egma runs the skills installer it shipped with. Nothing is downloaded.
      </Text>
      <Box height={1} />
      <Text dimColor>{hintBar(bindings)}</Text>
    </Box>
  );
}
