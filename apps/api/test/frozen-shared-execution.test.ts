import { newId } from "@egma/ids";
import { traceIdOfSimulation } from "@egma/simulation-contract";
import {
  appendSpans,
  claimGradingJobs,
  completeSimulation,
  createProject,
  finishGradingJob,
  getGradingJob,
  getGradingPlan,
  getSimulation,
  GRADER_DEFINITION_CATALOG,
  PERSONA_LIBRARY_CATALOG,
  PREDEFINED_GRADERS,
  readTraceGrades,
  reconcileGraderCatalog,
  releaseGradingJob,
  seedPersonaLibrary,
  startSimulation,
  type AuthContext,
  type NewSpan,
} from "@egma/db";
import { afterEach, expect, it } from "vitest";

import { gradeClaim } from "../../grader/src/grade.ts";
import { scriptedJudge, met } from "../../grader/test/support/scripted-judge.ts";
import { CLAIMS_PATH } from "../src/routes/claims.ts";
import { createApi, type TestApi } from "./support/api.ts";
import { contextFor, signUp } from "./support/traces.ts";

let api: TestApi;
afterEach(async () => { await api?.close(); });

it("freezes shared grader and persona selections together while later work receives one compatible release", async () => {
  api = await createApi("frozen_shared_execution", { traceStore: true });
  const who = await signUp(api.app, "frozen-shared@example.test", "Frozen shared execution");
  const firstAuth = contextFor(who, "admin");
  const second = await createProject(firstAuth, { name: "Other choices" });
  const headers = { cookie: who.cookie };
  const persona = PERSONA_LIBRARY_CATALOG[0]!;
  const originalPersona = persona.versions.at(-1)!;
  const grader = GRADER_DEFINITION_CATALOG.find((one) => one.id === PREDEFINED_GRADERS.expectedBehaviors)!;
  const sourcePrompt = grader.prompt!;
  const clonePrompt = "Judge whether the agent was polite.";

  async function request(projectId: string, method: "GET" | "POST" | "PATCH", url: string, payload?: object) {
    const response = await api.app.inject({ method, url: `${url}?projectId=${projectId}`, headers, ...(payload === undefined ? {} : { payload }) });
    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200);
    expect(response.statusCode, response.body).toBeLessThan(300);
    return response.json();
  }
  const projects = [
    { projectId: who.projectId, model: "gpt-4o-mini", speed: 0.85, voice: "first-project-voice" },
    { projectId: second.id, model: "gpt-5.6-terra", speed: 1.2, voice: "second-project-voice" },
  ];
  const prepared = [];
  for (const [index, project] of projects.entries()) {
    const { projectId, model, speed, voice } = project;
    const listed = await request(projectId, "GET", "/v1/graders");
    const projectGraderId = listed.graders.find((one: { graderDefinitionId: string }) => one.graderDefinitionId === grader.id).id as string;
    await request(projectId, "PATCH", `/v1/graders/${projectGraderId}`, { settings: { llm_provider: "openai", llm_model: model }, passThreshold: index === 0 ? 0.7 : 0.9 });
    const used = await request(projectId, "POST", `/v1/personas/${persona.id}/use`, { projectId, models: {
      llm: { provider: "openai", model },
      stt: { provider: "deepgram", model: "nova-3-general" },
      tts: { provider: "openai", model: "tts-1", voiceId: voice, speed },
    } });
    const suite = await request(projectId, "POST", "/v1/test-suites", { name: "Shared release" });
    const test = await request(projectId, "POST", "/v1/tests", {
      suiteId: suite.id, name: "Gets an answer", scenario: "Ask for help", expectedBehaviors: ["The agent helps."], personas: [persona.id],
    });
    const registered = await request(projectId, "POST", "/v1/agents", {
      agentPlatform: "livekit", name: "Support", connection: {
        agentPlatform: "livekit", connectionType: "livekit_room", accessVariant: "livekit_room.project_credentials", modality: "voice",
        config: { url: "wss://example.livekit.cloud", agentName: "support" },
        credentials: { apiKey: "livekit-key-A1B2C3D4WXYZ", apiSecret: "livekit-secret-E5F6G7H8QRST" },
      },
    });
    prepared.push({ ...project, projectGraderId, personaSettingsId: used.settings.id as string, suiteId: suite.id as string,
      testId: test.id as string, testVersionId: test.versionId as string, agentId: registered.agent.id as string, connectionId: registered.connection.id as string });
  }
  const first = prepared[0]!;
  const secondProject = prepared[1]!;
  const graderClone = await request(first.projectId, "POST", `/v1/grader-library/${grader.id}/clone`, { name: "Independent clone" });
  expect(graderClone.grader.settings).toEqual({ llm_provider: "openai", llm_model: first.model });
  await request(first.projectId, "PATCH", `/v1/grader-library/${graderClone.definition.id}`, { baseDefinitionVersion: 1, gradingInstructions: clonePrompt });
  const personaClone = await request(first.projectId, "POST", `/v1/personas/${persona.id}/fork`, { projectId: first.projectId });

  async function launch(project: typeof first) {
    const run = await request(project.projectId, "POST", "/v1/runs", {
      suiteId: project.suiteId, agentId: project.agentId, connectionId: project.connectionId,
      expectedTestVersions: [{ testId: project.testId, versionId: project.testVersionId }],
    });
    const page = await request(project.projectId, "GET", `/v1/runs/${run.id}/simulations`);
    return { runId: run.id as string, simulationId: page.simulations[0].id as string };
  }
  const oldRuns = [await launch(first), await launch(secondProject)];
  const oldPlan = await getGradingPlan(firstAuth, oldRuns[0]!.runId);
  expect(oldPlan).not.toHaveProperty("state");
  expect(oldPlan?.groups[0]?.items).toEqual(expect.arrayContaining([expect.objectContaining({
    graderDefinitionId: grader.id, graderDefinitionVersion: 1,
    parameterValues: { llm_provider: "openai", llm_model: first.model },
    definition: { definitionId: grader.id, definitionVersion: 1, type: "llm_as_judge", prompt: sourcePrompt, parameterContract: grader.parameterContract, modalities: ["chat", "voice"] },
  })]));

  const updatedGrader = { ...grader, prompt: `${sourcePrompt}\nUse precise evidence.`, parameterContract: grader.parameterContract.map((field) => field.key === "llm_model" ? { ...field, defaultValue: "gpt-4o-mini" } : field) };
  const updatedPersona = { ...persona, versions: [...persona.versions, {
    ...originalPersona, id: newId("prsv"), version: originalPersona.version + 1, personality: "Ask one clear question, then wait.",
    parameterContract: originalPersona.parameterContract.map((field) => field.key === "tts_speed" ? { ...field, defaultValue: 1.4 } : field),
  }] };
  const releasedPersona = updatedPersona.versions.at(-1)!;
  const graderPublications = await Promise.all([reconcileGraderCatalog([updatedGrader]), reconcileGraderCatalog([updatedGrader])]);
  expect(graderPublications.flatMap((one) => one.definitions)).toEqual([{ id: grader.id, name: grader.name, version: 2 }]);
  const personaPublications = await Promise.all([seedPersonaLibrary([updatedPersona]), seedPersonaLibrary([updatedPersona])]);
  expect(personaPublications.flat()).toEqual([{ id: persona.id, name: persona.name, version: 3, versionId: releasedPersona.id }]);

  for (const project of prepared) {
    const current = await request(project.projectId, "GET", `/v1/personas/${persona.id}`);
    expect(current).toMatchObject({ version: 3, settings: { id: project.personaSettingsId, models: { llm: { model: project.model }, tts: { speed: project.speed, voiceId: project.voice } } } });
    const policy = await request(project.projectId, "GET", "/v1/graders");
    expect(policy.graders).toEqual(expect.arrayContaining([expect.objectContaining({ id: project.projectGraderId, settings: { llm_provider: "openai", llm_model: project.model } })]));
  }
  expect(await request(first.projectId, "GET", `/v1/personas/${personaClone.id}`)).toMatchObject({ version: 1, personality: originalPersona.personality, settings: { models: personaClone.settings.models } });
  expect(await request(first.projectId, "GET", `/v1/grader-library/${graderClone.definition.id}`)).toMatchObject({ definitionVersion: 2, gradingInstructions: clonePrompt });
  expect(await getGradingPlan(firstAuth, oldRuns[0]!.runId)).toEqual(oldPlan);

  await request(first.projectId, "PATCH", `/v1/graders/${first.projectGraderId}`, { settings: { llm_provider: "openai", llm_model: "gpt-5.6-terra" }, passThreshold: 0.95 });
  await request(first.projectId, "PATCH", `/v1/personas/${persona.id}`, { projectId: first.projectId, models: {
    llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "openai", model: "gpt-live-transcribe" },
    tts: { provider: "cartesia", model: "sonic-3.5", voiceId: "later-project-voice", speed: 1.3 },
  } });
  const claim = await api.app.inject({ method: "POST", url: CLAIMS_PATH, headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` }, payload: { contract_versions: [5], claimant: "after-shared-release", capacity: 2, wait_seconds: 0 } });
  expect(claim.statusCode, claim.body).toBe(200);
  const specs = claim.json().specs as { simulation_id: string; persona: unknown; models: unknown }[];
  expect(specs).toHaveLength(2);
  for (const [index, oldRun] of oldRuns.entries()) {
    const project = prepared[index]!;
    const spec = specs.find((one) => one.simulation_id === oldRun.simulationId)!;
    expect(spec.persona).toMatchObject({ personality: originalPersona.personality });
    expect(spec.models).toMatchObject({ llm: { provider: "openai", model: project.model }, stt: { provider: "deepgram", model: "nova-3-general" }, tts: { provider: "openai", model: "tts-1", voice_id: project.voice, speed: project.speed } });
    const auth = { ...firstAuth, projectId: project.projectId };
    await completeWithEvidence(auth, oldRun.runId, oldRun.simulationId, project, "after-shared-release");
  }
  const scripted = scriptedJudge({ answers: { [sourcePrompt]: met("The agent helps.", [1]), [clonePrompt]: new Error("fixture provider error") } });
  const options = { providerCredentials: { load: async () => ({ openai: "fixture-key" }) }, makers: scripted.makers };
  const jobs = await claimGradingJobs({ claimant: "delayed-grader", capacity: 2 });
  expect(jobs).toHaveLength(2);
  for (const job of jobs) {
    await gradeClaim(job, options);
    await releaseGradingJob(job.auth, job.id, job.claimedBy, "exercise retry with frozen values");
  }
  const retried = await claimGradingJobs({ claimant: "retry-grader", capacity: 2 });
  for (const job of retried) {
    expect(job.entries).toEqual(jobs.find((one) => one.id === job.id)!.entries);
    await gradeClaim(job, options);
    await finishGradingJob(job.auth, job.id, job.claimedBy);
    expect(await getGradingJob(job.auth, job.id)).toBeUndefined();
    const read = await readTraceGrades(job.auth, { source: "simulation", traceId: job.traceId, runId: job.runId! });
    const project = prepared.find((one) => one.projectId === job.auth.projectId)!;
    expect(read.current).toEqual(expect.arrayContaining([expect.objectContaining({ projectGraderId: project.projectGraderId, graderDefinitionVersion: 1, score: 1, parameterValues: { llm_provider: "openai", llm_model: project.model } })]));
    if (project.projectId === first.projectId) {
      expect(read.current).toEqual(expect.arrayContaining([expect.objectContaining({ projectGraderId: graderClone.grader.id, score: null, parameterValues: { llm_provider: "openai", llm_model: first.model }, details: { error: expect.stringContaining("fixture provider error") } })]));
    }
  }
  const later = await launch(first);
  const laterPlan = await getGradingPlan(firstAuth, later.runId);
  expect(laterPlan?.groups[0]?.items).toEqual(expect.arrayContaining([expect.objectContaining({ graderDefinitionVersion: 2, projectGraderId: first.projectGraderId, passThreshold: 0.95, parameterValues: { llm_provider: "openai", llm_model: "gpt-5.6-terra" }, definition: expect.objectContaining({ prompt: updatedGrader.prompt }) })]));
  expect(await getSimulation(firstAuth, later.simulationId)).toMatchObject({ personaVersionId: releasedPersona.id });
  const laterClaim = await api.app.inject({ method: "POST", url: CLAIMS_PATH, headers: { authorization: `Bearer ${api.config.simulatorServiceToken}` }, payload: { contract_versions: [5], claimant: "later-release", capacity: 1, wait_seconds: 0 } });
  expect(laterClaim.statusCode, laterClaim.body).toBe(200);
  expect(laterClaim.json().specs).toMatchObject([{ simulation_id: later.simulationId, persona: { personality: releasedPersona.personality }, models: { llm: { provider: "openai", model: "gpt-4o" }, stt: { provider: "openai", model: "gpt-live-transcribe" }, tts: { provider: "cartesia", model: "sonic-3.5", voice_id: "later-project-voice", speed: 1.3 } } }]);
  const detail = await request(first.projectId, "GET", `/v1/simulations/${oldRuns[0]!.simulationId}`);
  expect(detail.gradingPlan).not.toHaveProperty("state");
  expect(detail.grades).toEqual(expect.arrayContaining([expect.objectContaining({ projectGraderId: first.projectGraderId, parameterValues: { llm_provider: "openai", llm_model: first.model } })]));
});

async function completeWithEvidence(auth: AuthContext, runId: string, simulationId: string, project: { agentId: string; testVersionId: string }, claimant: string) {
  const started = await startSimulation(auth, simulationId, claimant);
  expect(started).toBeDefined();
  const at = BigInt(started!.startedAt!.getTime()) * 1_000n;
  const traceId = traceIdOfSimulation(simulationId)!;
  const span: NewSpan = {
    traceId, spanId: "1111111111111111", parentSpanId: "", source: "simulation", emitter: "agent", environment: "simulation",
    startedAtMicroseconds: at, durationNanoseconds: 1_000_000n, name: "agent_turn", kind: "turn:agent", status: "ok", text: "I can help.",
    audioUrl: "", toolName: "", toolArguments: "", toolResult: "", providerCallId: `egma-sim-${simulationId}`, agentPlatform: "livekit", platformAgentId: "", platformAgentName: "", platformAgentVersion: "",
    connectionType: "livekit_room", runId, agentId: project.agentId, agentVersionId: "", testVersionId: project.testVersionId, personaVersionId: started!.personaVersionId, payload: "{}", endsTrace: false,
  };
  // This LiveKit run is graded from the platform's final session record.
  // Simulation lifecycle remains the terminal report's responsibility.
  await appendSpans(auth, [
    { ...span, spanId: "2222222222222222", name: "agent_session", kind: "root", text: "" },
    { ...span, parentSpanId: "2222222222222222", endsTrace: false },
  ]);
  await completeSimulation(auth, simulationId, claimant, { endingReason: "persona_concluded", turnCount: 1, providerReference: `egma-sim-${simulationId}` });
}
