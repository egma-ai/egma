"use client";

import { useRef, useState } from "react";

import { EllipsisIcon } from "lucide-react";

import { Badge as BaseBadge } from "@/components/ui/badge";
import { Button as BaseButton } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog as BaseDialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import type { Me } from "../../lib/me.ts";
import type { EvidenceTranscript } from "../../lib/simulations.ts";
import { Choice } from "../../ui/choice.tsx";
import { DataTable, type Column } from "../../ui/data-table.tsx";
import { Dialog } from "../../ui/dialog.tsx";
import { Transcript } from "../../ui/evidence.tsx";
import { Toast, Tooltip, type FeedbackInput } from "../../ui/feedback.tsx";
import { Field, Form, FormActions, FormRow, Refused } from "../../ui/form.tsx";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "../../ui/menu.tsx";
import { NumberField } from "../../ui/number-field.tsx";
import { Empty, Failure, Loading } from "../../ui/page-state.tsx";
import { ProjectSelector } from "../../ui/project-selector.tsx";
import { RunProgress, VerdictBadge } from "../../ui/run-status.tsx";
import { Actions, Section, Toolbar } from "../../ui/section.tsx";
import { SettingsNav } from "../../ui/settings-nav.tsx";
import { AppShell, ProductPage } from "../../ui/shell.tsx";

import styles from "./proof.module.css";

type ProofAgent = {
  readonly id: string;
  readonly name: string;
  readonly connection: string;
  readonly state: "Active" | "Archived";
};

const AGENTS: readonly ProofAgent[] = [
  { id: "agt_01", name: "Support", connection: "Retell · production", state: "Active" },
  { id: "agt_02", name: "Bookings", connection: "LiveKit · staging", state: "Active" },
  { id: "agt_03", name: "Renewals", connection: "Phone · production", state: "Archived" },
];

const PROOF_ME: Me = {
  user: { id: "usr_proof", email: "design@egma.test" },
  organizations: [
    { id: "org_proof", name: "Local Egma", slug: "local-egma", role: "admin" },
  ],
  projects: [
    { id: "prj_proof", name: "Support", slug: "support" },
    { id: "prj_outbound", name: "Outbound", slug: "outbound" },
  ],
};

const COLUMNS: readonly Column<ProofAgent>[] = [
  {
    key: "name",
    header: "Agent",
    primary: true,
    cell: (agent) => <a href="#agent">{agent.name}</a>,
  },
  { key: "connection", header: "Connection", cell: (agent) => agent.connection },
  {
    key: "state",
    header: "State",
    cell: (agent) => (
      <BaseBadge variant={agent.state === "Active" ? "success" : "neutral"}>
        {agent.state}
      </BaseBadge>
    ),
  },
  { key: "id", header: "Identifier", mono: true, cell: (agent) => agent.id },
];

const TRANSCRIPT: EvidenceTranscript = {
  trace_id: "trc_proof",
  started_at: "2026-08-15T12:00:00.000Z",
  ended_at: "2026-08-15T12:00:18.000Z",
  duration_ns: "18000000000",
  span_count: 2,
  turn_counts: { human: 1, agent: 1 },
  tool_span_count: 0,
  errored_span_count: 0,
  turns: [
    {
      span_id: "spn_human",
      parent_span_id: "",
      name: "human",
      kind: "turn:human",
      status: "ok",
      started_at: "2026-08-15T12:00:00.000Z",
      duration_ns: "4000000000",
      text: "I need to move my booking to Tuesday afternoon.",
      audio_url: "",
      tool_name: "",
      tool_arguments: "",
      tool_result: "",
      spans: [],
    },
    {
      span_id: "spn_agent",
      parent_span_id: "",
      name: "agent",
      kind: "turn:agent",
      status: "ok",
      started_at: "2026-08-15T12:00:05.000Z",
      duration_ns: "5000000000",
      text: "I found the booking. I can move it after I verify the email address.",
      audio_url: "",
      tool_name: "",
      tool_arguments: "",
      tool_result: "",
      spans: [],
    },
  ],
  spans: [],
  spans_truncated: false,
};

