"use client";

import { ChevronDownIcon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { listTests, listTestSuites } from "@egma/platform-api/client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type {
  ProjectGraderScope,
  SimulationScopeSelector,
} from "../../../../lib/graders.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import { Menu } from "../../../../ui/menu.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";

type ScopeTestOption = {
  readonly kind: "test";
  readonly id: string;
  readonly name: string;
};

type ScopeSuiteOption = {
  readonly kind: "test_suite";
  readonly id: string;
  readonly name: string;
  readonly tests: readonly ScopeTestOption[];
};

type ScopeOption = ScopeSuiteOption | ScopeTestOption;
type ScopeRowOption = Pick<ScopeOption, "kind" | "id" | "name">;

type OptionsState =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly options: readonly ScopeSuiteOption[] };

async function readScopeOptions(projectId: string): Promise<
  | { readonly status: "signed-out" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly options: readonly ScopeSuiteOption[] }
> {
  const suites = [] as Array<{ readonly id: string; readonly name: string }>;
  let suiteToken: string | undefined;

  do {
    const answer = await platformAnswer(
      listTestSuites(
        {
          projectId,
          pageSize: 200,
          ...(suiteToken === undefined ? {} : { pageToken: suiteToken }),
        },
        { client: platformClient },
      ),
    );
    if (answer.status === "signed-out") return answer;
    if (answer.status !== "ready") {
      return { status: "failed", message: answer.refusal.message };
    }
    suites.push(...answer.value.testSuites);
    suiteToken = answer.value.nextPageToken ?? undefined;
  } while (suiteToken !== undefined);

  const options: ScopeSuiteOption[] = [];
  for (const suite of suites) {
    const tests: ScopeTestOption[] = [];
    let testToken: string | undefined;
    do {
      const answer = await platformAnswer(
        listTests(
          {
            projectId,
            suiteId: suite.id,
            pageSize: 200,
            ...(testToken === undefined ? {} : { pageToken: testToken }),
          },
          { client: platformClient },
        ),
      );
      if (answer.status === "signed-out") return answer;
      if (answer.status !== "ready") {
        return { status: "failed", message: answer.refusal.message };
      }
      tests.push(
        ...answer.value.tests.map((test) => ({
          kind: "test" as const,
          id: test.id,
          name: test.name,
        })),
      );
      testToken = answer.value.nextPageToken ?? undefined;
    } while (testToken !== undefined);
    options.push({
      kind: "test_suite",
      id: suite.id,
      name: suite.name,
      tests,
    });
  }

  return { status: "ready", options };
}

