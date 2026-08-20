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
import { cn } from "@/lib/utils";

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

/*
 * This page's own layout, which was a route CSS Module until ticket 19.
 *
 * It stays in this file rather than moving to `ui/` because it is one route's
 * layout rather than product behaviour, and `DESIGN.md` asks a route page to
 * "compose shared components and add only route-specific layout". It is named
 * once rather than written nine times because nine copies drift. Tailwind reads
 * `.tsx` files as text, so a class named in a constant here is generated
 * exactly as one written in the markup is.
 */

/** One proof card: a group on Pure Paper, wearing the card radius. */
const PANEL = [
  "min-w-0 rounded-card border border-border bg-surface p-6",
  "max-[760px]:px-4 max-[760px]:py-5",
];

/** The same card across both columns, until the grid is one column anyway. */
const PANEL_WIDE = [...PANEL, "col-span-full max-[760px]:col-auto"];

/**
 * The small uppercase label that heads the page and names each panel.
 *
 * It is weight 400, unlike the `<h3>` labels inside the base panel, which are
 * headings and take weight 500. The stylesheet drew both from one declaration
 * and the difference was the element; it is said out loud now.
 */
const KICKER =
  "m-0 mb-3 text-sm uppercase tracking-(--tracking-label) text-muted-foreground";

/** One of the two component previews, and the line that titles it. */
const PREVIEW = "min-w-0 rounded-input border border-border bg-background p-4";
const PREVIEW_HEAD = [
  "mb-4 flex items-baseline justify-between gap-3 text-sm text-foreground",
  "max-[760px]:flex-col max-[760px]:items-start max-[760px]:gap-1",
];

/**
 * The tooltip's trigger, drawn twice on this page.
 *
 * It is a hand-written control rather than `BaseButton variant="secondary"`,
 * which it otherwise matches: this page proves a tooltip on a plain `<button>`,
 * and the two differ in weight — 400 here against the base button's 500 — so
 * swapping it would change the page rather than the implementation. Called out
 * in the pull request as a follow-up rather than taken here.
 */
const TRIGGER = [
  "min-h-(--control-lg) cursor-pointer px-4",
  "rounded-button border border-border-strong bg-transparent text-sm text-foreground",
  "pointer-hover:border-foreground pointer-hover:bg-surface-soft",
];

/** Pointer press feedback, and the reduced form of it. */
const TRIGGER_PRESS = [
  "transition-transform duration-(--duration-press) ease-out",
  "[&:active:not(:focus-visible)]:scale-97",
  "motion-reduce:transition-none",
  "motion-reduce:[&:active:not(:focus-visible)]:scale-100",
];

/**
 * The same trigger inside the reduced-motion frame: nothing moves, and the
 * colour feedback stays and runs linear. See the frame itself for why this is
 * written on the control rather than reached for from the frame around it.
 */
