"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  deleteJson,
  writeJson,
  type Refusal,
} from "../../../../../lib/api.ts";
import { roleOf } from "../../../../../lib/me.ts";
import {
  LIVEKIT_MONITORING_PATH,
  MONITORING_API_PATH,
  replayRetellFailurePath,
  RETELL_DISCOVERY_PATH,
  RETELL_MONITORING_PATH,
  removeMonitoringPath,
  type MonitoringPlatform,
  type MonitoringSetup,
  type MonitoringSetups,
  type RetellAgentChoice,
  type RetellAgentChoices,
  type RetellMonitoredAgent,
} from "../../../../../lib/monitoring.ts";
import { projectPath } from "../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../lib/roles.ts";
import { settingsPath } from "../../../../../ui/settings-nav.tsx";
import {
  Actions,
  Button,
  ButtonLink,
  Checkbox,
  Field,
  Form,
  FormActions,
  Help,
  Problem,
  Select,
  TextInput,
} from "../../../../../ui/controls.tsx";
import { Dialog } from "../../../../../ui/dialog.tsx";
import { Failure, Loading } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  StateMark,
  type StateMarkKind,
} from "../../../../../ui/run-status.tsx";
import { useUnsavedChanges } from "../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../ui/shell.tsx";
import styles from "./setup.module.css";

type PlatformChoice = "" | MonitoringPlatform;
type RetellDraftState = { readonly unsaved: boolean; readonly busy: boolean };

const PLATFORM_OPTIONS: readonly {
  readonly value: PlatformChoice;
  readonly label: string;
}[] = [
  { value: "", label: "Choose an agent platform" },
  { value: "retell", label: "Retell" },
  { value: "livekit_agents", label: "LiveKit Agents" },
];

export default function MonitoringSetupPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <AppShell>
      <Setup projectId={projectId} />
    </AppShell>
  );
}

function Setup({ projectId }: { readonly projectId: string }) {
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const mayConfigure = role !== null && canAuthor(role);
  const { answer, reload, refresh } = useProjectRead<MonitoringSetups>(
    MONITORING_API_PATH,
    projectId,
  );
  const [platform, setPlatform] = useState<PlatformChoice>("");
  const [retellDraft, setRetellDraft] = useState<RetellDraftState>({
    unsaved: false,
    busy: false,
  });
  const [pendingPlatform, setPendingPlatform] =
    useState<PlatformChoice | null>(null);
  const [retellFormVersion, setRetellFormVersion] = useState(0);
  const back = projectPath(projectId, "monitoring", "transcripts");
  const shouldRefresh =
    answer?.status === "ready" && answer.value.setups.length > 0;

  useEffect(() => {
    if (!shouldRefresh) return undefined;
    const timer = window.setInterval(refresh, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh, shouldRefresh]);

  function choosePlatform(next: PlatformChoice): void {
    if (
      platform === "retell" &&
      next !== "retell" &&
      retellDraft.unsaved
    ) {
      if (!retellDraft.busy) setPendingPlatform(next);
      return;
    }
    setPlatform(next);
  }

  const header = (
    <PageHeader
      eyebrow="Monitoring"
      title="Set up monitoring"
      breadcrumbs={[
        { label: "Monitoring", href: back },
        { label: "Setup" },
      ]}
      lead="Choose the agent platform. Egma then shows how to monitor production conversations on that platform."
    />
  );

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Loading what="Monitoring setup" />
        </PageBody>
      </ProductPage>
    );
  }
  if (answer.status !== "ready") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const retell = answer.value.setups.find(
    (setup) => setup.agent_platform === "retell",
  );
  const livekit = answer.value.setups.find(
    (setup) => setup.agent_platform === "livekit_agents",
  );

  return (
    <ProductPage>
      {header}
      <PageBody>
        {answer.value.setups.length === 0 ? null : (
          <section className={styles.current} aria-labelledby="current-setups">
            <h2 id="current-setups" className={styles.heading}>
              Current setup
            </h2>
            {retell === undefined ? null : (
              <SetupStatus
                setup={retell}
                projectId={projectId}
                mayConfigure={mayConfigure}
                onChanged={reload}
              />
            )}
            {livekit === undefined ? null : (
              <SetupStatus
                setup={livekit}
                projectId={projectId}
                mayConfigure={mayConfigure}
                onChanged={reload}
              />
            )}
          </section>
        )}

        <Form>
          <Field
            label="Agent platform"
            htmlFor="monitoring-platform"
            hint="This selects the production setup. It does not create or change a simulation connection."
          >
            <Select
              id="monitoring-platform"
              value={platform}
              options={PLATFORM_OPTIONS}
              onChange={choosePlatform}
            />
          </Field>
        </Form>

        {platform === "retell" ? (
          <RetellSetup
            key={retellFormVersion}
            projectId={projectId}
            setup={retell}
            mayConfigure={mayConfigure}
            onDraftState={setRetellDraft}
            onSaved={reload}
          />
        ) : null}
        {platform === "livekit_agents" ? (
          <LiveKitSetup
            projectId={projectId}
            configured={livekit !== undefined}
            mayConfigure={mayConfigure}
            onSaved={reload}
          />
        ) : null}
      </PageBody>
      {pendingPlatform === null ? null : (
        <Dialog
          title="Discard Retell setup changes?"
          onClose={() => setPendingPlatform(null)}
        >
          {(dismiss) => (
            <>
              <p>
                The API key and voice-agent choices on this page have not been
                saved.
              </p>
              <Actions>
                <Button onClick={dismiss}>Keep editing</Button>
                <Button
                  tone="destructive"
                  onClick={() => {
                    const next = pendingPlatform;
                    setPendingPlatform(null);
                    setRetellFormVersion((version) => version + 1);
                    setPlatform(next);
                  }}
                >
                  Discard changes
                </Button>
              </Actions>
            </>
          )}
        </Dialog>
      )}
    </ProductPage>
  );
}

