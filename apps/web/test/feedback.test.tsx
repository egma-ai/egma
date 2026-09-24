// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

afterEach(cleanup);

describe("shared feedback", () => {
  it("names a busy button and makes it inert", () => {
    render(
      <Button type="button" busy>
        Saving agent…
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Saving agent…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
  });
});
