"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";

import { readJson } from "../../../lib/api.ts";
import { projectPath } from "../../../lib/project-context.ts";
import { runPath, type RunDetail } from "../../../lib/runs.ts";
import { ButtonLink } from "../../../ui/controls.tsx";
import { Failure, Loading, NotFound } from "../../../ui/page-state.tsx";
import { ProductStatePage } from "../../../ui/shell.tsx";

/**
 * The address a terminal prints, and the one thing it does: send somebody to
 * the run inside its project.
 *
 * **This was a second run detail page, and two of them was the problem.** A run
 * is reached from a terminal by an address with no project in it — `results_url`
 * — and from the product by a project-scoped one. Drawing both meant two pages
 * showing one run, free to disagree about what a skipped conversation means or
 * whether pending grading is a failure, and only one of them being kept in step
 * as the product moved. So this one stopped drawing anything.
 *
 * **The forwarding is a read rather than a guess.** `GET /api/runs/{id}` answers
 * `project_id` precisely so that a page holding only a run id can find out where
 * the run belongs — a browser cannot know it, and an organization with two
 * projects makes any default wrong. So the run is read, and the answer decides
 * the address.
 *
 * `replace` rather than `push`: this address is a redirect and not a place, and
 * leaving it in the history would put Back on a page whose only behaviour is to
 * come straight back here.
 *
 * A run that is not this reader's answers exactly as it does everywhere else,
 * and never says whether it exists.
 */

type Forwarding =
  | { readonly status: "reading" }
  | { readonly status: "missing"; readonly why: string }
  | { readonly status: "failed"; readonly why: string };

export default function RunResultsAddress({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = use(params);
  const router = useRouter();
  const [state, setState] = useState<Forwarding>({ status: "reading" });

  useEffect(() => {
    let current = true;

    // No project is named, and none can be: this address carries none. The run
    // read is scoped to the organization the session resolved to, which is the
    // only boundary in the product, and it answers which project the run is in.
    void readJson<RunDetail>(runPath(runId)).then((answer) => {
      if (!current) return;
      if (answer.status === "signed-out") {
        window.location.replace("/sign-in");
        return;
      }
      if (answer.status === "missing") {
        setState({ status: "missing", why: answer.refusal.message });
        return;
      }
      if (answer.status === "failed") {
        setState({ status: "failed", why: answer.refusal.message });
        return;
      }
      router.replace(
        projectPath(answer.value.project_id, "runs", answer.value.id),
      );
    });

    return () => {
      current = false;
    };
  }, [runId, router]);

  if (state.status === "missing") {
    return (
      <ProductStatePage eyebrow="Runs" title="Run">
        <NotFound
          message={state.why}
          action={<ButtonLink href="/">Go to your projects</ButtonLink>}
        />
      </ProductStatePage>
    );
  }

  if (state.status === "failed") {
    return (
      <ProductStatePage eyebrow="Runs" title="Run">
        <Failure message={state.why} />
      </ProductStatePage>
    );
  }

  return (
    <ProductStatePage eyebrow="Runs" title="Run">
      <Loading what="this run" />
    </ProductStatePage>
  );
}