function ScopePicker({
  projectId,
  chosen,
  disabled,
  onChange,
}: {
  readonly projectId: string;
  readonly chosen: readonly Exclude<SimulationScopeSelector, { kind: "all" }>[];
  readonly disabled: boolean;
  readonly onChange: (
    selectors: Exclude<SimulationScopeSelector, { kind: "all" }>[],
  ) => void;
}) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [state, setState] = useState<OptionsState>({ status: "loading" });
  const chosenKeys = useMemo(
    () => new Set(chosen.map((selector) => `${selector.kind}:${selector.id}`)),
    [chosen],
  );

  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void readScopeOptions(projectId).then((answer) => {
      if (!current) return;
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      setState(answer);
    });
    return () => {
      current = false;
    };
  }, [projectId]);

  const available = state.status === "ready" ? state.options : [];
  const flatAvailable = available.flatMap((suite) => [suite, ...suite.tests]);
  const needle = search.trim().toLocaleLowerCase();
  const visible = available.flatMap((suite) => {
    const suiteMatches =
      needle === "" ||
      suite.name.toLocaleLowerCase().includes(needle) ||
      "test suite".includes(needle);
    const tests = suiteMatches
      ? suite.tests
      : suite.tests.filter(
          (test) =>
            test.name.toLocaleLowerCase().includes(needle) ||
            "test".includes(needle),
        );
    return suiteMatches || tests.length > 0 ? [{ suite, tests }] : [];
  });
  const unavailable = chosen.filter(
    (selector) =>
      !flatAvailable.some(
        (option) => option.kind === selector.kind && option.id === selector.id,
      ),
  );
  const named = chosen
    .map((selector) =>
      flatAvailable.find(
        (option) => option.kind === selector.kind && option.id === selector.id,
      ),
    )
    .filter((option): option is ScopeOption => option !== undefined);
  const summary =
    chosen.length === 0
      ? "Select test suites and tests"
      : named.length === chosen.length && named.length <= 2
        ? named.map((option) => option.name).join(", ")
        : `${String(chosen.length)} selected`;

  function toggleUnavailable(kind: "test_suite" | "test", id: string): void {
    const selected = chosenKeys.has(`${kind}:${id}`);
    onChange(
      selected
        ? chosen.filter(
            (selector) => selector.kind !== kind || selector.id !== id,
          )
        : [...chosen, { kind, id }],
    );
  }

  function withoutSuiteSelection(suite: ScopeSuiteOption) {
    const testIds = new Set(suite.tests.map((test) => test.id));
    return chosen.filter(
      (selector) =>
        !(
          (selector.kind === "test_suite" && selector.id === suite.id) ||
          (selector.kind === "test" && testIds.has(selector.id))
        ),
    );
  }

  function suiteSelection(suite: ScopeSuiteOption): boolean | "mixed" {
    if (chosenKeys.has(`test_suite:${suite.id}`)) return true;
    return suite.tests.some((test) => chosenKeys.has(`test:${test.id}`))
      ? "mixed"
      : false;
  }

  function toggleSuite(suite: ScopeSuiteOption): void {
    const selected = chosenKeys.has(`test_suite:${suite.id}`);
    const remaining = withoutSuiteSelection(suite);
    onChange(
      selected
        ? remaining
        : [...remaining, { kind: "test_suite", id: suite.id }],
    );
  }

  function toggleTest(suite: ScopeSuiteOption, testId: string): void {
    const suiteSelected = chosenKeys.has(`test_suite:${suite.id}`);
    const selectedTestIds = new Set(
      suite.tests
        .filter((test) => chosenKeys.has(`test:${test.id}`))
        .map((test) => test.id),
    );
    if (suiteSelected) {
      for (const test of suite.tests) selectedTestIds.add(test.id);
    }
    if (selectedTestIds.has(testId)) selectedTestIds.delete(testId);
    else selectedTestIds.add(testId);

    const remaining = withoutSuiteSelection(suite);
    onChange(
      [
        ...remaining,
        ...suite.tests
          .filter((test) => selectedTestIds.has(test.id))
          .map((test) => ({ kind: "test" as const, id: test.id })),
      ],
    );
  }

  return (
    <Menu
      label="Choose test suites and tests"
      panelRole="dialog"
      triggerClassName={cn(
        "grid w-full min-h-(--control-lg) grid-cols-[minmax(0,1fr)_auto]",
        "items-center gap-3 rounded-input border border-border bg-surface px-3",
        "cursor-pointer text-left text-sm text-foreground",
        "pointer-hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-55",
      )}
      openClassName="border-border-strong bg-selected"
      panelClassName="w-[min(480px,calc(100vw-var(--space-8)))] max-w-[min(480px,calc(100vw-var(--space-8)))]"
      trigger={
        <>
          <span
            className={cn(
              "overflow-hidden text-ellipsis whitespace-nowrap",
              chosen.length === 0 && "text-faint",
            )}
          >
            {summary}
          </span>
          <ChevronDownIcon
            className="size-3.5 flex-none"
            strokeWidth={1.5}
            aria-hidden="true"
          />
        </>
      }
    >
      {(close) => (
        <div className="flex flex-col gap-3">
          <Input
            id={searchId}
            aria-label="Search test suites and tests"
            placeholder="Search test suites and tests"
            value={search}
            disabled={disabled}
            data-menu-focus-first=""
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="flex max-h-[min(420px,55vh)] flex-col gap-1 overflow-y-auto">
            {state.status === "loading" ? (
              <p className="m-0 p-3 text-sm text-faint">Reading tests…</p>
            ) : state.status === "failed" ? (
              <p className="m-0 p-3 text-sm text-failure" role="alert">
                {state.message}
              </p>
            ) : visible.length === 0 && unavailable.length === 0 ? (
              <p className="m-0 p-3 text-sm text-faint">
                {search.trim() === ""
                  ? "No test suites or tests yet."
                  : "No test suites or tests match that search."}
              </p>
            ) : (
              <>
                {unavailable.map((selector) => (
                  <ScopeOptionRow
                    key={`unavailable:${selector.kind}:${selector.id}`}
                    option={{
                      kind: selector.kind,
                      id: selector.id,
                      name: selector.id,
                    }}
                    selected
                    unavailable
                    disabled={disabled}
                    onClick={() =>
                      toggleUnavailable(selector.kind, selector.id)
                    }
                  />
                ))}
                {visible.map(({ suite, tests }) => {
                  const selected = suiteSelection(suite);
                  const suiteSelected = selected === true;
                  return (
                    <div
                      key={suite.id}
                      role="group"
                      aria-label={`${suite.name} test suite`}
                    >
                      <ScopeOptionRow
                        option={suite}
                        selected={selected}
                        disabled={disabled}
                        onClick={() => toggleSuite(suite)}
                      />
                      {tests.length === 0 ? null : (
                        <div className="ml-5 border-l border-border pl-3">
                          {tests.map((test) => (
                            <ScopeOptionRow
                              key={test.id}
                              option={test}
                              selected={
                                suiteSelected ||
                                chosenKeys.has(`test:${test.id}`)
                              }
                              disabled={disabled}
                              onClick={() => toggleTest(suite, test.id)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="text-sm text-faint">
              {chosen.length === 0
                ? "Nothing selected"
                : `${String(chosen.length)} selected`}
            </span>
            <Button type="button" size="sm" variant="secondary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Menu>
  );
}

function ScopeOptionRow({
  option,
  selected,
  unavailable = false,
  disabled,
  onClick,
}: {
  readonly option: ScopeRowOption;
  readonly selected: boolean | "mixed";
  readonly unavailable?: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "grid w-full min-h-(--tap-target) grid-cols-[var(--space-5)_minmax(0,1fr)_auto]",
        "items-center gap-3 rounded-button border-0 bg-transparent px-3 py-2",
        "cursor-pointer text-left text-sm text-foreground",
        "pointer-hover:not-disabled:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-60",
        selected !== false && "bg-selected",
      )}
      type="button"
      role="checkbox"
      aria-checked={selected}
      aria-label={`${option.name}, ${option.kind === "test_suite" ? "test suite" : "test"}${unavailable ? ", unavailable" : ""}`}
      data-menu-item=""
      disabled={disabled}
      onClick={onClick}
    >
      <span
        className="grid size-(--space-5) place-items-center rounded-button border border-border-strong text-brand"
        aria-hidden="true"
      >
        {selected === true ? "✓" : selected === "mixed" ? "−" : ""}
      </span>
      <span className="min-w-0">
        <span className={cn("block truncate", unavailable && "text-faint")}>
          {option.name}
        </span>
      </span>
      <Badge variant={unavailable ? "warning" : "neutral"} shape="count">
        {unavailable
          ? "Unavailable"
          : option.kind === "test_suite"
            ? "Suite"
            : "Test"}
      </Badge>
    </button>
  );
}

export function ScopeFields({
  projectId,
  scope,
  disabled = false,
  onChange,
  onValidityChange,
}: {
  readonly projectId: string;
  readonly scope: ProjectGraderScope;
  readonly disabled?: boolean;
  readonly onChange: (scope: ProjectGraderScope) => void;
  readonly onValidityChange?: (valid: boolean) => void;
}) {
  const initialAll = scope.simulations.some(
    (selector) => selector.kind === "all",
  );
  const [simulationsOn, setSimulationsOn] = useState(
    scope.simulations.length > 0,
  );
  const [simulationMode, setSimulationMode] = useState<"all" | "selected">(
    initialAll ? "all" : "selected",
  );
  const selected = scope.simulations.filter(
    (
      selector,
    ): selector is Exclude<SimulationScopeSelector, { kind: "all" }> =>
      selector.kind !== "all",
  );
  const simulationsValid =
    !simulationsOn || simulationMode === "all" || selected.length > 0;
  const productionValid =
    scope.production === null ||
    (Number.isInteger(scope.production.samplePercent) &&
      scope.production.samplePercent >= 1 &&
      scope.production.samplePercent <= 100);
  const valid = simulationsValid && productionValid;

  useEffect(() => {
    onValidityChange?.(valid);
  }, [onValidityChange, valid]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <label className="flex min-h-(--control-md) items-center gap-3 text-sm font-medium text-foreground">
          <Checkbox
            checked={simulationsOn}
            disabled={disabled}
            onChange={(event) => {
              const next = event.target.checked;
              setSimulationsOn(next);
              onChange({
                ...scope,
                simulations: next
                  ? simulationMode === "all"
                    ? [{ kind: "all" }]
                    : selected
                  : [],
              });
            }}
          />
          Grades simulations
        </label>
        {simulationsOn ? (
          <div className="ml-[30px] flex flex-col gap-3">
            <RadioGroup
              value={simulationMode}
              onValueChange={(value) => {
                const mode = value === "all" ? "all" : "selected";
                setSimulationMode(mode);
                onChange({
                  ...scope,
                  simulations: mode === "all" ? [{ kind: "all" }] : selected,
                });
              }}
            >
              <label className="flex items-center gap-3 text-sm text-foreground">
                <RadioGroupItem value="all" disabled={disabled} />
                All simulations
              </label>
              <label className="flex items-center gap-3 text-sm text-foreground">
                <RadioGroupItem value="selected" disabled={disabled} />
                Selected test suites and tests
              </label>
            </RadioGroup>
            {simulationMode === "selected" ? (
              <>
                <ScopePicker
                  projectId={projectId}
                  chosen={selected}
                  disabled={disabled}
                  onChange={(selectors) =>
                    onChange({ ...scope, simulations: selectors })
                  }
                />
                {simulationsValid ? null : (
                  <p className="m-0 text-sm text-failure" role="alert">
                    Select at least one test suite or test, or turn simulation
                    grading off.
                  </p>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-5">
        <label className="flex min-h-(--control-md) items-center gap-3 text-sm font-medium text-foreground">
          <Checkbox
            checked={scope.production !== null}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...scope,
                production: event.target.checked ? { samplePercent: 100 } : null,
              })
            }
          />
          Grades production
        </label>
        {scope.production === null ? null : (
          <div className="ml-[30px]">
            <NumberField
              id="grader-production-sample"
              label="Production sample"
              value={String(scope.production.samplePercent)}
              onChange={(value) => {
                const parsed = Number(value);
                onChange({
                  ...scope,
                  production: {
                    samplePercent: Number.isFinite(parsed) ? parsed : 0,
                  },
                });
              }}
              min={1}
              max={100}
              step={1}
              unit="percent"
              disabled={disabled}
              required
              invalid={!productionValid}
              hint="Enter a whole percentage from 1 through 100."
            />
          </div>
        )}
      </div>
    </div>
  );
}
