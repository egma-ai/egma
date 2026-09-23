// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PipecatMonitoringInstructions } from "../app/projects/[projectId]/agents/pipecat-monitoring-instructions.tsx";
import {
  PIPECAT_CLOUD_TESTING_PROMPT,
  PIPECAT_SELF_HOSTED_TESTING_PROMPT,
  PIPECAT_TESTING_SNIPPET,
  PipecatTestingInstructions,
} from "../app/projects/[projectId]/agents/pipecat-testing-instructions.tsx";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));

afterEach(cleanup);

/** The numbered step titles, in order. */
function stepTitles(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll("ol > li")].map(
    (step) => step.querySelector("p")?.textContent ?? "",
  );
}

describe("Pipecat testing instructions", () => {
  it("hands a Pipecat Cloud bot the one line, the install and the secret-set step", () => {
    const { container } = render(
      <PipecatTestingInstructions
        projectId="prj_1"
        agentId="agt_1"
        access="pipecat_cloud"
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Add simulation testing to your Pipecat agent",
      }),
    ).toBeTruthy();
    // Python only: nothing asks which language the bot is in.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(stepTitles(container)).toEqual([
      "Give this to your coding agent",
      "Install the Egma SDK",
      "Add the testing hook to bot()",
      "Recommended: keep one instance warm in pcc-deploy.toml",
      "Add the Egma values to your secret set and redeploy",
    ]);
    expect(screen.getAllByRole("button", { name: /^Copy / })).toHaveLength(5);

    const copy = container.textContent ?? "";
    expect(copy).toContain('pip install "egma[pipecat]"');
    expect(copy).toContain("from egma.pipecat import simulation");
    expect(copy).toContain("await simulation(worker, runner_args)");
    // The line sits after the worker exists and before the runner starts it.
    expect(copy).toContain(PIPECAT_TESTING_SNIPPET);
    expect(PIPECAT_TESTING_SNIPPET.indexOf("worker = PipelineWorker(")).toBeLessThan(
      PIPECAT_TESTING_SNIPPET.indexOf("await simulation(worker, runner_args)"),
    );
    expect(
      PIPECAT_TESTING_SNIPPET.indexOf("await simulation(worker, runner_args)"),
    ).toBeLessThan(
      PIPECAT_TESTING_SNIPPET.indexOf("await runner.add_workers(worker)"),
    );
    expect(copy).toContain("min_agents = 1");
    expect(copy).toContain(
      "pipecat cloud secrets set <your-secret-set> EGMA_URL=<your-public-egma-url> EGMA_API_KEY=<your-project-api-key>",
    );
    expect(copy).toContain("pipecat cloud deploy");
    expect(copy).not.toContain("egma agent dev");
    expect(copy).not.toContain("from egma import");
    expect(copy).not.toContain("livekit");
    expect(
      screen.getByRole("link", { name: "API keys" }).getAttribute("href"),
    ).toBe("/projects/prj_1/settings/keys");
    expect(copy).not.toMatch(/testing (is )?(ready|configured|on)/iu);

    expect(PIPECAT_CLOUD_TESTING_PROMPT).toContain(
      "await simulation(worker, runner_args)",
    );
    // One warm instance is recommended, never imposed on the repository.
    expect(PIPECAT_CLOUD_TESTING_PROMPT).toContain("recommend min_agents = 1");
    expect(PIPECAT_CLOUD_TESTING_PROMPT).toContain("change it only if I agree");
    expect(PIPECAT_CLOUD_TESTING_PROMPT).not.toMatch(/\bset min_agents/u);
    expect(PIPECAT_CLOUD_TESTING_PROMPT).toContain("egma[pipecat]");
    expect(PIPECAT_CLOUD_TESTING_PROMPT).toContain(
      "leave every environment file unread",
    );
  });

  it("gives a self-hosted bot the environment values and this machine's egma agent dev", () => {
    const { container } = render(
      <PipecatTestingInstructions
        projectId="prj_1"
        agentId="agt_01K5TB2H8Y4P7QCWF9XKMD6RZP"
        access="self_hosted"
      />,
    );

    expect(stepTitles(container)).toEqual([
      "Give this to your coding agent",
      "Install the Egma SDK",
      "Add the testing hook to bot()",
      "Set the environment values where your bot runs",
      "Test a bot running on this machine",
    ]);
    const copy = container.textContent ?? "";
    expect(copy).toContain("EGMA_URL=<your-public-egma-url>");
    expect(copy).toContain("EGMA_API_KEY=<your-project-api-key>");
    expect(copy).toContain(
      "egma agent dev --agent agt_01K5TB2H8Y4P7QCWF9XKMD6RZP --port 7860",
    );
    expect(copy).not.toContain("pipecat cloud");
    expect(copy).not.toContain("min_agents");
    expect(PIPECAT_SELF_HOSTED_TESTING_PROMPT).not.toContain("pcc-deploy.toml");
  });
});

