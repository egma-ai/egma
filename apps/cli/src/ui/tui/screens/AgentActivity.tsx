/** The live ACP activity for the coding-agent task currently under way. */

import { Box, Text } from "ink";

import { ACTION_MARK, FAILURE_MARK } from "../../../wizard/status.ts";
import type { WizardState } from "../state.ts";

export type AgentActivityProps = {
  readonly state: WizardState;
  readonly visibleLines?: number;
};

export function AgentActivity({ state, visibleLines = 14 }: AgentActivityProps) {
  const activity = state.statuses.slice(state.activityFrom).slice(-visibleLines);

  return (
    <Box flexDirection="column">
      {activity.length === 0 ? (
        <Text dimColor>Waiting for coding-agent activity.</Text>
      ) : (
        activity.map((line, index) => {
          const important =
            line.startsWith(ACTION_MARK) || line.startsWith(FAILURE_MARK);
          return (
            <Text key={`${index}-${line}`} dimColor={!important}>
              {line}
            </Text>
          );
        })
      )}
    </Box>
  );
}
