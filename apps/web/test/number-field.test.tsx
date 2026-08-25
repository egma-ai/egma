// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { NumberField } from "../ui/number-field.tsx";

afterEach(cleanup);

/** What the field is described by, resolved to the words a reader is given. */
function describedWords(field: HTMLElement): string {
  const ids = (field.getAttribute("aria-describedby") ?? "").split(" ");
  return ids
    .filter((one) => one !== "")
    .map((one) => document.getElementById(one)?.textContent ?? "")
    .join(" ");
}

describe("the shared numeric field", () => {
  it("puts the range on the control rather than only in a sentence beside it", () => {
    render(
      <NumberField
        id="sample-rate"
        label="Share of production traces graded"
        value="20"
        min={0}
        max={100}
        step={1}
        onChange={() => {}}
      />,
    );

    const field = screen.getByLabelText("Share of production traces graded");

    expect(field.getAttribute("type")).toBe("number");
    expect(field.getAttribute("min")).toBe("0");
    expect(field.getAttribute("max")).toBe("100");
    expect(field.getAttribute("step")).toBe("1");
    // The phone keypad has to agree with the field, or somebody is asked for a
    // percentage on a keyboard with no digits on it.
    expect(field.getAttribute("inputmode")).toBe("numeric");
  });

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

  it("reads the unit out with the value instead of hiding it", () => {
    render(
      <NumberField
        id="sample-rate"
        label="Share of production traces graded"
        value="20"
        unit="%"
        hint="Changes apply only to future live traffic."
        onChange={() => {}}
      />,
    );

    const field = screen.getByLabelText("Share of production traces graded");

    expect(screen.getByText("%")).toBeTruthy();
    expect(describedWords(field)).toBe(
      "Changes apply only to future live traffic. %",
    );
  });

  it("keeps naming the unit while a refusal replaces the hint", () => {
    render(
      <>
        <p id="refusal">A whole percentage from 0 to 100.</p>
        <NumberField
          id="sample-rate"
          label="Share of production traces graded"
          value="900"
          unit="%"
          hint="Changes apply only to future live traffic."
          invalid
          describedBy="refusal"
          onChange={() => {}}
        />
      </>,
    );

    const field = screen.getByLabelText("Share of production traces graded");

    expect(field.getAttribute("aria-invalid")).toBe("true");
    // The refusal wins over the hint. It does not silence the unit — a
    // percentage being refused is exactly when the unit matters most.
    expect(describedWords(field)).toBe("A whole percentage from 0 to 100. %");
  });

  it("hands back what was typed, as typed", () => {
    const typed: string[] = [];
    render(
      <NumberField
        id="bound"
        label="Bound"
        value=""
        onChange={(value) => typed.push(value)}
      />,
    );

    fireEvent.change(screen.getByLabelText("Bound"), {
      target: { value: "2000" },
    });

    // A string, because an input's value is one and this product converts at
    // the edge that sends. A control handing back a number would have to
    // decide what an empty field means, and would decide it differently.
    expect(typed).toEqual(["2000"]);
  });

  it("is inert when it is disabled and readable when it is read-only", () => {
    const { rerender } = render(
      <NumberField
        id="bound"
        label="Bound"
        value="12"
        disabled
        onChange={() => {}}
      />,
    );
    expect((screen.getByLabelText("Bound") as HTMLInputElement).disabled).toBe(
      true,
    );

    rerender(
      <NumberField
        id="bound"
        label="Bound"
        value="12"
        readOnly
        onChange={() => {}}
      />,
    );
    const field = screen.getByLabelText("Bound") as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(field.readOnly).toBe(true);
  });
});
