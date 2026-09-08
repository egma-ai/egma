// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RunStatus, simulationSquare } from "../ui/run-status.tsx";

const graded = (passed: number, failed: number, errored: number) => ({
  status: "completed" as const,
  gradingState: "complete" as const,
  gradeTally: { passed, failed, errored, selected: passed + failed + errored },
});

describe("simulationSquare", () => {
  it("reads execution before grading and shows claimed as Queued", () => {
    expect(simulationSquare({ status: "canceled", gradingState: null, gradeTally: null }))
      .toEqual({ kind: "stopped", pulse: false, word: "Canceled" });
    expect(simulationSquare({ status: "failed", gradingState: null, gradeTally: null }))
      .toEqual({ kind: "failed", pulse: false, word: "Execution failed" });
    expect(simulationSquare({ status: "queued", gradingState: null, gradeTally: null }))
      .toEqual({ kind: "waiting", pulse: true, word: "Queued" });
    expect(simulationSquare({ status: "claimed", gradingState: null, gradeTally: null }))
      .toEqual({ kind: "waiting", pulse: true, word: "Queued" });
    expect(simulationSquare({ status: "running", gradingState: null, gradeTally: null }))
      .toEqual({ kind: "active", pulse: true, word: "Running" });
  });

  it("pulses while grading and turns red on a grading error", () => {
    expect(simulationSquare({ status: "completed", gradingState: "pending", gradeTally: null }))
      .toEqual({ kind: "active", pulse: true, word: "Grading" });
    expect(simulationSquare({ status: "completed", gradingState: "running", gradeTally: null }))
      .toEqual({ kind: "active", pulse: true, word: "Grading" });
    expect(simulationSquare({ status: "completed", gradingState: "error", gradeTally: null }))
      .toEqual({ kind: "error", pulse: false, word: "Grading failed" });
    expect(simulationSquare({ status: "completed", gradingState: "not_requested", gradeTally: null }))
      .toEqual({ kind: "not-requested", pulse: false, word: "Not graded" });
  });

  it("is green only when every grader passed its own threshold, and says the count", () => {
    expect(simulationSquare(graded(3, 0, 0)))
      .toEqual({ kind: "passed", pulse: false, word: "3/3 passed" });
    expect(simulationSquare(graded(2, 1, 0)))
      .toEqual({ kind: "failed", pulse: false, word: "2/3 passed" });
    expect(simulationSquare({ ...graded(0, 0, 0), gradeTally: { passed: 0, failed: 0, errored: 0, selected: 0 } }))
      .toEqual({ kind: "not-requested", pulse: false, word: "Not graded" });
  });
});

describe("RunStatus", () => {
  afterEach(cleanup);

  it("draws a filled square that pulses only while the run is unsettled", () => {
    const { container, rerender } = render(<RunStatus status="pending" />);
    const square = () => container.querySelector('[data-slot="state-mark"]');
    expect(square()?.getAttribute("data-filled")).toBe("true");
    expect(square()?.getAttribute("data-state-mark")).toBe("waiting");
    expect(square()?.getAttribute("data-motion")).toBe("pulse");
    rerender(<RunStatus status="running" />);
    expect(square()?.getAttribute("data-motion")).toBe("pulse");
    rerender(<RunStatus status="completed" />);
    expect(square()?.getAttribute("data-state-mark")).toBe("complete");
    expect(square()?.getAttribute("data-motion")).toBeNull();
    rerender(<RunStatus status="canceled" />);
    expect(square()?.getAttribute("data-state-mark")).toBe("stopped");
    expect(square()?.className).toContain("bg-faint");
    expect(container.querySelector('[data-slot="run-status-loader"]')).toBeNull();
    expect(container.textContent).toBe("Canceled");
  });
});