const TRIGGER_REDUCED =
  "transition-[color,background-color,border-color] duration-(--duration-hover) ease-linear";

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
      <div className="text-foreground">
      <header className="mb-12 w-[min(760px,100%)] max-[760px]:mb-8">
        <p className={KICKER}>Development proof surface</p>
        {/*
          * A heading carries no size of its own in this product, and this one
          * takes a `clamp()` rather than a step off the scale: the page title
          * has to hold three words on a phone as well as fill a wide monitor.
          * The ceiling is the display step; the floor and the rate it grows at
          * are values the scale has no name for, so they are written out.
          */}
        <h1 className="m-0 max-w-[12ch] text-[clamp(44px,7vw,var(--text-display))] leading-[0.95] font-normal tracking-[-0.04em]">
          Egma product system
        </h1>
        <p className="mt-6 mb-0 max-w-[60ch] text-muted-foreground">
          The real product shell and shared components, shown together across
          agents, tests, runs, simulations, graders, personas, and Settings.
        </p>
      </header>

      <section
        className="grid w-full grid-cols-2 gap-6 max-[760px]:grid-cols-1 max-[760px]:gap-4"
        aria-label="Shared component proof"
      >
        <article className={cn(PANEL_WIDE)}>
          <p className={KICKER}>Component base — shadcn on Tailwind</p>
          <div className="flex flex-col gap-8">
            <p className="m-0 max-w-[68ch] text-base text-muted-foreground">
              The primitives every screen is built from. Nothing here sets a
              colour, a radius, or a duration of its own: every one is a theme
              key in{" "}
              <code className="font-mono text-sm">ui/tailwind-theme.css</code>,
              so a value is changed in that one file and every surface on this
              page changes with it.
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

        <article className={cn(PANEL)}>
          <p className={KICKER}>Project context</p>
          <ProjectSelector
            organization={PROOF_ME.organizations[0]}
            projects={PROOF_ME.projects}
            projectId="prj_proof"
          />
          <div className="mt-6 flex flex-wrap items-center gap-3">
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
              <button className={cn(TRIGGER, TRIGGER_PRESS)} type="button">
                Copy identifier
              </button>
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
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <BaseBadge>Viewer</BaseBadge>
            <BaseBadge variant="success">Passed</BaseBadge>
            <BaseBadge variant="warning">Skipped</BaseBadge>
            <BaseBadge variant="failure">Failed</BaseBadge>
            <VerdictBadge verdict="errored" />
          </div>
        </article>

        <article className={cn(PANEL)}>
          <p className={KICKER}>Menu and choice</p>
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
          <p className="mt-5 mb-3 text-base text-muted-foreground">
            Selected list: {list}
          </p>
          <RunProgress finished={7} expected={10} />
        </article>

        <article className={cn(PANEL_WIDE)}>
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
              <div className="flex min-h-(--tap-target) items-center gap-3 text-sm text-foreground">
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

        <article className={cn(PANEL_WIDE)}>
          <p className={KICKER}>Settings scope and refusal</p>
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

        <article className={cn(PANEL_WIDE)}>
          <p className={KICKER}>Responsive and motion checks</p>
          <div className="grid grid-cols-2 gap-6 max-[760px]:grid-cols-1 max-[760px]:gap-4">
            <section
              className={PREVIEW}
              aria-label="Narrow 360 pixel component preview"
              data-preview="narrow"
            >
              <header className={cn(PREVIEW_HEAD)}>
                <strong className="font-medium">Narrow preview</strong>
                <span className="text-muted-foreground">
                  360 px component frame
                </span>
              </header>
              {/* A fixed component frame makes narrow wrapping visible on a wide
                * monitor, so 360px is a device width rather than a step off any
                * scale. */}
              <div className="w-[min(360px,100%)] rounded-input border border-border bg-surface p-4">
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

            {/*
              * The reduced-motion frame, and the two controls that demonstrate it.
              *
              * The stylesheet this replaces said it in two rules that reached
              * the shadcn base button by element name — `.reducedFrame button`
              * for the transition, and the same selector with
              * `:active:not(:focus-visible):not(:disabled)` to cancel the
              * press. That reach is what ticket 19 removes.
              *
              * The two rules say one thing: **inside this frame a button is
              * drawn in its reduced-motion form** — no spatial press, and the
              * colour feedback kept and made linear, which is the "useful
              * opacity or color feedback" `DESIGN.md` asks every movement to
              * have.
              *
              * It is written on the two controls rather than kept as a
              * `[&_button]:` variant, because that variant is the same
              * element-selector reach in another notation: it would still catch
              * a button a nested shared component happens to render, which is
              * how the original rule came to dress the base button in the first
              * place. The two also need different class lists — the base button
              * changes only its easing, the trigger states its whole transition
              * — so one blanket rule could not say both.
              *
              * The tooltip half of this frame is not here at all:
              * `tailwind-theme.css` keys it on `data-preview="reduced-motion"`,
              * which is why that attribute stays exactly as it is.
              */}
            <section
              className={PREVIEW}
              aria-label="Reduced motion component preview"
              data-preview="reduced-motion"
            >
              <header className={cn(PREVIEW_HEAD)}>
                <strong className="font-medium">Reduced motion preview</strong>
                <span className="text-muted-foreground">
                  Spatial movement is removed; color and opacity stay brief
                </span>
              </header>
              <div className="flex min-h-[120px] items-center justify-center gap-3 rounded-input border border-dashed border-border bg-surface p-6">
                <BaseButton
                  className={cn(
                    "ease-linear",
                    /*
                     * `transform-none`, not the `scale-100` the hand-written
                     * controls on this page use to cancel a press. The base
                     * button's press is `transform: scale(0.97)` in
                     * `tailwind-theme.css` — on `transform` rather than on the
                     * `scale` property — so `scale: 100%` would leave it
                     * standing. A utility beats `@layer components` by layer
                     * order, whatever the specificity.
                     */
                    "[&:active:not(:focus-visible):not(:disabled)]:transform-none",
                  )}
                  type="button"
                >
                  Run test
                </BaseButton>
                <Tooltip label="Keyboard and reduced-motion feedback does not move.">
                  <button className={cn(TRIGGER, TRIGGER_REDUCED)} type="button">
                    Read motion rule
                  </button>
                </Tooltip>
              </div>
            </section>
          </div>
        </article>

        <article className={cn(PANEL_WIDE)}>
          <div className="mb-6 flex items-start justify-between gap-6 max-[760px]:flex-col max-[760px]:items-stretch">
            <div>
              <p className={KICKER}>Dense data</p>
              <h2 className="m-0 text-xl font-normal tracking-[-0.04em]">
                Agents
              </h2>
            </div>
            <Actions>
              <BaseButton type="button">Register agent</BaseButton>
            </Actions>
          </div>
          <DataTable label="Proof agents" columns={COLUMNS} rows={AGENTS} keyOf={(agent) => agent.id} />
        </article>

        <article className={cn(PANEL)}>
          <p className={KICKER}>Page states</p>
          <div className="grid gap-4">
            <Loading what="agents" />
            <Empty title="No agents yet" lead="Register the first agent to start testing." />
            <Failure message="Egma could not load this project." onRetry={() => undefined} />
          </div>
        </article>

        <article className={cn(PANEL)}>
          <p className={KICKER}>Simulation evidence</p>
          <Transcript transcript={TRANSCRIPT} highlighted={[2]} />
        </article>
      </section>

      {dialog ? (
        <Dialog title="Archive Support agent?" onClose={() => setDialog(false)}>
          {(dismiss) => (
            <>
              <p className="m-0 mb-6 text-base text-muted-foreground">
                Existing runs and simulations stay available. New runs cannot use this agent.
              </p>
              <div className="flex flex-wrap items-center justify-end gap-3">
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
