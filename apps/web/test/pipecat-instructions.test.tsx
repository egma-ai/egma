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
      "Keep one instance warm in pcc-deploy.toml",
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
    expect(PIPECAT_CLOUD_TESTING_PROMPT).toContain("min_agents = 1");
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
  it("shows LiveKit's three steps with Pipecat's verb", () => {
    const { container } = render(
      <PipecatMonitoringInstructions projectId="prj_1" />,
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
      "Set the environment values where your bot runs",
    ]);
    const copy = container.textContent ?? "";
    expect(copy).toContain('pip install "egma[pipecat]"');
    expect(copy).toContain("from egma.pipecat import monitor");
    expect(copy).toContain("await monitor(worker, runner_args)");
    expect(copy.indexOf("await monitor(worker, runner_args)")).toBeLessThan(
      copy.indexOf("await runner.add_workers(worker)"),
    );
    expect(copy).toContain("EGMA_URL=<your-public-egma-url>");
    expect(copy).toContain("EGMA_API_KEY=<your-project-api-key>");
    expect(
      screen.getByRole("link", { name: "API keys" }).getAttribute("href"),
    ).toBe("/projects/prj_1/settings/keys");
    expect(copy).not.toMatch(/monitoring (is )?(ready|configured|on)/iu);
  });
});