type StatusPresentation = {
  readonly text: string;
  readonly mark: StateMarkKind;
  readonly moving?: boolean;
};

function statusPresentation(setup: MonitoringSetup): StatusPresentation {
  if (setup.health.state === "invalid_credential") {
    return {
      text: "Retell rejected the stored key. Enter a new key below.",
      mark: "error",
    };
  }
  if (setup.health.state === "rate_limited") {
    return {
      text: "Retell is rate limiting this setup. Egma will retry.",
      mark: "waiting",
    };
  }
  if (setup.health.state === "provider_unavailable") {
    return { text: "Retell did not answer. Egma will retry.", mark: "error" };
  }
  const unexpected = setup.agents.filter(
    (agent) => agent.last_error_kind === "provider_contract",
  ).length;
  if (unexpected > 0) {
    return {
      text: `${unexpected} ${unexpected === 1 ? "agent received" : "agents received"} an unexpected Retell response. Egma will retry.`,
      mark: "error",
    };
  }
  const degraded = setup.agents.filter(
    (agent) => agent.state === "degraded",
  ).length;
  const importing = setup.agents.filter(
    (agent) => agent.state === "importing",
  ).length;
  if (degraded > 0) {
    const affected = `${degraded} ${degraded === 1 ? "agent needs" : "agents need"} attention.`;
    return {
      text:
        importing === 0
          ? affected
          : `${affected} ${importing} ${importing === 1 ? "agent is" : "agents are"} still importing.`,
      mark: "error",
    };
  }
  if (importing > 0) {
    return {
      text: `${importing} ${importing === 1 ? "agent is" : "agents are"} importing the previous 30 days.`,
      mark: "active",
      moving: true,
    };
  }
  if (setup.health.last_received_at === null) {
    return {
      text: "Waiting for the first production conversation.",
      mark: "waiting",
    };
  }
  return {
    text: `Last production conversation received ${new Date(
      setup.health.last_received_at,
    ).toLocaleString()}.`,
    mark: "complete",
  };
}

