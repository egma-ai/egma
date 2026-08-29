"use client";

import { useRef, useState } from "react";

import { EllipsisIcon } from "lucide-react";
/*
 * Aliased for the same reason the primitives below are: this component already
 * holds a `toast` of its own — the open state of the shared product toast — and
 * the two would silently shadow one another.
 */
import { toast as baseToast } from "sonner";

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
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip as BaseTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { GradingState, RunProgress } from "../../ui/run-status.tsx";
import { Actions, SearchField, Section, Toolbar } from "../../ui/section.tsx";
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

/**
 * The heading that names one component inside a panel.
 *
 * It is weight 500, because it is a heading and `DESIGN.md` reserves 500 for
 * "section, state, or dialog titles that need stronger hierarchy" — the same
 * rule that separates it from `KICKER` above.
 *
 * Every `<h3>` on the page reads it, including the six on the older panels that
 * wrote the same three utilities out by hand. Naming it once is the rule this
 * file states at the top — "named once rather than written nine times because
 * nine copies drift" — and a constant that only the newest sections obeyed
 * would have been a seventh copy with extra steps.
 */
const SUBHEAD =
  "m-0 text-sm font-medium uppercase tracking-(--tracking-label) text-muted-foreground";

/**
 * One inset demonstration: a component shown on the canvas colour inside a
 * panel, so the panel around it reads as a list of them.
 *
 * Both users of it are here rather than in two constants. It started as the
 * frame for the two responsive and reduced-motion previews, and each primitive
 * specimen wants the same frame — and two identical strings are the drift this
 * file names at the top. `PREVIEW_HEAD` stays separate because only the two
 * previews carry a titled header.
 */
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
  /*
   * The row menu's lane.
   *
   * `action: true` is what makes the cell a fixed `--table-action-width` slot
   * at the trailing edge, on every row and in the header, so the ⋮ marks line
   * up in one column down the table instead of each floating to the right of
   * whatever text came before it. It is drawn here because a lane that only
   * exists on product screens is a lane nothing holds to the boards.
   */
  {
    key: "menu",
    header: "Actions",
    action: true,
    cell: (agent) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <BaseButton
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${agent.name}`}
          >
            <EllipsisIcon />
          </BaseButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem>Open</DropdownMenuItem>
          <DropdownMenuItem>Edit</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">Archive</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  },
];

const TRANSCRIPT: EvidenceTranscript = {
  traceId: "trc_proof",
  startedAt: "2026-08-15T12:00:00.000Z",
  endedAt: "2026-08-15T12:00:18.000Z",
  durationNs: "18000000000",
  spanCount: 2,
  turnCounts: { human: 1, agent: 1 },
  toolSpanCount: 0,
  erroredSpanCount: 0,
  turns: [
    {
      spanId: "spn_human",
      parentSpanId: "",
      name: "human",
      kind: "turn:human",
      status: "ok",
      startedAt: "2026-08-15T12:00:00.000Z",
      durationNs: "4000000000",
      text: "I need to move my booking to Tuesday afternoon.",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      spans: [],
    },
    {
      spanId: "spn_agent",
      parentSpanId: "",
      name: "agent",
      kind: "turn:agent",
      status: "ok",
      startedAt: "2026-08-15T12:00:05.000Z",
      durationNs: "5000000000",
      text: "I found the booking. I can move it after I verify the email address.",
      audioUrl: "",
      toolName: "",
      toolArguments: "",
      toolResult: "",
      spans: [],
    },
  ],
  spans: [],
  spansTruncated: false,
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
  const [reuse, setReuse] = useState<"same" | "fresh">("same");
  const [finished, setFinished] = useState(7);
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
              <h3 className={SUBHEAD}>
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
                <h3 className={SUBHEAD}>
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
                <h3 className={SUBHEAD}>
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
                <h3 className={SUBHEAD}>
                  Theme, straight from the tokens
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  <div className="h-10 rounded-input border border-border bg-chrome" title="Neutral Paper" />
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
              <h3 className={SUBHEAD}>
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
                  label="Share of production traces graded"
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
                    Grades whether the agent stated the refund window before it
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
                  <BaseButton size="sm">View grades</BaseButton>
                  <BaseButton size="sm" variant="ghost">
                    Read the definition
                  </BaseButton>
                </CardFooter>
              </Card>

              <div className="flex flex-col gap-4">
                <h3 className={SUBHEAD}>
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
                        Delete test suite
                      </BaseButton>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>
                          Delete the Refund checks test suite?
                        </DialogTitle>
                        <DialogDescription>
                          Existing runs keep their frozen test versions. No
                          future run can use this suite.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <DialogClose asChild>
                          <BaseButton variant="secondary">Keep suite</BaseButton>
                        </DialogClose>
                        <DialogClose asChild>
                          <BaseButton variant="destructive">
                            Delete test suite
                          </BaseButton>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </BaseDialog>

                  <Sheet>
                    <SheetTrigger asChild>
                      <BaseButton type="button">Open connection</BaseButton>
                    </SheetTrigger>
                    <SheetContent aria-describedby={undefined}>
                      <SheetHeader>
                        <SheetTitle>phone</SheetTitle>
                        <SheetDescription>
                          Retell · production
                        </SheetDescription>
                      </SheetHeader>
                      <SheetBody>
                        <Field label="Name" htmlFor="proof-sheet-name">
                          <Input
                            id="proof-sheet-name"
                            value="phone"
                            autoComplete="off"
                            spellCheck={false}
                            onChange={() => undefined}
                          />
                        </Field>
                        <Field label="Phone number" htmlFor="proof-sheet-number">
                          <Input
                            id="proof-sheet-number"
                            value="+1 415 555 0134"
                            autoComplete="off"
                            spellCheck={false}
                            onChange={() => undefined}
                          />
                        </Field>
                        <p className="m-0 text-sm text-faint">
                          Created Aug 16, 2026 · Updated Aug 20, 2026
                        </p>
                      </SheetBody>
                      <SheetFooter
                        destructive={
                          <BaseButton type="button" variant="ghost" className="text-failure">
                            Delete
                          </BaseButton>
                        }
                      >
                        <BaseButton type="button" size="lg">
                          Save connection
                        </BaseButton>
                        <SheetClose asChild>
                          <BaseButton type="button" size="lg" variant="secondary">
                            Cancel
                          </BaseButton>
                        </SheetClose>
                      </SheetFooter>
                    </SheetContent>
                  </Sheet>
                </div>
                <p className="m-0 text-sm text-muted-foreground">
                  The menu and the popover grow from the control that opened
                  them; the dialog stays centred; the side sheet comes in from
                  the right edge it is anchored to. Every duration is a
                  DESIGN.md motion token and every one is under 300ms.
                </p>
              </div>
            </div>
          </div>
        </article>

        {/*
          * The primitives the kit gained for the wrapper migration.
          *
          * They are on this page because nothing else draws some of them yet: a
          * primitive with no caller is a primitive whose light theme, dark
          * theme, keyboard model, and reduced-motion form nobody has looked at.
          * Each one is shown in the states a reviewer actually has to check
          * rather than in a single happy example.
          */}
        <article className={cn(PANEL_WIDE)}>
          <p className={KICKER}>Component base — tabs, choice, progress, and feedback</p>
          <div className="flex flex-col gap-8">
            <p className="m-0 max-w-[68ch] text-base text-muted-foreground">
              Each of these is the raw primitive, before any shared component
              wraps it. That is deliberate: a change to a primitive shows up on
              this page before it reaches a screen, and a primitive that only
              ever appeared inside a wrapper would hide which of the two owns
              the behaviour.
            </p>

            <div className="flex flex-col gap-4">
              <h3 className={SUBHEAD}>Tabs</h3>
              <p className="m-0 max-w-[68ch] text-sm text-muted-foreground">
                One set, one panel visible, and the keyboard model that goes
                with it: a single Tab step reaches the set rather than every tab
                in it, and the arrow keys move along the set and change the
                panel.
              </p>
              {/*
                * Said out loud on the proof surface, because it is the decision
                * a reviewer is most likely to want to argue with.
                *
                * The two grader views are separate addresses. A tab set claims
                * `role="tab"`, a panel that updates in place, and a roving tab
                * order — none of which is true of a link that loads a new page
                * — and it costs the link its middle-click, its copy-link, and
                * its place in the tab order. So the grader strip stays a
                * navigation of links marked with `aria-current="page"`, and
                * this is where a real tab set is proven instead.
                */}
              <p className="m-0 max-w-[68ch] text-sm text-muted-foreground">
                The two grader views are not a tab set. They are separate
                addresses, so they stay a navigation of links.
              </p>
              <div className="grid gap-4 md:grid-cols-2">
                <div className={PREVIEW}>
                  <Tabs defaultValue="simulations">
                    <TabsList>
                      <TabsTrigger value="simulations">Simulations</TabsTrigger>
                      <TabsTrigger value="graders">Graders</TabsTrigger>
                      <TabsTrigger value="persona">Persona</TabsTrigger>
                    </TabsList>
                    <TabsContent value="simulations">
                      <p className="m-0 text-sm text-muted-foreground">
                        Ten simulations ran. Seven passed, two failed, one was
                        skipped because the connection refused the call.
                      </p>
                    </TabsContent>
                    <TabsContent value="graders">
                      <p className="m-0 text-sm text-muted-foreground">
                        Two graders graded each completed simulation in this
                        run. Both were frozen when it started, so a later edit
                        cannot change those grades.
                      </p>
                    </TabsContent>
                    <TabsContent value="persona">
                      <p className="m-0 text-sm text-muted-foreground">
                        A caller who has already been transferred twice and asks
                        for a refund outside the stated window.
                      </p>
                    </TabsContent>
                  </Tabs>
                </div>
                <div className={PREVIEW}>
                  <Tabs defaultValue="transcript">
                    <TabsList variant="line">
                      <TabsTrigger value="transcript">Transcript</TabsTrigger>
                      <TabsTrigger value="outcome">Outcome</TabsTrigger>
                    </TabsList>
                    <TabsContent value="transcript">
                      <p className="m-0 text-sm text-muted-foreground">
                        Every turn of the simulation, in the order it happened.
                      </p>
                    </TabsContent>
                    <TabsContent value="outcome">
                      <p className="m-0 text-sm text-muted-foreground">
                        What each grader decided, and the turn it cited.
                      </p>
                    </TabsContent>
                  </Tabs>
                </div>
                {/*
                  * The third shape the component draws, and the one nothing in
                  * the product uses yet.
                  *
                  * A vertical rail marks the current tab down its trailing edge
                  * instead of under it, which is a separate set of rules from
                  * the two above — and rules no page would have caught. It is
                  * here so the shape is proven rather than dead: a strip of
                  * evidence views is the layout it is waiting for.
                  *
                  * The disabled tab is the other half. "Disable rather than
                  * hide" is this product's decision, so a set that can hold an
                  * unavailable choice has to show what one looks like: still
                  * read, still named, and not reachable by the arrow keys.
                  */}
                <div className={PREVIEW}>
                  <Tabs defaultValue="turns" orientation="vertical">
                    <TabsList variant="line">
                      <TabsTrigger value="turns">Turns</TabsTrigger>
                      <TabsTrigger value="metrics">Metrics</TabsTrigger>
                      <TabsTrigger value="recording" disabled>
                        Recording
                      </TabsTrigger>
                    </TabsList>
                    <TabsContent value="turns">
                      <p className="m-0 text-sm text-muted-foreground">
                        What the caller and the agent each said.
                      </p>
                    </TabsContent>
                    <TabsContent value="metrics">
                      <p className="m-0 text-sm text-muted-foreground">
                        How long each turn took the agent to answer.
                      </p>
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-4">
              <h3 className={SUBHEAD}>Single choice</h3>
              <p className="m-0 max-w-[68ch] text-sm text-muted-foreground">
                One answer out of a small set, with every option left in view. A
                menu hides the options that were not taken; this is for a choice
                a reader is meant to compare before making it.
              </p>
              <div className={PREVIEW}>
                {/*
                  * The question is on the page rather than only in an
                  * `aria-label`. `DESIGN.md` says labels stay visible, and a
                  * group of options whose question only a screen reader is told
                  * leaves everybody else reading two answers to nothing. The
                  * same element is what names the group, so the two cannot
                  * drift apart.
                  */}
                <p
                  className="m-0 mb-3 text-sm font-medium text-foreground"
                  id="proof-reuse-question"
                >
                  What a repeated run reuses
                </p>
                <RadioGroup
                  value={reuse}
                  onValueChange={(next) => setReuse(next as "same" | "fresh")}
                  aria-labelledby="proof-reuse-question"
                >
                  <div className="flex min-h-(--tap-target) items-center gap-3">
                    <RadioGroupItem id="proof-reuse-same" value="same" />
                    <Label htmlFor="proof-reuse-same">
                      The same persona for every simulation
                    </Label>
                  </div>
                  <div className="flex min-h-(--tap-target) items-center gap-3">
                    <RadioGroupItem id="proof-reuse-fresh" value="fresh" />
                    <Label htmlFor="proof-reuse-fresh">
                      A new persona for each simulation
                    </Label>
                  </div>
                </RadioGroup>
                <p className="mt-3 mb-0 text-sm text-muted-foreground">
                  Chosen: {reuse === "same" ? "the same persona" : "a new persona"}
                </p>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-4">
              <h3 className={SUBHEAD}>Progress</h3>
              <p className="m-0 max-w-[68ch] text-sm text-muted-foreground">
                Completion, filled on a transform and timed linear while the
                work is still moving. A fill that slowed down at the end would
                be saying the run was slowing down. Under reduced motion the bar
                is simply at its new length, and the count beside it is what
                says it changed.
              </p>
              {/*
                * Three bars rather than one, because the three are the states
                * the component has: a value on its way up, a value that has
                * arrived, and no value at all. The last one is the one a happy
                * example always skips — an indeterminate bar must stay empty
                * rather than sit at zero, because "amount unknown" and "nothing
                * done" are different claims.
                */}
              <div className={PREVIEW}>
                <div className="grid gap-5">
                  {/*
                    * "Graded" rather than "finished", and that is not a word
                    * chosen for variety. `RunProgress` is drawn further down
                    * this page and is already labelled "Simulations finished";
                    * a second bar wearing the same name would leave a reader
                    * moving between the two with no way to tell which one they
                    * had landed on.
                    */}
                  <div className="grid gap-2">
                    <Progress
                      value={finished}
                      max={10}
                      aria-label="Simulations graded"
                      getValueLabel={(value, max) =>
                        `${String(value)} of ${String(max)} simulations graded`
                      }
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="text-sm tabular-nums text-muted-foreground">
                        {finished} of 10 simulations graded
                      </span>
                      <BaseButton
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={finished >= 10}
                        onClick={() => setFinished((count) => Math.min(10, count + 1))}
                      >
                        Grade one more simulation
                      </BaseButton>
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Progress
                      value={10}
                      max={10}
                      aria-label="Transcripts collected"
                      getValueLabel={(value, max) =>
                        `${String(value)} of ${String(max)} transcripts collected`
                      }
                    />
                    <span className="text-sm tabular-nums text-muted-foreground">
                      Complete: 10 of 10 transcripts collected
                    </span>
                  </div>
                  <div className="grid gap-2">
                    <Progress aria-label="Recording being prepared" />
                    <span className="text-sm text-muted-foreground">
                      Indeterminate: the recording is being prepared and the
                      share of it is not known
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            <div className="grid gap-6 md:grid-cols-2">
              <div className="flex flex-col gap-4">
                <h3 className={SUBHEAD}>Tooltip</h3>
                <p className="m-0 max-w-[68ch] text-sm text-muted-foreground">
                  A short explanation attached to one control, and never an
                  action: help a person has to click belongs in a menu or a
                  dialog. The tooltips in the panels above are the shared
                  product one; this is the primitive underneath it.
                </p>
                <div className={PREVIEW}>
                  <TooltipProvider>
                    <BaseTooltip>
                      <TooltipTrigger asChild>
                        <BaseButton type="button" variant="secondary">
                          What a frozen grader means
                        </BaseButton>
                      </TooltipTrigger>
                      <TooltipContent sideOffset={8}>
                        A run keeps the grader it started with, so editing the
                        grader never changes a grade already recorded.
                      </TooltipContent>
                    </BaseTooltip>
                  </TooltipProvider>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                <h3 className={SUBHEAD}>Toast</h3>
                <p className="m-0 max-w-[68ch] text-sm text-muted-foreground">
                  Arrival and dismissal, said once and out of the way of the
                  work. The word and the symbol carry the state together, so the
                  notification never rests on colour alone.
                </p>
                <div className={cn(PREVIEW, "flex flex-wrap items-center gap-3")}>
                  <BaseButton
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      baseToast.success("Grader saved", {
                        description:
                          "The next run will use this version.",
                      })
                    }
                  >
                    Show a saved notification
                  </BaseButton>
                  <BaseButton
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      baseToast.error("Run could not start", {
                        description:
                          "The connection refused the call. Nothing was charged.",
                      })
                    }
                  >
                    Show a failed notification
                  </BaseButton>
                </div>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-4">
              <h3 className={SUBHEAD}>Skeleton</h3>
              <p className="m-0 max-w-[68ch] text-sm text-muted-foreground">
                The shape of what is coming, for the moment before it arrives. A
                skeleton is a shape and nothing else, so the word stays beside
                it: <code className="font-mono text-sm">DESIGN.md</code> asks a
                loading state to say what is happening, and a grey rectangle
                does not say it.
              </p>
              {/*
                * The pulse is the theme's own skeleton keyframes, keyed on the
                * kit slot at 560ms with egma's easing, and its reduced-motion
                * form lives beside it in the theme — nothing here needs to
                * write motion or take it away.
                */}
              <div className={PREVIEW} role="status" aria-busy="true">
                <p className="m-0 mb-4 text-sm text-muted-foreground">
                  Loading graders…
                </p>
                <div className="grid gap-3" aria-hidden="true">
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-chip" />
                    <Skeleton className="h-4 w-[min(220px,60%)]" />
                    <Skeleton className="ml-auto h-4 w-16" />
                  </div>
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-chip" />
                    <Skeleton className="h-4 w-[min(180px,50%)]" />
                    <Skeleton className="ml-auto h-4 w-16" />
                  </div>
                  <div className="flex items-center gap-3">
                    <Skeleton className="size-8 rounded-chip" />
                    <Skeleton className="h-4 w-[min(260px,70%)]" />
                    <Skeleton className="ml-auto h-4 w-16" />
                  </div>
                </div>
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
            <BaseBadge variant="warning">Needs review</BaseBadge>
            <BaseBadge variant="failure">Failed</BaseBadge>
            <GradingState grading="error" />
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
          <SettingsNav projectId="prj_proof" current="organization" />
          <Refused
            message="Your viewer role cannot change organization settings. Your draft is still here."
            action={
              <BaseButton type="button" variant="secondary">
                Review project access
              </BaseButton>
            }
          />
        </article>

        <article className={cn(PANEL_WIDE)}>
          <p className={KICKER}>Responsive, theme and motion checks</p>
          <div className="grid grid-cols-2 gap-6 max-[760px]:grid-cols-1 max-[760px]:gap-4">
            {/*
              * **The dark theme, beside the light one rather than instead of
              * it.** Every shared component has to support both, and the way
              * that rule is broken is never on purpose — it is a colour written
              * where a token belonged, and it only shows when the two are held
              * against each other. The account menu's switch still flips the
              * whole document; this frame is what makes a difference visible
              * without leaving the page.
              *
              * `data-theme` on a `<div>` works because `tailwind-theme.css`
              * binds the dark values to the attribute as well as to `:root`.
              */}
            <section
              className={cn(PREVIEW, "col-span-2 max-[760px]:col-span-1")}
              aria-label="Dark theme component preview"
              data-preview="dark"
              data-theme="dark"
            >
              <header className={cn(PREVIEW_HEAD)}>
                <strong className="font-medium">Dark theme preview</strong>
                <span className="text-muted-foreground">
                  The same components on the dark tokens
                </span>
              </header>
              <div className="flex flex-col gap-4 bg-background p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <BaseButton type="button">Connect an agent</BaseButton>
                  <BaseButton type="button" variant="secondary">
                    Edit
                  </BaseButton>
                  <BaseButton type="button" variant="destructive">
                    Archive
                  </BaseButton>
                  <BaseBadge variant="success">Passed</BaseBadge>
                  <BaseBadge shape="count">+3</BaseBadge>
                </div>
                <SearchField
                  id="proof-dark-search"
                  aria-label="Search agents by name in the dark preview"
                  placeholder="Search by name"
                  value=""
                  autoComplete="off"
                  onChange={() => undefined}
                />
                <DataTable
                  label="Proof agents in dark theme"
                  columns={COLUMNS}
                  rows={AGENTS.slice(0, 2)}
                  keyOf={(agent) => agent.id}
                />
              </div>
            </section>

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
          {/*
            * The list toolbar, at the shape every list page has: the 300×36
            * search box on the left, the one action hard right.
            */}
          <Toolbar
            action={<BaseButton type="button">Connect an agent</BaseButton>}
          >
            <SearchField
              id="proof-agent-search"
              aria-label="Search proof agents by name"
              placeholder="Search by name"
              value=""
              autoComplete="off"
              onChange={() => undefined}
            />
          </Toolbar>
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

      {/*
        * The kit toaster, parked at the top so it never lands on the shared
        * toast above. Both live on this page on purpose: the shared one is the
        * product notification a screen reaches for today, and this is the
        * primitive a later ticket has the option of moving it onto. Two
        * notifications stacked in the same corner would have proved neither.
        */}
      <Toaster position="top-right" />
      </div>
      </ProductPage>
    </AppShell>
  );
}
