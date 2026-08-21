"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  addConnection,
  discoverAgents,
  getAgent,
  listConnectionOptions,
} from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { Refusal } from "../../../../../../../lib/api.ts";
import type { AgentDetail } from "../../../../../../../lib/agents.ts";
import {
  agentPlatformChoices,
  agentsForOption,
  candidatesForOption,
  optionNamed,
  optionsForPlatform,
  type ConnectionCandidate,
  type ConnectionOptionCatalog,
  type DiscoveredAgent,
} from "../../../../../../../lib/connection-options.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
import { platformAnswer, platformClient } from "../../../../../../../lib/platform-client.ts";
import { projectPath } from "../../../../../../../lib/project-context.ts";
import { canAuthor } from "../../../../../../../lib/roles.ts";
import {
  Field,
  Form,
  FormActions,
  Help,
  Problem,
} from "../../../../../../../ui/form.tsx";
import { Empty, Failure, Loading, NotFound } from "../../../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../../../ui/resource.ts";
import { useUnsavedChanges } from "../../../../../../../ui/settings-read.ts";
import {
  AppShell,
  PageBody,
  PageHeader,
  ProductPage,
  useShellSession,
} from "../../../../../../../ui/shell.tsx";
import { AgentOnboardingProgress } from "../../../onboarding-progress.tsx";
import { ConnectionFields, type Draft } from "../fields.tsx";
import {
  configForLiveKitDispatch,
  liveKitDispatchForm,
  LiveKitDispatchSetup,
  newLiveKitDispatch,
  type LiveKitDispatch,
} from "../livekit-dispatch.tsx";

/** Provider setup first, then only the fields that provider actually needs. */
export default function NewConnectionPage() {
  const { projectId, agentId } = useParams<{
    projectId: string;
    agentId: string;
  }>();
  return (
    <AppShell>
      <NewConnection projectId={projectId} agentId={agentId} />
    </AppShell>
  );
}