function agentProgress(agent: RetellMonitoredAgent): StatusPresentation {
  if (agent.last_error_kind === "provider_contract") {
    return { text: "Unexpected Retell response", mark: "error" };
  }
  if (agent.state === "degraded") {
    return { text: "Needs attention", mark: "error" };
  }
  if (agent.state === "importing") {
    return { text: "Importing 30 days", mark: "active", moving: true };
  }
  if (agent.scan_kind === "reconciliation") {
    return { text: "Checking recent history", mark: "active", moving: true };
  }
  return { text: "Active", mark: "complete" };
}

function SetupStatus({
  setup,
  projectId,
  mayConfigure,
  onChanged,
}: {
  readonly setup: MonitoringSetup;
  readonly projectId: string;
  readonly mayConfigure: boolean;
  readonly onChanged: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const label = setup.agent_platform === "retell" ? "Retell" : "LiveKit Agents";
  const status = statusPresentation(setup);

  async function remove(): Promise<void> {
    setRemoving(true);
    setRefused(null);
    const answer = await deleteJson<null>(
      removeMonitoringPath(setup.agent_platform),
      { project: projectId },
    );
    setRemoving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
    } else if (answer.status === "ready" || answer.status === "missing") {
      setConfirmingRemove(false);
      onChanged();
    } else {
      setRefused(answer.refusal);
    }
  }

  async function retry(failureId: string): Promise<void> {
    setRetrying(failureId);
    setRefused(null);
    const answer = await writeJson<{
      readonly failure: { readonly id: string; readonly status: "resolved" };
      readonly trace: {
        readonly id: string;
        readonly write: "written" | "already";
      };
    }>(replayRetellFailurePath(failureId), {
      method: "POST",
      project: projectId,
    });
    setRetrying(null);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status === "ready") {
      onChanged();
      return;
    }
    if (answer.refusal.error === "conflict") onChanged();
    setRefused(answer.refusal);
  }

  return (
    <>
    <div className={styles.status}>
      <div>
        <h3 className={styles.statusTitle}>{label}</h3>
        <div className={styles.statusSummary}>
          <StateMark kind={status.mark} moving={status.moving} />
          <p className={styles.statusText}>{status.text}</p>
        </div>
        {setup.agent_platform === "retell" ? (
          <>
            <p className={styles.detail}>
              {setup.agents.length === 1
                ? setup.agents[0]?.platform_agent_name
                : `${setup.agents.length} voice agents`}
              {setup.credentials_hint === null
                ? ""
                : ` · key ending ${setup.credentials_hint}`}
            </p>
            <ul className={styles.agentProgress}>
              {setup.agents.map((agent) => {
                const progress = agentProgress(agent);
                return (
                  <li key={agent.id}>
                    <span>
                      <strong>{agent.platform_agent_name}</strong>
                      <code>{agent.platform_agent_id}</code>
                    </span>
                    <span className={styles.stateWord}>
                      <StateMark kind={progress.mark} moving={progress.moving} />
                      {progress.text}
                    </span>
                  </li>
                );
              })}
            </ul>
            {setup.agents.flatMap((agent) =>
              agent.failures.map((failure) => (
                <div className={styles.failedImport} key={failure.id}>
                  <span className={styles.stateWord}>
                    <StateMark kind="error" />
                    <span>
                      Retell conversation{" "}
                      <code>{failure.provider_call_id}</code> could not be
                      imported.
                    </span>
                  </span>
                  <Button
                    disabled={!mayConfigure}
                    busy={retrying === failure.id}
                    why={
                      mayConfigure
                        ? undefined
                        : "Your role can read Monitoring and cannot retry an import."
                    }
                    onClick={() => void retry(failure.id)}
                  >
                    {retrying === failure.id ? "Retrying…" : "Retry import"}
                  </Button>
                </div>
              )),
            )}
          </>
        ) : null}
      </div>
      <Button
        disabled={!mayConfigure}
        busy={removing}
        why={
          mayConfigure
            ? undefined
            : "Your role can read Monitoring and cannot change its setup."
        }
        onClick={() => setConfirmingRemove(true)}
      >
        Remove setup
      </Button>
      {refused === null ? null : <Problem>{refused.message}</Problem>}
    </div>
    {confirmingRemove ? (
      <Dialog
        title={`Remove ${label} Monitoring setup?`}
        onClose={() => setConfirmingRemove(false)}
      >
        {(dismiss) => (
          <>
            <p>
              {setup.agent_platform === "retell"
                ? "Egma will stop polling every selected Retell agent. Existing production conversations stay in Monitoring."
                : "Egma will remove this setup status. Existing production conversations stay, and the LiveKit worker keeps exporting until you remove its Egma SDK configuration."}
            </p>
            <Actions>
              <Button onClick={dismiss}>Keep setup</Button>
              <Button
                tone="destructive"
                busy={removing}
                onClick={() => void remove()}
              >
                {removing ? "Removing…" : "Remove setup"}
              </Button>
            </Actions>
          </>
        )}
      </Dialog>
    ) : null}
    </>
  );
}

