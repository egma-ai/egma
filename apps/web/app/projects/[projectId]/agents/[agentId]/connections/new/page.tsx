"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { readJson, writeJson, type Refusal } from "../../../../../../../lib/api.ts";
import {
  agentDetailQuery,
  connectionsPath,
  type AgentDetail,
  type ListedConnection,
} from "../../../../../../../lib/agents.ts";
import {
  agentPlatformChoices,
  CONNECTION_OPTIONS_PATH,
  optionsForPlatform,
  RETELL_VOICE_AGENTS_PATH,
  retellPhoneConnectionPath,
  type ConnectionOptionCatalog,
  type RetellVoiceAgent,
  type RetellVoiceAgents,
} from "../../../../../../../lib/connection-options.ts";
import { roleOf } from "../../../../../../../lib/me.ts";
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

  const [retellKey, setRetellKey] = useState("");
  const [retellAgents, setRetellAgents] = useState<readonly RetellVoiceAgent[] | null>(
    null,
  );
  const [retellAgentId, setRetellAgentId] = useState("");
  const [retellNumber, setRetellNumber] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverRefused, setDiscoverRefused] = useState<Refusal | null>(null);

  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const back = projectPath(projectId, "agents", agentId);
  const { answer: parentAgent } = useProjectRead<AgentDetail>(
    agentDetailQuery(agentId, "active"),
    projectId,
  );

  useEffect(() => {
    let current = true;
    setCatalog(null);
    setCatalogRefused(null);
    void readJson<ConnectionOptionCatalog>(CONNECTION_OPTIONS_PATH).then((read) => {
      if (!current) return;
      if (read.status === "signed-out") {
        window.location.replace("/sign-in");
      } else if (read.status === "ready") {
        setCatalog(read.value);
        const first = read.value.items[0];
        if (first !== undefined) {
          setPlatformValue(first.agent_platform ?? "unknown");
          setAccessVariant(first.access_variant);
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
    (one) => one.access_variant === accessVariant,
  );
  const retellPhone =
    option?.agent_platform === "retell" &&
    option.connection_kind === "phone_number";
  const chosenRetell = retellAgents?.find((one) => one.id === retellAgentId);
  const liveKitForm = liveKitDispatchForm({
    connectionKind: option?.connection_kind,
    option,
    config: draft.config,
    mode: livekitDispatch,
  });
  const changed =
    name !== "" ||
    livekitDispatch !== newLiveKitDispatch() ||
    retellKey !== "" ||
    retellAgents !== null ||
    Object.values(draft.config).some((value) => value !== "") ||
    Object.values(draft.credentials).some((value) => value !== "");
  useUnsavedChanges(changed && !saving && !discovering, saving || discovering);

  const mayAuthor = role !== null && canAuthor(role);

  function choosePlatform(next: string): void {
    const platform = next === "unknown" ? null : next;
    const chosen = optionsForPlatform(catalog, platform)[0];
    setPlatformValue(next);
    setAccessVariant(chosen?.access_variant ?? "");
    setDraft({ config: {}, credentials: {} });
    setLivekitDispatch(newLiveKitDispatch());
    setRetellKey("");
    setRetellAgents(null);
    setRetellAgentId("");
    setRetellNumber("");
    setDiscoverRefused(null);
    setRefused(null);
  }

  function chooseOption(next: string): void {
    setAccessVariant(next);
    setDraft({ config: {}, credentials: {} });
    setLivekitDispatch(newLiveKitDispatch());
  }

  function chooseLiveKitDispatch(next: LiveKitDispatch): void {
    setLivekitDispatch(next);
    setDraft((current) => ({
      ...current,
      config: configForLiveKitDispatch(current.config, next),
    }));
  }

  function chooseRetellAgent(next: string, agents = retellAgents): void {
    setRetellAgentId(next);
    const agent = agents?.find((one) => one.id === next);
    setRetellNumber(agent?.numbers[0]?.number ?? "");
  }

  async function findRetellAgents(): Promise<void> {
    if (discovering || retellKey.trim() === "") return;
    setDiscoverRefused(null);
    setDiscovering(true);
    const answer = await writeJson<RetellVoiceAgents>(RETELL_VOICE_AGENTS_PATH, {
      method: "POST",
      project: projectId,
      body: { api_key: retellKey },
    });
    setDiscovering(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setDiscoverRefused(answer.refusal);
      return;
    }
    // Keep the key only in this password field until the selected route is
    // confirmed immediately before the provider-blind phone write.
    setRetellAgents(answer.value.agents);
    const first =
      answer.value.agents.find((agent) => agent.numbers.length > 0) ??
      answer.value.agents[0];
    chooseRetellAgent(first?.id ?? "", answer.value.agents);
  }

  async function add(): Promise<void> {
    if (!mayAuthor || saving || option === undefined) {
      return;
    }

    let body: Record<string, unknown>;
    let path = connectionsPath(agentId);
    if (retellPhone) {
      if (
        chosenRetell === undefined ||
        retellNumber === "" ||
        retellKey.trim() === ""
      ) {
        setRefused({
          error: "unprocessable",
          message: "Select a Retell voice agent and one of its routed phone numbers.",
        });
        return;
      }
      body = {
        ...(name.trim() === "" ? {} : { name: name.trim() }),
        api_key: retellKey,
        retell_agent_id: chosenRetell.id,
        phone_number: retellNumber,
      };
      path = retellPhoneConnectionPath(agentId);
    } else {
      const config: Record<string, string> = {};
      for (const field of option.fields) {
        const written = draft.config[field.key]?.trim() ?? "";
        if (written !== "") config[field.key] = written;
      }
      const credentials: Record<string, string> = {};
      for (const field of option.credential_fields) {
        const written = draft.credentials[field.field]?.trim() ?? "";
        if (written !== "") credentials[field.field] = written;
      }
      body = {
        ...(name.trim() === "" ? {} : { name: name.trim() }),
        agent_platform: option.agent_platform,
        connection_kind: option.connection_kind,
        access_variant: option.access_variant,
        modality: option.modality,
        config,
        ...(option.credential_rule === "forbidden" ||
        Object.keys(credentials).length === 0
          ? {}
          : { credentials }),
      };
    }

    setRefused(null);
    setSaving(true);
    const answer = await writeJson<{ readonly connection: ListedConnection }>(
      path,
      {
        method: "POST",
        project: projectId,
        body,
      },
    );
    setSaving(false);
    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
    } else if (answer.status !== "ready") {
      setRefused(answer.refusal);
    } else {
      if (retellPhone) setRetellKey("");
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

  const retellReady =
    !retellPhone ||
    (chosenRetell !== undefined &&
      retellNumber !== "" &&
      retellKey.trim() !== "");
  const canSubmit = retellReady && liveKitForm.ready;
  const submitWhy = !retellReady
    ? "Load the Retell account, then select a voice agent and phone number."
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
                value={option.access_variant}
                onChange={(event) => chooseOption(event.target.value)}
              >
                {platformOptions.map((item) => (
                  <option key={item.access_variant} value={item.access_variant}>
                    {item.access_variant_label}
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

          {retellPhone ? (
            <RetellSetup
              apiKey={retellKey}
              agents={retellAgents}
              selectedAgent={retellAgentId}
              selectedNumber={retellNumber}
              discovering={discovering}
              refusal={discoverRefused}
              onKeyChange={(value) => {
                setRetellKey(value);
                setRetellAgents(null);
                setRetellAgentId("");
                setRetellNumber("");
                setDiscoverRefused(null);
              }}
              onDiscover={() => void findRetellAgents()}
              onAgentChange={chooseRetellAgent}
              onNumberChange={setRetellNumber}
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

function RetellSetup({
  apiKey,
  agents,
  selectedAgent,
  selectedNumber,
  discovering,
  refusal,
  onKeyChange,
  onDiscover,
  onAgentChange,
  onNumberChange,
}: {
  readonly apiKey: string;
  readonly agents: readonly RetellVoiceAgent[] | null;
  readonly selectedAgent: string;
  readonly selectedNumber: string;
  readonly discovering: boolean;
  readonly refusal: Refusal | null;
  readonly onKeyChange: (value: string) => void;
  readonly onDiscover: () => void;
  readonly onAgentChange: (value: string) => void;
  readonly onNumberChange: (value: string) => void;
}) {
  const agent = agents?.find((item) => item.id === selectedAgent);
  return (
    <>
      <Field label="Retell API key" htmlFor="retell-api-key">
        <Input
          id="retell-api-key"
          value={apiKey}
          type="password"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onKeyChange(event.target.value)}
        />
        <Help>
          Egma uses this key to load your Retell voice agents and their routed
          phone numbers. It is not stored on the connection.
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

      {agents === null ? null : agents.length === 0 ? (
        <Empty
          title="No Retell voice agents found"
          lead="Use a key for the account that holds the voice agent you want to test."
        />
      ) : (
        <>
          <Field label="Retell voice agent" htmlFor="retell-agent">
            <Select
              id="retell-agent"
              value={selectedAgent}
              onChange={(event) => onAgentChange(event.target.value)}
            >
              {agents.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name === "" ? item.id : item.name}
                </option>
              ))}
            </Select>
          </Field>
          {agent === undefined || agent.numbers.length === 0 ? (
            <Problem>
              Retell routes no phone number to this agent. Assign a number in
              Retell, or select another voice agent.
            </Problem>
          ) : (
            <Field label="Phone number" htmlFor="retell-number">
              <Select
                id="retell-number"
                value={selectedNumber}
                onChange={(event) => onNumberChange(event.target.value)}
              >
                {agent.numbers.map((number) => (
                  <option key={number.number} value={number.number}>
                    {number.label === ""
                      ? number.number
                      : `${number.label} · ${number.number}`}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </>
      )}
    </>
  );
}