describe("Pipecat monitoring instructions", () => {
  it("hands an existing agent its own monitoring key, never a plain project key", () => {
    const { container } = render(
      <PipecatMonitoringInstructions agentId="agt_lakeside" registers={false} />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Add monitoring to your Pipecat agent",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(stepTitles(container)).toEqual([
      "Install the Egma SDK",
      "Add the monitoring hook to bot()",
      "Get this agent's monitoring key",
      "Set the environment values where your bot runs",
    ]);
    const copy = container.textContent ?? "";
    expect(copy).toContain('pip install "egma[pipecat]"');
    expect(copy).toContain("from egma.pipecat import monitor");
    expect(copy).toContain("await monitor(worker, runner_args)");
    expect(copy.indexOf("await monitor(worker, runner_args)")).toBeLessThan(
      copy.indexOf("await runner.add_workers(worker)"),
    );
    // Production traces are filed under the agent whose monitoring key sent
    // them, so the key is this agent's, minted by the CLI.
    expect(copy).toContain("egma agent monitoring --agent agt_lakeside");
    expect(copy).toContain("EGMA_URL=<your-public-egma-url>");
    expect(copy).toContain("EGMA_API_KEY=<agent-monitoring-key>");
    expect(copy).not.toContain("<your-project-api-key>");
    expect(screen.queryByRole("link", { name: "API keys" })).toBeNull();
    expect(copy).toContain(
      "Set <your-public-egma-url> to the public Egma API URL that your deployed bot can reach.",
    );
    expect(copy).not.toMatch(/monitoring (is )?(ready|configured|on)/iu);
  });

  it("registers a new agent first when monitoring is the whole setup", () => {
    const { container } = render(
      <PipecatMonitoringInstructions agentId={null} registers />,
    );
    expect(stepTitles(container)[2]).toBe(
      "Register the agent and get its monitoring key",
    );
    expect(container.textContent).toContain(
      "egma agent register --platform pipecat",
    );
    expect(container.textContent).toContain(
      "egma agent monitoring --agent <agent-id>",
    );
  });

  it("leaves a Both setup's new agent to its simulation step for the real id", () => {
    const { container } = render(
      <PipecatMonitoringInstructions agentId={null} registers={false} />,
    );
    expect(stepTitles(container)[2]).toBe("Get this agent's monitoring key");
    expect(container.textContent).not.toContain("egma agent register");
    expect(container.textContent).toContain(
      "egma agent monitoring --agent <agent-id>",
    );

    // The testing instructions that follow in Both carry the real id, and the
    // bot exports with that one key for both lines.
    cleanup();
    const both = render(
      <PipecatTestingInstructions
        projectId="prj_1"
        agentId="agt_lakeside"
        access="pipecat_cloud"
        monitors
      />,
    );
    expect(stepTitles(both.container)).toEqual([
      "Give this to your coding agent",
      "Install the Egma SDK",
      "Add the testing hook to bot()",
      "Get this agent's monitoring key",
      "Recommended: keep one instance warm in pcc-deploy.toml",
      "Add the Egma values to your secret set and redeploy",
    ]);
    const said = both.container.textContent ?? "";
    expect(said).toContain("egma agent monitoring --agent agt_lakeside");
    expect(said).toContain("EGMA_API_KEY=<agent-monitoring-key>");
    expect(said).not.toContain("<your-project-api-key>");
    expect(screen.queryByRole("link", { name: "API keys" })).toBeNull();
  });
});
