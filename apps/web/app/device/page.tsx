"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { Field } from "../../ui/form.tsx";
import { AuthForm, AuthShell } from "../ui.tsx";

/**
 * Prefill the terminal code from the URL, but allow manual entry when the
 * browser was not opened automatically. Normalize case, spaces, and hyphens.
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

        <Button className="w-full" type="submit" size="lg">
          Continue
        </Button>
      </AuthForm>
    </AuthShell>
  );
}
