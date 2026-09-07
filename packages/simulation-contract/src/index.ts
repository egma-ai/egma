/** Shared simulation document validation, trace identity, and mock-tool vocabulary. */

export { reportComplaints, specComplaints } from "./documents.ts";

export {
  simulationIdOfTrace,
  traceIdOfSimulation,
} from "./trace-identity.ts";

export {
  bannedWordIn,
  BANNED_MOCK_TOOL_WORDS,
  type BannedWord,
  type BannedWordFound,
} from "./vocabulary.ts";