function RetellSetup({
  projectId,
  setup,
  mayConfigure,
  onDraftState,
  onSaved,
}: {
  readonly projectId: string;
  readonly setup: MonitoringSetup | undefined;
  readonly mayConfigure: boolean;
  readonly onDraftState: (state: RetellDraftState) => void;
  readonly onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [agents, setAgents] = useState<readonly RetellAgentChoice[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [discovering, setDiscovering] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const dirty = apiKey.trim() !== "" || agents !== null;
  const busy = discovering || saving;
  useUnsavedChanges(dirty, busy);
  useEffect(() => {
    onDraftState({ unsaved: dirty, busy });
    return () => onDraftState({ unsaved: false, busy: false });
  }, [busy, dirty, onDraftState]);

  async function discover(): Promise<void> {
    if (apiKey.trim() === "") return;
    setDiscovering(true);
    setRefused(null);
    const answer = await writeJson<RetellAgentChoices>(RETELL_DISCOVERY_PATH, {
      method: "POST",
      project: projectId,
      body: { api_key: apiKey },
    });
    setDiscovering(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
    } else if (answer.status !== "ready") {
      setRefused(answer.refusal);
    } else {
      setAgents(answer.value.agents);
      const existing = new Set(
        setup?.agents.map((agent) => agent.platform_agent_id) ?? [],
      );
      setSelected(
        new Set(
          answer.value.agents
            .filter((agent) => existing.has(agent.id))
            .map((agent) => agent.id),
        ),
      );
    }
  }

  function choose(id: string, checked: boolean): void {
    setSelected((held) => {
      const next = new Set(held);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function save(): Promise<void> {
    if (agents === null || selected.size === 0) return;
    setSaving(true);
    setRefused(null);
    const answer = await writeJson<{ readonly setup: MonitoringSetup }>(
      RETELL_MONITORING_PATH,
      {
        method: "PUT",
        project: projectId,
        body: {
          api_key: apiKey,
          agents: agents.filter((agent) => selected.has(agent.id)),
        },
      },
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
    } else if (answer.status !== "ready") {
      setRefused(answer.refusal);
    } else {
      setApiKey("");
      setAgents(null);
      setSelected(new Set());
      onSaved();
    }
  }

  return (
    <section className={styles.platform} aria-labelledby="retell-setup">
      <h2 id="retell-setup" className={styles.heading}>
        Retell
      </h2>
      <p className={styles.lead}>
        Enter one platform API key. Egma lists the voice agents it can read.
      </p>
      <Form onSubmit={() => void (agents === null ? discover() : save())}>
        <Field
          label="Retell API key"
          htmlFor="retell-api-key"
          hint="The key needs Agent Read and Monitor or History Read permission. Egma stores it sealed and never shows it again."
        >
          <TextInput
            id="retell-api-key"
            secret
            value={apiKey}
            disabled={!mayConfigure || discovering || saving}
            onChange={(value) => {
              setApiKey(value);
              setAgents(null);
              setSelected(new Set());
              setRefused(null);
            }}
          />
        </Field>

        {agents === null ? null : agents.length === 0 ? (
          <Help>This key has no Retell voice agents.</Help>
        ) : (
          <fieldset className={styles.agentList}>
            <legend className={styles.legend}>Voice agents to monitor</legend>
            {agents.map((agent) => {
              const inputId = `retell-agent-${agent.id}`;
              return (
              <div className={styles.agentChoice} key={agent.id}>
                <Checkbox
                  id={inputId}
                  checked={selected.has(agent.id)}
                  disabled={saving}
                  label={agent.name}
                  onChange={(checked) => choose(agent.id, checked)}
                />
                <label htmlFor={inputId}>
                  <strong>{agent.name}</strong>
                  <small>{agent.id}</small>
                </label>
              </div>
              );
            })}
          </fieldset>
        )}

        {agents === null ? null : (
          <Help>
            Egma imports the previous 30 days for each selected agent without
            creating duplicate conversations. It then checks for new
            conversations about every 30 seconds.
          </Help>
        )}
        {refused === null ? null : <Problem>{refused.message}</Problem>}
        <FormActions>
          {agents === null ? (
            <Button
              type="submit"
              weight="strong"
              busy={discovering}
              disabled={!mayConfigure || apiKey.trim() === ""}
              why={
                mayConfigure
                  ? "Enter the Retell API key first."
                  : "Your role can read Monitoring and cannot change its setup."
              }
            >
              {discovering ? "Loading voice agents…" : "Load voice agents"}
            </Button>
          ) : (
            <Button
              type="submit"
              weight="strong"
              busy={saving}
              disabled={!mayConfigure || selected.size === 0}
              why={
                mayConfigure
                  ? "Select at least one voice agent."
                  : "Your role can read Monitoring and cannot change its setup."
              }
            >
              {saving ? "Saving…" : setup === undefined ? "Start monitoring" : "Update setup"}
            </Button>
          )}
          <ButtonLink href={projectPath(projectId, "monitoring", "transcripts")}>
            Cancel
          </ButtonLink>
        </FormActions>
      </Form>
    </section>
  );
}

function LiveKitSetup({
  projectId,
  configured,
  mayConfigure,
  onSaved,
}: {
  readonly projectId: string;
  readonly configured: boolean;
  readonly mayConfigure: boolean;
  readonly onSaved: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    if (endpoint === null) setEndpoint(window.location.origin);
  }, [endpoint]);

  async function save(): Promise<void> {
    setSaving(true);
    setRefused(null);
    const answer = await writeJson<{ readonly setup: MonitoringSetup }>(
      LIVEKIT_MONITORING_PATH,
      { method: "PUT", project: projectId },
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
    } else if (answer.status !== "ready") {
      setRefused(answer.refusal);
    } else {
      onSaved();
    }
  }

  return (
    <section className={styles.platform} aria-labelledby="livekit-setup">
      <h2 id="livekit-setup" className={styles.heading}>
        LiveKit Agents
      </h2>
      <p className={styles.lead}>
        Add the Egma Python SDK to the LiveKit agent process. The same setup
        works for a customer-hosted worker and a LiveKit Cloud-hosted Python
        agent.
      </p>
      <div className={styles.codeSteps}>
        <p>1. Install the SDK in the agent image.</p>
        <pre>pip install egma</pre>
        <p>2. Add the project key and this Egma address to the worker secrets.</p>
        <pre>{`EGMA_URL=${endpoint ?? "https://your-egma.example"}\nEGMA_API_KEY=egma_sk_…`}</pre>
        <p>
          3. Call the helper before <code>AgentSession.start</code>.
        </p>
        <pre>{`from egma import monitor_livekit\n\nmonitor_livekit(ctx)`}</pre>
      </div>
      <p className={styles.lead}>
        Use an existing project key. LiveKit Cloud agents receive their LiveKit
        values from Cloud; add the two Egma values as deployment secrets.
      </p>
      <FormActions>
        <Button
          weight="strong"
          busy={saving}
          disabled={!mayConfigure}
          why={
            mayConfigure
              ? undefined
              : "Your role can read Monitoring and cannot change its setup."
          }
          onClick={() => void save()}
        >
          {saving
            ? "Saving…"
            : configured
              ? "Keep waiting for a conversation"
              : "I added this setup"}
        </Button>
        <ButtonLink href={settingsPath(projectId, "keys")}>
          Open project keys
        </ButtonLink>
      </FormActions>
      {refused === null ? null : <Problem>{refused.message}</Problem>}
    </section>
  );
}
