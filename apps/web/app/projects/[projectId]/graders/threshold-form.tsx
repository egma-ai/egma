"use client";

import { useState } from "react";
import { updateGrader } from "@egma/platform-api/client";

import { Button } from "@/components/ui/button";
import type { Refusal } from "../../../../lib/api.ts";
import type { ProjectGrader } from "../../../../lib/graders.ts";
import {
  platformAnswer,
  platformClient,
} from "../../../../lib/platform-client.ts";
import {
  Form,
  FormActions,
  Help,
  Refused,
} from "../../../../ui/form.tsx";
import { NumberField } from "../../../../ui/number-field.tsx";
import { useUnsavedChanges } from "../../../../ui/settings-read.ts";

export function ThresholdForm({
  grader,
  projectId,
  onSaved,
  onCancel,
}: {
  readonly grader: ProjectGrader;
  readonly projectId: string;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const [threshold, setThreshold] = useState(String(grader.passThreshold));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Refusal | null>(null);
  const value = Number(threshold);
  const valid =
    threshold.trim() !== "" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1;
  const changed = threshold !== String(grader.passThreshold);
  useUnsavedChanges(changed && !busy, busy);

  async function save(): Promise<void> {
    if (busy || !valid) return;
    setBusy(true);
    setRefused(null);
    const answer = await platformAnswer(
      updateGrader(
        { graderId: grader.id, projectId, passThreshold: value },
        { client: platformClient },
      ),
    );
    setBusy(false);

    if (answer.status === "signed-out") {
      window.location.replace("/sign-in");
      return;
    }
    if (answer.status !== "ready") {
      setRefused(answer.refusal);
      return;
    }
    onSaved();
  }

  return (
    <Form onSubmit={() => void save()}>
      <Help>
        The grader passes when its normalized score meets this value. This
        changes future grading policy. It does not change the grader definition.
      </Help>
      {refused === null ? null : <Refused message={refused.message} />}
      <NumberField
        id="grader-pass-threshold"
        label="Pass threshold"
        value={threshold}
        onChange={setThreshold}
        min={0}
        max={1}
        step={0.01}
        required
        disabled={busy}
        invalid={!valid}
        hint="Enter a number from 0 through 1."
      />
      <FormActions>
        <Button type="submit" disabled={busy || !valid}>
          {busy ? "Saving…" : "Save threshold"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </FormActions>
    </Form>
  );
}