function NewConnection({
  projectId,
  agentId,
}: {
  readonly projectId: string;
  readonly agentId: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const onboarding = searchParams.get("onboarding") === "connection";
  const { me } = useShellSession();
  const role = me === null ? null : roleOf(me);
  const [catalog, setCatalog] = useState<ConnectionOptionCatalog | null>(null);
  const [catalogRefused, setCatalogRefused] = useState<Refusal | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [platformValue, setPlatformValue] = useState("");
  const [accessVariant, setAccessVariant] = useState("");
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<Draft>({ config: {}, credentials: {} });
  const [livekitDispatch, setLivekitDispatch] =
    useState<LiveKitDispatch>(newLiveKitDispatch);

  const [discoveryKey, setDiscoveryKey] = useState("");
  const [discoveredAgents, setDiscoveredAgents] = useState<
    readonly DiscoveredAgent[] | null
  >(null);
  const [discoveredAgentId, setDiscoveredAgentId] = useState("");
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [discovering, setDiscovering] = useState(false);
  const [discoverRefused, setDiscoverRefused] = useState<Refusal | null>(null);

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const back = projectPath(projectId, "agents", agentId);
  const { answer: parentAgent } = useProjectRead<AgentDetail>(
    (projectId) =>
      platformAnswer(
        getAgent({ agentId, projectId }, { client: platformClient }),
      ),
    projectId,
    agentId,
  );

  useEffect(() => {
    let current = true;
    setCatalog(null);
    setCatalogRefused(null);
    void platformAnswer(
      listConnectionOptions({ client: platformClient }),
    ).then((read) => {
      if (!current) return;
      if (read.status === "signed-out") {
        window.location.replace("/sign-in");
      } else if (read.status === "ready") {
        setCatalog(read.value);
        const first = read.value.items[0];
        if (first !== undefined) {
          setPlatformValue(first.agentPlatform ?? "unknown");
          setAccessVariant(first.accessVariant);
        }
      } else {
        setCatalogRefused(read.refusal);
      }
    });
    return () => {
      current = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (parentAgent?.status === "signed-out") {
      window.location.replace("/sign-in");
    }
  }, [parentAgent]);

  const selectedPlatform = platformValue === "unknown" ? null : platformValue;
  const platformOptions = optionsForPlatform(catalog, selectedPlatform);
  const option = platformOptions.find(
    (one) => one.accessVariant === accessVariant,
  );
  // Retell is the first platform served by account discovery. The operation and
  // its candidates are platform-neutral, so adding another provider does not
  // create another connection write path.
  const usesAgentDiscovery = option?.agentPlatform === "retell";
  const matchingAgents = agentsForOption(discoveredAgents, option);
  const chosenDiscoveredAgent = matchingAgents.find(
    (agent) => agent.platformAgentId === discoveredAgentId,
  );
  const matchingCandidates =
    chosenDiscoveredAgent === undefined
      ? []
      : candidatesForOption(chosenDiscoveredAgent, option);
  const chosenCandidate = matchingCandidates[candidateIndex];
  const chosenCandidateOption =
    chosenCandidate === undefined
      ? undefined
      : optionNamed(catalog, chosenCandidate);
  const liveKitForm = liveKitDispatchForm({
    connectionKind: option?.connectionKind,
    option,
    config: draft.config,
    mode: livekitDispatch,
  });
  const changed =
    name !== "" ||
    livekitDispatch !== newLiveKitDispatch() ||
    discoveryKey !== "" ||
    discoveredAgents !== null ||
    Object.values(draft.config).some((value) => value !== "") ||
    Object.values(draft.credentials).some((value) => value !== "");
  useUnsavedChanges(changed && !saving && !discovering, saving || discovering);

  const mayAuthor = role !== null && canAuthor(role);

  function choosePlatform(next: string): void {
    const platform = next === "unknown" ? null : next;
    const chosen = optionsForPlatform(catalog, platform)[0];
    setPlatformValue(next);
    setAccessVariant(chosen?.accessVariant ?? "");
    setDraft({ config: {}, credentials: {} });
    setLivekitDispatch(newLiveKitDispatch());
    setDiscoveryKey("");
    setDiscoveredAgents(null);
    setDiscoveredAgentId("");
    setCandidateIndex(0);
    setDiscoverRefused(null);
    setRefused(null);
  }

  function chooseOption(next: string): void {
    const chosen = platformOptions.find(
      (candidate) => candidate.accessVariant === next,
    );
    setAccessVariant(next);
    setDraft({ config: {}, credentials: {} });
    setLivekitDispatch(newLiveKitDispatch());
    chooseFirstDiscoveredCandidate(discoveredAgents ?? [], chosen);
    setDiscoverRefused(null);
    setRefused(null);
  }

  function chooseLiveKitDispatch(next: LiveKitDispatch): void {
    setLivekitDispatch(next);
    setDraft((current) => ({
      ...current,
      config: configForLiveKitDispatch(current.config, next),
    }));
  }

  function chooseFirstDiscoveredCandidate(
    agents: readonly DiscoveredAgent[],
    selectedOption = option,
  ): void {
    const first = agents.find(
      (agent) => candidatesForOption(agent, selectedOption).length > 0,
    );
    setDiscoveredAgentId(first?.platformAgentId ?? "");
    setCandidateIndex(0);
  }

  function chooseDiscoveredAgent(next: string): void {
    setDiscoveredAgentId(next);
    setCandidateIndex(0);
  }

  async function findAgents(): Promise<void> {
    if (
      discovering ||
      discoveryKey.trim() === "" ||
      option?.agentPlatform !== "retell"
    ) {
      return;
    }
    setDiscoverRefused(null);
    setDiscoveredAgents(null);
    setDiscoveredAgentId("");
    setCandidateIndex(0);
    setDiscovering(true);
    const answer = await platformAnswer(
      discoverAgents(
        {
          projectId,
          agentPlatform: option.agentPlatform,
          credentials: { apiKey: discoveryKey },
        },
        { client: platformClient },
      ),
    );
    setDiscovering(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setDiscoverRefused(answer.refusal);
      return;
    }
    // Discovery never returns a credential. Keep the key in this password
    // field until the selected candidate is confirmed for the generic write.
    setDiscoveredAgents(answer.value.agents);
    chooseFirstDiscoveredCandidate(answer.value.agents);
  }

  async function add(): Promise<void> {
    if (!mayAuthor || saving || option === undefined) {
      return;
    }

    if (usesAgentDiscovery) {
      if (
        chosenCandidate === undefined ||
        chosenCandidateOption === undefined ||
        discoveryKey.trim() === ""
      ) {
        setRefused({
          error: "unprocessable",
          message: "Load the Retell account, then select an available connection.",
        });
        return;
      }
    }

    const connectionParameters = (() => {
      const common = {
        agentId,
        projectId,
        ...(name.trim() === "" ? {} : { name: name.trim() }),
      };
      if (
        usesAgentDiscovery &&
        chosenCandidate !== undefined &&
        chosenCandidateOption !== undefined
      ) {
        return {
          ...common,
          agentPlatform: chosenCandidate.agentPlatform,
          connectionKind: chosenCandidate.connectionKind,
          accessVariant: chosenCandidate.accessVariant,
          modality: chosenCandidate.modality,
          config: chosenCandidate.config,
          // The server revalidates this one-time selection immediately before
          // the generic write. It discards the selection itself and retains the
          // key only when the chosen access variant needs it for simulation.
          agentPlatformSelection: {
            platformAgentId: discoveredAgentId,
            credentials: { apiKey: discoveryKey },
          },
        };
      }

      const config: Record<string, string> = {};
      for (const field of option.fields) {
        const written = draft.config[field.key]?.trim() ?? "";
        if (written !== "") config[field.key] = written;
      }
      const credentials: Record<string, string> = {};
      for (const field of option.credentialFields) {
        const written = draft.credentials[field.field]?.trim() ?? "";
        if (written !== "") credentials[field.field] = written;
      }
      return {
        ...common,
        agentPlatform: option.agentPlatform,
        connectionKind: option.connectionKind,
        accessVariant: option.accessVariant,
        modality: option.modality,
        config,
        ...(option.credentialRule === "forbidden" ||
        Object.keys(credentials).length === 0
          ? {}
          : { credentials }),
      };
    })();

    setRefused(null);
    setSaving(true);
    const answer = await platformAnswer(
      addConnection(connectionParameters, { client: platformClient }),
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
    } else if (answer.status !== "ready") {
      setRefused(answer.refusal);
    } else {
      if (usesAgentDiscovery) setDiscoveryKey("");
      router.push(
        onboarding
          ? projectPath(projectId, "agents", agentId, "onboarding")
          : projectPath(
              projectId,
              "agents",
              agentId,
              "connections",
              answer.value.connection.id,
            ),
      );
    }
  }

  const header = (
    <PageHeader
      eyebrow={onboarding ? "Agent setup" : "Connection"}
      title={onboarding ? "Connect the agent" : "Add a connection"}
      breadcrumbs={[
        { label: "Agents", href: projectPath(projectId, "agents") },
        {
          label:
            parentAgent?.status === "ready"
              ? parentAgent.value.agent.name
              : "Agent",
          href: back,
        },
        { label: "New connection" },
      ]}
      lead={
        onboarding
          ? "Choose how Egma reaches this agent. You can add another connection later."
          : "Choose the platform that hosts this agent. Egma then asks only for that platform's setup."
      }
    />
  );

  if (parentAgent === null || parentAgent.status === "signed-out") {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Loading what="this agent" />
        </PageBody>
      </ProductPage>
    );
  }
  if (role !== null && !mayAuthor) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <NotFound
            message={`Your ${role} role cannot add connections. Ask an organization admin to change your role, then try again.`}
          />
        </PageBody>
      </ProductPage>
    );
  }
  if (catalogRefused !== null) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Failure
            title="Egma could not describe the connection options."
            message={catalogRefused.message}
            onRetry={() => setAttempt((current) => current + 1)}
          />
        </PageBody>
      </ProductPage>
    );
  }
  if (
    catalog === null ||
    option === undefined ||
    liveKitForm.option === undefined
  ) {
    return (
      <ProductPage>
        {header}
        <PageBody>
          <Loading what="the connection options" />
        </PageBody>
      </ProductPage>
    );
  }

  const discoveryReady =
    !usesAgentDiscovery ||
    (chosenCandidate !== undefined &&
      chosenCandidateOption !== undefined &&
      discoveryKey.trim() !== "");
  const canSubmit = discoveryReady && liveKitForm.ready;
  const submitWhy = !discoveryReady
    ? "Load the Retell account, then select an available connection."
    : !liveKitForm.ready
      ? "Enter the exact LiveKit agent name, or choose automatic dispatch."
      : undefined;

  return (
    <ProductPage>
      {header}
      <PageBody>
        {onboarding ? <AgentOnboardingProgress current="connection" /> : null}
        <Form onSubmit={() => void add()}>
          <Field label="Platform" htmlFor="agent-platform">
            <Select
              id="agent-platform"
              value={platformValue}
              disabled={discovering}
              onChange={(event) => choosePlatform(event.target.value)}
            >
              {agentPlatformChoices(catalog).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>

          {platformOptions.length > 1 ? (
            <Field label="Access" htmlFor="access-variant">
              <Select
                id="access-variant"
                value={option.accessVariant}
                disabled={discovering}
                onChange={(event) => chooseOption(event.target.value)}
              >
                {platformOptions.map((item) => (
                  <option key={item.accessVariant} value={item.accessVariant}>
                    {item.accessVariantLabel}
                  </option>
                ))}
              </Select>
              <Help>
                {option.modality === "voice" ? "Voice" : "Chat"} connection
              </Help>
            </Field>
          ) : null}

          <Field label="Connection name (optional)" htmlFor="connection-name">
            <Input
              id="connection-name"
              value={name}
              placeholder="A name for this connection"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setName(event.target.value)}
            />
            <Help>The label shown for this connection in Egma.</Help>
          </Field>

          {usesAgentDiscovery ? (
            <AgentDiscoverySetup
              apiKey={discoveryKey}
              loaded={discoveredAgents !== null}
              agents={matchingAgents}
              selectedAgent={discoveredAgentId}
              candidates={matchingCandidates}
              selectedCandidate={candidateIndex}
              discovering={discovering}
              refusal={discoverRefused}
              onKeyChange={(value) => {
                setDiscoveryKey(value);
                setDiscoveredAgents(null);
                setDiscoveredAgentId("");
                setCandidateIndex(0);
                setDiscoverRefused(null);
              }}
              onDiscover={() => void findAgents()}
              onAgentChange={chooseDiscoveredAgent}
              onCandidateChange={setCandidateIndex}
            />
          ) : (
            <>
              <ConnectionFields
                option={liveKitForm.option}
                draft={draft}
                onChange={setDraft}
                credentialsEditable
                beforeCredentialFields={
                  !liveKitForm.enabled ? undefined : (
                    <LiveKitDispatchSetup
                      mode={liveKitForm.mode}
                      agentName={liveKitForm.agentName}
                      onModeChange={chooseLiveKitDispatch}
                      onAgentNameChange={(agentName) =>
                        setDraft((current) => ({
                          ...current,
                          config: { ...current.config, agentName },
                        }))
                      }
                    />
                  )
                }
              />
            </>
          )}

          {refused === null ? null : <Problem>{refused.message}</Problem>}
          <FormActions>
            <Button type="submit" disabled={saving || !canSubmit} why={submitWhy}>
              {saving ? "Adding…" : "Add connection"}
            </Button>
            <Button asChild variant="secondary">
              <Link
                href={
                  onboarding
                    ? projectPath(projectId, "agents", agentId, "onboarding")
                    : back
                }
              >
                {onboarding ? "Skip connection for now" : "Cancel"}
              </Link>
            </Button>
          </FormActions>
          {onboarding ? (
            <Help>
              Without a connection, Egma cannot run a simulation against this
              agent. You can add one later from Configuration.
            </Help>
          ) : null}
        </Form>
      </PageBody>
    </ProductPage>
  );
}