export function DesignSystemProof() {
  const [dialog, setDialog] = useState(false);
  const [toast, setToast] = useState(true);
  const [toastInput, setToastInput] = useState<FeedbackInput>("keyboard");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [maxConcurrency, setMaxConcurrency] = useState("2");
  const [name, setName] = useState("Support agent");
  const [description, setDescription] = useState(
    "Answers customer questions and makes account changes after verification.",
  );
  const [environment, setEnvironment] = useState<"staging" | "production">("production");
  const [list, setList] = useState<"active" | "archived">("active");
  const [onlyFailed, setOnlyFailed] = useState(true);
  const [sampleRate, setSampleRate] = useState("20");
  const [answerWithin, setAnswerWithin] = useState("2.5");
  const [turnBudget, setTurnBudget] = useState("12");
  const nextFeedbackInput = useRef<FeedbackInput>("keyboard");

  return (
    <AppShell initialMe={PROOF_ME}>
      <ProductPage wide>
      <div className={styles.canvas}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Development proof surface</p>
        <h1>Egma product system</h1>
        <p>
          The real product shell and shared components, shown together across
          agents, tests, runs, simulations, graders, personas, and Settings.
        </p>
      </header>

      <section className={styles.grid} aria-label="Shared component proof">
        <article className={`${styles.panel} ${styles.wide}`}>
          <p className={styles.kicker}>Component base — shadcn on Tailwind</p>
          <div className="flex flex-col gap-8">
            <p className="m-0 max-w-[68ch] text-base text-muted-foreground">
              The primitives every screen is built from. Nothing here sets a
              colour, a radius, or a duration of its own: the Tailwind theme
              reads <code className="font-mono text-sm">ui/tokens.css</code>, so
              a value is changed in that one file and every surface on this page
              changes with it.
            </p>

            <div className="flex flex-col gap-4">
              <h3 className="m-0 text-sm font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Buttons
              </h3>
              <div className="flex flex-wrap items-center gap-3">
                <BaseButton>Start run</BaseButton>
                <BaseButton variant="secondary">Add grader</BaseButton>
                <BaseButton variant="ghost">Open transcript</BaseButton>
                <BaseButton variant="link">See the run plan</BaseButton>
                <BaseButton variant="destructive">Delete persona</BaseButton>
                <BaseButton disabled>Unavailable</BaseButton>
                <BaseButton size="sm" variant="secondary">
                  Dense row action
                </BaseButton>
                <BaseButton
                  size="icon"
                  variant="secondary"
                  aria-label="More base actions"
                >
                  <EllipsisIcon />
                </BaseButton>
              </div>
              <p className="m-0 text-sm text-muted-foreground">
                The filled one is the page&apos;s main action and there is one
                of it. Every other button on a screen is one of the quieter
                kinds.
              </p>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <div className="flex flex-col gap-4">
                <h3 className="m-0 text-sm font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                  Fields
                </h3>
                <label className="flex flex-col gap-2" htmlFor="base-suite">
                  <span className="text-sm font-medium">Test suite name</span>
                  <Input id="base-suite" defaultValue="Refund regression" />
                </label>
                <label className="flex flex-col gap-2" htmlFor="base-trace">
                  <span className="text-sm font-medium">Trace identifier</span>
                  <Input id="base-trace" readOnly value="trc_01JQ0A2B3C4D5E" />
                </label>
                <label className="flex flex-col gap-2" htmlFor="base-locked">
                  <span className="text-sm font-medium">Frozen agent</span>
                  <Input
                    id="base-locked"
                    disabled
                    placeholder="Chosen when the run starts"
                  />
                </label>
              </div>

              <div className="flex flex-col gap-4">
                <h3 className="m-0 text-sm font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                  Chips
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                  <BaseBadge>Viewer</BaseBadge>
                  <BaseBadge variant="success">Passed</BaseBadge>
                  <BaseBadge variant="warning">Skipped</BaseBadge>
                  <BaseBadge variant="failure">Failed</BaseBadge>
                </div>
                <p className="m-0 text-sm text-muted-foreground">
                  Brand orange is absent on purpose. It never means passed,
                  failed, skipped, or errored.
                </p>
                <h3 className="m-0 text-sm font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                  Theme, straight from the tokens
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  <div className="h-10 rounded-input border border-border bg-background" title="Neutral Paper" />
                  <div className="h-10 rounded-input border border-border bg-surface-soft" title="Quiet neutral" />
                  <div className="h-10 rounded-input border border-border bg-selected" title="Ember Wash" />
                  <div className="h-10 rounded-input border border-border bg-primary" title="Deep Ember" />
                  <div className="h-10 rounded-input border border-border bg-brand" title="Ember" />
                  <div className="h-10 rounded-input border border-border bg-failure" title="Failure" />
                </div>
              </div>
            </div>

            {/*
              * The numeric field, which the base has no primitive for.
              *
              * Its whole reason for existing is that a bound and a unit belong
              * on the control rather than in a sentence beside it, so the proof
              * has to show all three shapes at once: a percentage, a value in
              * seconds whose step is not a whole number, and a plain count with
              * no unit at all. A field that only ever appeared with a unit
              * would leave the unit-less layout unproven, and that is the one
              * the grader threshold uses.
              */}
            <div className="flex flex-col gap-4">
              <h3 className="m-0 text-sm font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                Numeric fields
              </h3>
              <p className="m-0 max-w-[68ch] text-base text-muted-foreground">
                The bounds are the browser&apos;s own validation and its own
                arrow-key stepping; the unit sits beside the field rather than
                inside it, and is read out with the value rather than left as
                decoration; the digits are tabular. The spin buttons
                are hidden because every browser draws them differently and each
                one is a target smaller than this product allows anywhere else.
              </p>
              <div className="grid gap-6 md:grid-cols-3">
                <NumberField
                  id="proof-sample-rate"
                  label="Share of live traffic judged"
                  value={sampleRate}
                  onChange={setSampleRate}
                  unit="%"
                  min={0}
                  max={100}
                  step={1}
                  hint="A whole percentage. The field refuses 900 rather than a sentence asking it not to."
                />
                <NumberField
                  id="proof-answer-within"
                  label="Answer within"
                  value={answerWithin}
                  onChange={setAnswerWithin}
                  unit="seconds"
                  min={0}
                  max={30}
                  step={0.1}
                  hint="A step that is not whole asks a phone for the decimal keypad."
                />
                <NumberField
                  id="proof-turn-budget"
                  label="Turns before the caller gives up"
                  value={turnBudget}
                  onChange={setTurnBudget}
                  min={1}
                  max={40}
                  hint="No unit: some numbers are a count and nothing else."
                />
              </div>
            </div>

            <div className="grid gap-6 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Refund policy grader</CardTitle>
                  <CardDescription>
                    Judges whether the agent stated the refund window before it
                    offered one.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap items-center gap-3">
                    <BaseBadge variant="success">Passed 41</BaseBadge>
                    <BaseBadge variant="failure">Failed 3</BaseBadge>
                  </div>
                </CardContent>
                <CardFooter>
                  <BaseButton size="sm">Use this grader</BaseButton>
                  <BaseButton size="sm" variant="ghost">
                    Read the definition
                  </BaseButton>
                </CardFooter>
              </Card>

              <div className="flex flex-col gap-4">
                <h3 className="m-0 text-sm font-medium uppercase tracking-(--tracking-label) text-muted-foreground">
                  Menus and layers
                </h3>
                <div className="flex flex-wrap items-center gap-3">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <BaseButton variant="secondary">
                        Simulation actions
                      </BaseButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuLabel>This simulation</DropdownMenuLabel>
                      <DropdownMenuItem>Open the transcript</DropdownMenuItem>
                      <DropdownMenuItem>Download the recording</DropdownMenuItem>
                      <DropdownMenuCheckboxItem
                        checked={onlyFailed}
                        onCheckedChange={(next) => setOnlyFailed(next === true)}
                      >
                        Show failed turns only
                      </DropdownMenuCheckboxItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive">
                        Delete this simulation
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Popover>
                    <PopoverTrigger asChild>
                      <BaseButton variant="secondary">
                        What a run freezes
                      </BaseButton>
                    </PopoverTrigger>
                    <PopoverContent align="start">
                      <p className="m-0 text-sm text-muted-foreground">
                        A run freezes the agent, the persona, the grader, and
                        the test version it started from, so a later edit never
                        changes what already happened.
                      </p>
                    </PopoverContent>
                  </Popover>

                  <BaseDialog>
                    <DialogTrigger asChild>
                      <BaseButton variant="destructive">
                        Delete grader
                      </BaseButton>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>
                          Delete the Refund policy grader?
                        </DialogTitle>
                        <DialogDescription>
                          Runs that already used it keep their verdicts. No new
                          run can be judged by it.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <DialogClose asChild>
                          <BaseButton variant="secondary">Keep it</BaseButton>
                        </DialogClose>
                        <DialogClose asChild>
                          <BaseButton variant="destructive">
                            Delete grader
                          </BaseButton>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </BaseDialog>
                </div>
                <p className="m-0 text-sm text-muted-foreground">
                  The menu and the popover grow from the control that opened
                  them; the dialog stays centred. Every duration is a DESIGN.md
                  motion token and every one is under 300ms.
                </p>
              </div>
            </div>
          </div>
        </article>

        <article className={styles.panel}>
          <p className={styles.kicker}>Project context</p>
          <ProjectSelector
            organization={PROOF_ME.organizations[0]}
            projects={PROOF_ME.projects}
            projectId="prj_proof"
          />
          <div className={styles.actions}>
            <BaseButton type="button" onClick={() => setDialog(true)}>
              Register agent
            </BaseButton>
            <BaseButton type="button" variant="secondary">
              Quiet action
            </BaseButton>
            <BaseButton
              type="button"
              variant="secondary"
              disabled
              why="Only an administrator can archive this agent."
            >
              Archive
            </BaseButton>
            <BaseButton type="button" variant="secondary" busy>
              Saving agent…
            </BaseButton>
            <Tooltip label="This copies the current project identifier.">
              <button className={styles.tooltipTrigger} type="button">Copy identifier</button>
            </Tooltip>
            <span
              onPointerDownCapture={() => {
                nextFeedbackInput.current = "pointer";
              }}
              onKeyDownCapture={() => {
                nextFeedbackInput.current = "keyboard";
              }}
            >
              <BaseButton
                type="button"
                variant="secondary"
                onClick={() => {
                  setToastInput(nextFeedbackInput.current);
                  setToast(true);
                }}
              >
                Show saved feedback
              </BaseButton>
            </span>
          </div>
          <div className={styles.badges}>
            <BaseBadge>Viewer</BaseBadge>
            <BaseBadge variant="success">Passed</BaseBadge>
            <BaseBadge variant="warning">Skipped</BaseBadge>
            <BaseBadge variant="failure">Failed</BaseBadge>
            <VerdictBadge verdict="errored" />
          </div>
        </article>

        <article className={styles.panel}>
          <p className={styles.kicker}>Menu and choice</p>
          <Toolbar>
            <Choice
              label="Agent list"
              value={list}
              options={[
                { value: "active", label: "Active" },
                { value: "archived", label: "Archived" },
              ]}
              onChange={setList}
            />
            <Menu label="Open proof menu" trigger={<span>More</span>}>
              {(close) => (
                <>
                  <MenuLabel>Agent actions</MenuLabel>
                  <MenuItem onClick={close}>Edit agent</MenuItem>
                  <MenuDivider />
                  <MenuItem onClick={close}>Archive agent</MenuItem>
                </>
              )}
            </Menu>
          </Toolbar>
          <p className={styles.meta}>Selected list: {list}</p>
          <RunProgress finished={7} expected={10} />
        </article>

        <article className={`${styles.panel} ${styles.wide}`}>
          <Section
            title="Agent details"
            lead="Fields, actions, help text, and responsive form rows use one shared layout."
          >
            <Form>
              <FormRow>
                <Field label="Name" htmlFor="proof-name" hint="Use the name your team already uses.">
                  <Input
                    id="proof-name"
                    value={name}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setName(event.target.value)}
                  />
                </Field>
                <Field label="Environment" htmlFor="proof-environment">
                  <Select
                    id="proof-environment"
                    value={environment}
                    onChange={(event) =>
                      setEnvironment(
                        event.target.value as "staging" | "production",
                      )
                    }
                  >
                    <option value="staging">Staging</option>
                    <option value="production">Production</option>
                  </Select>
                </Field>
                <Field
                  label="Max concurrency"
                  htmlFor="proof-concurrency"
                  hint="Local runs use one shared concurrency value."
                >
                  <Input
                    id="proof-concurrency"
                    type="number"
                    value={maxConcurrency}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) => setMaxConcurrency(event.target.value)}
                  />
                </Field>
              </FormRow>
              <Field label="Description" htmlFor="proof-description">
                <Textarea
                  id="proof-description"
                  rows={4}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <div className={styles.checkboxRow}>
                <Checkbox
                  id="proof-archived"
                  checked={includeArchived}
                  onChange={(event) => setIncludeArchived(event.target.checked)}
                />
                <label htmlFor="proof-archived">Include archived tests in this run</label>
              </div>
              <FormActions>
                <BaseButton type="submit">Save agent</BaseButton>
                <BaseButton type="button" variant="secondary">
                  Cancel
                </BaseButton>
              </FormActions>
            </Form>
          </Section>
        </article>

        <article className={`${styles.panel} ${styles.wide}`}>
          <p className={styles.kicker}>Settings scope and refusal</p>
          <SettingsNav projectId="prj_proof" current="judge" />
          <Refused
            message="Your viewer role cannot change the default judge. Your draft is still here."
            action={
              <BaseButton type="button" variant="secondary">
                Review project access
              </BaseButton>
            }
          />
        </article>

        <article className={`${styles.panel} ${styles.wide}`}>
          <p className={styles.kicker}>Responsive and motion checks</p>
          <div className={styles.previewGrid}>
            <section
              className={styles.preview}
              aria-label="Narrow 360 pixel component preview"
              data-preview="narrow"
            >
              <header className={styles.previewHead}>
                <strong>Narrow preview</strong>
                <span>360 px component frame</span>
              </header>
              <div className={styles.narrowFrame}>
                <SettingsNav projectId="prj_proof" current="project" />
                <Field label="Run name" htmlFor="proof-narrow-name">
                  <Input
                    id="proof-narrow-name"
                    value="Regression check"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={() => undefined}
                  />
                </Field>
              </div>
            </section>

            <section
              className={`${styles.preview} ${styles.reducedFrame}`}
              aria-label="Reduced motion component preview"
              data-preview="reduced-motion"
            >
              <header className={styles.previewHead}>
                <strong>Reduced motion preview</strong>
                <span>Spatial movement is removed; color and opacity stay brief</span>
              </header>
              <div className={styles.reducedActions}>
                <BaseButton type="button">Run test</BaseButton>
                <Tooltip label="Keyboard and reduced-motion feedback does not move.">
                  <button className={styles.tooltipTrigger} type="button">Read motion rule</button>
                </Tooltip>
              </div>
            </section>
          </div>
        </article>

        <article className={`${styles.panel} ${styles.wide}`}>
          <div className={styles.sectionHead}>
            <div>
              <p className={styles.kicker}>Dense data</p>
              <h2>Agents</h2>
            </div>
            <Actions>
              <BaseButton type="button">Register agent</BaseButton>
            </Actions>
          </div>
          <DataTable label="Proof agents" columns={COLUMNS} rows={AGENTS} keyOf={(agent) => agent.id} />
        </article>

        <article className={styles.panel}>
          <p className={styles.kicker}>Page states</p>
          <div className={styles.states}>
            <Loading what="agents" />
            <Empty title="No agents yet" lead="Register the first agent to start testing." />
            <Failure message="Egma could not load this project." onRetry={() => undefined} />
          </div>
        </article>

        <article className={styles.panel}>
          <p className={styles.kicker}>Simulation evidence</p>
          <Transcript transcript={TRANSCRIPT} highlighted={[2]} />
        </article>
      </section>

      {dialog ? (
        <Dialog title="Archive Support agent?" onClose={() => setDialog(false)}>
          {(dismiss) => (
            <>
              <p className={styles.dialogCopy}>
                Existing runs and simulations stay available. New runs cannot use this agent.
              </p>
              <div className={styles.dialogActions}>
                <BaseButton type="button" variant="secondary" onClick={dismiss}>
                  Cancel
                </BaseButton>
                <BaseButton
                  type="button"
                  variant="destructive"
                  onClick={() => setDialog(false)}
                >
                  Archive agent
                </BaseButton>
              </div>
            </>
          )}
        </Dialog>
      ) : null}

      <Toast
        open={toast}
        input={toastInput}
        title="Agent saved"
        onDismiss={(input) => {
          setToastInput(input);
          setToast(false);
        }}
      >
        Support agent is ready for the next run.
      </Toast>
      </div>
      </ProductPage>
    </AppShell>
  );
}
