"use client";

import { useRef, useState } from "react";

import type { Me } from "../../lib/me.ts";
import type { EvidenceTranscript } from "../../lib/simulations.ts";
import {
  Actions,
  Badge,
  Button,
  Checkbox,
  Choice,
  Field,
  Form,
  FormActions,
  FormRow,
  Refused,
  Section,
  Select,
  TextArea,
  TextInput,
  Toolbar,
} from "../../ui/controls.tsx";
import { DataTable, type Column } from "../../ui/data-table.tsx";
import { Dialog } from "../../ui/dialog.tsx";
import { Transcript } from "../../ui/evidence.tsx";
import { Toast, Tooltip, type FeedbackInput } from "../../ui/feedback.tsx";
import { Menu, MenuDivider, MenuItem, MenuLabel } from "../../ui/menu.tsx";
import { Empty, Failure, Loading } from "../../ui/page-state.tsx";
import { ProjectSelector } from "../../ui/project-selector.tsx";
import { RunProgress, VerdictBadge } from "../../ui/run-status.tsx";
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
      <Badge tone={agent.state === "Active" ? "good" : "neutral"}>{agent.state}</Badge>
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
        <article className={styles.panel}>
          <p className={styles.kicker}>Project context</p>
          <ProjectSelector
            organization={PROOF_ME.organizations[0]}
            projects={PROOF_ME.projects}
            projectId="prj_proof"
          />
          <div className={styles.actions}>
            <Button weight="strong" onClick={() => setDialog(true)}>Register agent</Button>
            <Button>Quiet action</Button>
            <Button disabled why="Only an administrator can archive this agent.">Archive</Button>
            <Button busy>Saving agent…</Button>
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
              <Button onClick={() => {
                setToastInput(nextFeedbackInput.current);
                setToast(true);
              }}>
                Show saved feedback
              </Button>
            </span>
          </div>
          <div className={styles.badges}>
            <Badge>Viewer</Badge>
            <Badge tone="good">Passed</Badge>
            <Badge tone="warn">Skipped</Badge>
            <Badge tone="bad">Failed</Badge>
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
                  <TextInput id="proof-name" value={name} onChange={setName} />
                </Field>
                <Field label="Environment" htmlFor="proof-environment">
                  <Select
                    id="proof-environment"
                    value={environment}
                    options={[
                      { value: "staging", label: "Staging" },
                      { value: "production", label: "Production" },
                    ]}
                    onChange={setEnvironment}
                  />
                </Field>
                <Field
                  label="Max concurrency"
                  htmlFor="proof-concurrency"
                  hint="Local runs use one shared concurrency value."
                >
                  <TextInput
                    id="proof-concurrency"
                    value={maxConcurrency}
                    numeric
                    onChange={setMaxConcurrency}
                  />
                </Field>
              </FormRow>
              <Field label="Description" htmlFor="proof-description">
                <TextArea
                  id="proof-description"
                  rows={4}
                  value={description}
                  onChange={setDescription}
                />
              </Field>
              <div className={styles.checkboxRow}>
                <Checkbox
                  id="proof-archived"
                  checked={includeArchived}
                  onChange={setIncludeArchived}
                />
                <label htmlFor="proof-archived">Include archived tests in this run</label>
              </div>
              <FormActions>
                <Button weight="strong" type="submit">Save agent</Button>
                <Button>Cancel</Button>
              </FormActions>
            </Form>
          </Section>
        </article>

        <article className={`${styles.panel} ${styles.wide}`}>
          <p className={styles.kicker}>Settings scope and refusal</p>
          <SettingsNav projectId="prj_proof" current="judge" />
          <Refused
            message="Your viewer role cannot change the default judge. Your draft is still here."
            action={<Button>Review project access</Button>}
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
                  <TextInput
                    id="proof-narrow-name"
                    value="Regression check"
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
                <Button weight="strong">Run test</Button>
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
            <Actions><Button weight="strong">Register agent</Button></Actions>
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
                <Button onClick={dismiss}>Cancel</Button>
                <Button weight="strong" onClick={() => setDialog(false)}>Archive agent</Button>
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