function AgentDiscoverySetup({
  apiKey,
  loaded,
  agents,
  selectedAgent,
  candidates,
  selectedCandidate,
  discovering,
  refusal,
  onKeyChange,
  onDiscover,
  onAgentChange,
  onCandidateChange,
}: {
  readonly apiKey: string;
  readonly loaded: boolean;
  readonly agents: readonly DiscoveredAgent[];
  readonly selectedAgent: string;
  readonly candidates: readonly ConnectionCandidate[];
  readonly selectedCandidate: number;
  readonly discovering: boolean;
  readonly refusal: Refusal | null;
  readonly onKeyChange: (value: string) => void;
  readonly onDiscover: () => void;
  readonly onAgentChange: (value: string) => void;
  readonly onCandidateChange: (value: number) => void;
}) {
  return (
    <>
      <Field label="Retell API key" htmlFor="retell-api-key">
        <Input
          id="retell-api-key"
          value={apiKey}
          type="password"
          autoComplete="off"
          spellCheck={false}
          disabled={discovering}
          onChange={(event) => onKeyChange(event.target.value)}
        />
        <Help>
          Egma uses this key to load your Retell agents and their available
          connections. Egma stores it only when the selected access method
          needs it.
        </Help>
      </Field>
      <Button
        type="button"
        variant="secondary"
        disabled={apiKey.trim() === ""}
        busy={discovering}
        onClick={onDiscover}
      >
        {discovering ? "Loading agents…" : "Load Retell agents"}
      </Button>
      {refusal === null ? null : <Problem>{refusal.message}</Problem>}

      {!loaded ? null : agents.length === 0 ? (
        <Empty
          title="No Retell agents support this access"
          lead="Select another access method, or use a key for the account that holds the agent you want to test."
        />
      ) : (
        <>
          <Field label="Retell agent" htmlFor="retell-agent">
            <Select
              id="retell-agent"
              value={selectedAgent}
              onChange={(event) => onAgentChange(event.target.value)}
            >
              {agents.map((item) => (
                <option key={item.platformAgentId} value={item.platformAgentId}>
                  {item.name === "" ? item.platformAgentId : item.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Connection" htmlFor="discovered-connection">
            <Select
              id="discovered-connection"
              value={String(selectedCandidate)}
              onChange={(event) =>
                onCandidateChange(Number.parseInt(event.target.value, 10))
              }
            >
              {candidates.map((candidate, index) => (
                <option
                  key={`${candidate.accessVariant}:${index}`}
                  value={String(index)}
                >
                  {candidateLabel(candidate)}
                </option>
              ))}
            </Select>
          </Field>
        </>
      )}
    </>
  );
}

function candidateLabel(candidate: ConnectionCandidate): string {
  const phoneNumber = candidate.config.phoneNumber;
  return phoneNumber === undefined
    ? candidate.productLabel
    : `${candidate.productLabel} · ${phoneNumber}`;
}
