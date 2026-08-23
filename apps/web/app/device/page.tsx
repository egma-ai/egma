"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Field } from "../../ui/form.tsx";
import { AuthForm, AuthShell } from "../ui.tsx";

/**
 * The code from your terminal.
 *
 * The terminal opens a browser on this page with the code already in the
 * address, so the ordinary path is: read the field, see it already says what
 * the terminal says, click continue. Nobody retypes eight characters between
 * two windows.
 *
 * The field is still a field, because somebody whose browser did not open — a
 * headless machine, a remote box, a copy-pasted line — needs somewhere to type
 * it. What they type is tidied up on the way through: a hyphen, a space or
 * lower case is a thing people do, not a thing to refuse.
 */
export default function DeviceCodePage() {
  const [code, setCode] = useState("");
  const [prefilled, setPrefilled] = useState(false);

  useEffect(() => {
    const given = new URLSearchParams(window.location.search).get("user_code");
    if (given !== null && given !== "") {
      setCode(given);
      setPrefilled(true);
    }
  }, []);

  function submit(): void {
    const tidied = code.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (tidied === "") return;
    window.location.assign(`/device/approve?user_code=${tidied}`);
  }

  return (
    <AuthShell
      eyebrow="Terminal access"
      title="Connect your terminal"
      lead={
        prefilled
          ? "This is the code your terminal is showing. Check it matches, then continue."
          : "Type the code your terminal is showing."
      }
    >
      <AuthForm onSubmit={submit}>
        <Field label="Code" htmlFor="user_code">
          {/*
           * Eight characters read off another screen, so the field is drawn the
           * way the terminal draws them: monospaced, spaced out, and upper case
           * whatever was typed.
           */}
          <Input
            className="text-center font-mono text-lg tracking-[0.18em] uppercase"
            id="user_code"
            name="user_code"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
        </Field>

        <Button type="submit" size="lg">
          Continue
        </Button>
      </AuthForm>
    </AuthShell>
  );
}
