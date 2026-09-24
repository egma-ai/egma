// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NumberField } from "../ui/number-field.tsx";

afterEach(cleanup);

describe("the shared numeric field", () => {
  it("asks for the decimal keypad when a step is not a whole number", () => {
    render(
      <NumberField
        id="bound"
        label="Bound"
        value="1.5"
        step={0.1}
        onChange={() => {}}
      />,
    );

    expect(screen.getByLabelText("Bound").getAttribute("inputmode")).toBe(
      "decimal",
    );
  });
});
