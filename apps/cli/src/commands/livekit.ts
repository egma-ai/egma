/**
 * The current source contract for a LiveKit worker.
 *
 * This belongs to the versioned CLI, not to an Agent Skill. The skill tells a
 * coding agent when it needs this contract; the installed CLI tells it the
 * source hooks without choosing an SDK version.
 */

export type LiveKitContractCommandOptions = {
  readonly out: (line: string) => void;
};

/** Print stable fact lines that a coding agent can apply to the real worker. */
export function runLiveKitContractCommand(
  options: LiveKitContractCommandOptions,
): number {
  options.out("integration: livekit-python");
  options.out("python: 3.11-or-newer");
  options.out("testing_import: from egma import mockable");
  options.out("testing_call: await mockable(agent, ctx, session)");
  options.out(
    "testing_position: after the initial agent and AgentSession exist; before AgentSession.start",
  );
  options.out("monitoring_import: from egma import monitor_livekit");
  options.out("monitoring_call: monitor_livekit(ctx)");
  options.out(
    "monitoring_position: first statement in the job entrypoint; before ctx.connect and AgentSession.start",
  );
  options.out("simulation_room_prefix: egma-sim-");
  options.out("chat_room_prefix: egma-sim-chat-");
  options.out(
    "chat_rule: disable AgentSession audio input, audio output, and transcription sync, and do not start any independent audio publisher",
  );
  options.out(
    "dispatch_name: use the exact registered WorkerOptions agent_name; add one when the worker has none",
  );
  options.out("node_worker: chat setup only; the Egma SDK does not support Node workers");
  options.out("status: ready");
  return 0;
}
