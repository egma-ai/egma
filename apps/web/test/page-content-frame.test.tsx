// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PageBody, PageHeader, ProductPage } from "../ui/shell.tsx";

afterEach(cleanup);

describe("product page content frame", () => {
  it("centres the same capped frame for the title, toolbar and body", () => {
    const { container } = render(
      <ProductPage>
        <PageHeader
          title="Runs"
          toolbar={<button type="button">Any agent</button>}
          action={<button type="button">Create a run</button>}
        />
        <PageBody>
          <div>Run table</div>
        </PageBody>
      </ProductPage>,
    );

    expect(screen.getByRole("heading", { name: "Runs" })).toBeTruthy();
    expect(screen.getByText("Run table")).toBeTruthy();

    const slots = [
      "page-topbar-content",
      "page-toolbar-content",
      "page-body-content",
    ];

    for (const slot of slots) {
      const frame = container.querySelector(`[data-slot="${slot}"]`);
      expect(frame).not.toBeNull();
      expect(frame?.classList.contains("mx-auto")).toBe(true);
      expect(frame?.classList.contains("w-full")).toBe(true);
      expect(frame?.classList.contains("max-w-(--page-content-max)")).toBe(true);
    }
  });

  it("keeps the wide page maximum on the shared frame", () => {
    const { container } = render(
      <ProductPage wide>
        <PageHeader title="Transcripts" />
        <PageBody>Transcript table</PageBody>
      </ProductPage>,
    );

    const page = container.querySelector("main");
    expect(page?.classList.contains("[--page-content-max:var(--page-max-wide)]")).toBe(
      true,
    );
    expect(
      container
        .querySelector('[data-slot="page-body-content"]')
        ?.classList.contains("mx-auto"),
    ).toBe(true);
  });
});
