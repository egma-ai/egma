/**
 * The current source contract for a LiveKit worker.
 *
 * This file is not a public CLI verb. The web product reads the versioned
 * contract here to keep its LiveKit instructions in step with the installed
 * CLI. The public CLI sends developers and coding agents to the integration
 * skill instead of exposing a root-level LiveKit command.
 */

export type LiveKitContractCommandOptions = {
  readonly out: (line: string) => void;
};

/** Print stable fact lines that the web contract test can compare. */
export function runLiveKitContractCommand(
  options: LiveKitContractCommandOptions,
): number {
  options.out("integration: livekit");
  options.out("python: 3.11-or-newer");
  options.out("python_testing: supported");
  options.out("python_testing_import: from egma import mockable");
  options.out("python_testing_call: await mockable(agent, ctx, session)");
  options.out(
    "python_testing_position: after the initial agent and AgentSession exist; before AgentSession.start",
  );
  options.out("python_monitoring: supported");
  options.out("python_monitoring_import: from egma import monitor_livekit");
  options.out("python_monitoring_call: monitor_livekit(ctx)");
  options.out(
    "python_monitoring_position: first statement in the job entrypoint; before ctx.connect and AgentSession.start",
  );
  options.out("javascript: node-22-or-newer");
  options.out("javascript_testing: supported");
  options.out("javascript_testing_package: @egma/livekit");
  options.out(
    'javascript_testing_import: import { mockable } from "@egma/livekit"',
  );
  options.out("javascript_testing_call: await mockable(agent, ctx, session)");
  options.out(
    "javascript_testing_position: after the initial agent and AgentSession exist; before AgentSession.start",
  );
  options.out(
    "javascript_testing_process_rule: call mockable once; Egma permits one active mockable AgentSession in each LiveKit job process",
  );
  options.out("javascript_monitoring: supported");
  options.out("javascript_monitoring_package: @egma/livekit");
  options.out(
    'javascript_monitoring_import: import { monitorLiveKit } from "@egma/livekit"',
  );
  options.out("javascript_monitoring_call: monitorLiveKit(ctx)");
  options.out(
    "javascript_monitoring_position: first statement in the job entrypoint; before ctx.connect and AgentSession.start",
  );
  options.out("simulation_room_prefix: egma-sim-");
  options.out("chat_room_prefix: egma-sim-chat-");
  options.out(
    "chat_rule: disable AgentSession audio input, audio output, and transcription sync, and do not start any independent audio publisher",
  );
  options.out(
    "dispatch_name: use the exact registered worker name for the discovered language; add one when the worker has none",
  );
  options.out("status: ready");
  return 0;
}
