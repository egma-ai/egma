import type { Verdict } from "../verdicts/fold.ts";
import {
  foldRunSummary,
  type RunFold,
} from "../verdicts/read-fold.ts";
import type { AuthContext } from "./context.ts";
import { LARGEST_PAGE_SIZE, type PageRequest } from "./pages.ts";
import { authorize, here } from "./permissions.ts";
import {
  getRun,
  listRuns,
  simulationStatusCountsOfRuns,
  type Run,
  type RunFilter,
} from "./runs.ts";
import { readRunVerdictSummaries } from "./verdicts.ts";

/** One run header with its execution and grading facts folded together. */
export type RunHistoryEntry = {
  readonly run: Run;
  readonly fold: RunFold;
};

export type RunHistoryPage = {
  readonly items: readonly RunHistoryEntry[];
  readonly nextCursor: string | undefined;
};

export type RunHistoryRequest = PageRequest &
  RunFilter & { readonly verdict?: Verdict | undefined };

const MOST_SWEEPS = 5;

export async function listRunHistory(
  auth: AuthContext,
  request: RunHistoryRequest = {},
): Promise<RunHistoryPage> {
  authorize(auth, "read", here(auth));
  const { limit, cursor, verdict, ...filter } = request;
  const wanted = limit ?? 50;
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > LARGEST_PAGE_SIZE) {
    throw new Error(`a page holds between 1 and ${LARGEST_PAGE_SIZE} runs`);
  }

  const kept: RunHistoryEntry[] = [];
  let after = cursor;
  let more = false;
  let exhausted = false;
  const sweeps = verdict === undefined ? 1 : MOST_SWEEPS;

  for (let sweep = 0; sweep < sweeps && !exhausted && kept.length < wanted; sweep += 1) {
    const page = await listRuns(
      auth,
      { limit: wanted, ...(after === undefined ? {} : { cursor: after }) },
      filter,
    );
    if (page.items.length === 0) {
      exhausted = true;
      break;
    }
    for (const entry of await foldEachRun(auth, page.items)) {
      if (kept.length === wanted) {
        more = true;
        break;
      }
      if (verdict === undefined || entry.fold.verdict === verdict) kept.push(entry);
      after = entry.run.id;
    }
    if (kept.length === wanted && !more) more = page.nextCursor !== undefined;
    if (page.nextCursor === undefined) exhausted = true;
  }

  return {
    items: kept,
    nextCursor: exhausted && !more ? undefined : after,
  };
}

export async function readRunFold(
  auth: AuthContext,
  runId: string,
): Promise<RunHistoryEntry | undefined> {
  authorize(auth, "read", here(auth));
  const header = await getRun(auth, runId);
  if (header === undefined) return undefined;
  return (await foldEachRun(auth, [header]))[0];
}

async function foldEachRun(
  auth: AuthContext,
  runs: readonly Run[],
): Promise<readonly RunHistoryEntry[]> {
  const runIds = runs.map((one) => one.id);
  const conversations = await simulationStatusCountsOfRuns(auth, runIds);
  const judged = await readRunVerdictSummaries(auth, runIds).catch(
    () => new Map(),
  );
  return runs.map((one) => ({
    run: one,
    fold: foldRunSummary(one.status, one.expectedSimulationCount, {
      simulations: conversations.get(one.id) ?? {},
      judged: judged.get(one.id),
    }),
  }));
}
