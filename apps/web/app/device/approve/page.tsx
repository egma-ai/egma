"use client";

import { useEffect, useState } from "react";

import { withReturnTo } from "../../../lib/return-to.ts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

import { AuthShell, LinkLine, Notice, StatePage } from "../../ui.tsx";

/**
 * Approving a terminal, and saying what it is being let into.
 *
 * The page states the organization and the project plainly, because granting a
 * terminal access to the wrong customer's data is the mistake this screen
 * exists to prevent. The project is a choice when there is more than one and a
 * plain fact when there is not — a level of hierarchy with one thing in it is
 * clutter rather than information.
 *
 * Nothing here is a secret and nothing is shown twice. The key the terminal
 * ends up holding is minted when the terminal collects it and never passes
 * through this window at all, which is the entire reason the flow is shaped
 * this way instead of asking somebody to copy a key across.
 */

type Pending = {
  status: "pending";
  user_code: string;
  organization: { id: string; name: string };
  projects: { id: string; name: string }[];
};

type Answered = { status: "approved" | "denied" | "expired" | "unknown" };

type State =
  | { at: "loading" }
  | { at: "ready"; authorization: Pending }
  | { at: "unreachable" };

/*
 * The facts about what is being approved: a list, a row, the name of a fact,
 * and the fact itself. A row is 56px so that the one row carrying a control
 * has room for a 44px target without the rows around it changing height.
 */
const FACT_LIST = "m-0 border-t border-border";
const FACT_ROW =
  "flex min-h-[56px] items-center justify-between gap-5 border-b border-border py-3";
const FACT_NAME = "text-sm text-muted-foreground";
const FACT_VALUE = "m-0 text-right font-normal";

/** Where each ending sends the browser. */
const ENDING: Record<string, string> = {
  approved: "/device/success",
  denied: "/device/denied",
  unknown: "/device/denied",
  expired: "/device/expired",
};

export default function ApproveDevicePage() {
  const [state, setState] = useState<State>({ at: "loading" });
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const userCode =
      new URLSearchParams(window.location.search).get("user_code") ?? "";
    if (userCode === "") {
      window.location.assign("/device");
      return;
    }

    let current = true;
    void (async () => {
      try {
        const response = await fetch(
          `/api/device/authorization?user_code=${encodeURIComponent(userCode)}`,
        );

        if (response.status === 401) {
          // Sign up or sign in, then come straight back to this code rather
          // than to the front door with the code lost.
          window.location.assign(
            withReturnTo(
              "/signup",
              `/device/approve?user_code=${encodeURIComponent(userCode)}`,
            ),
          );
          return;
        }

        const body = (await response.json()) as Pending | Answered;
        if (body.status !== "pending") {
          window.location.assign(ENDING[body.status] ?? "/device/denied");
          return;
        }

        if (!current) return;
        setProjectId(body.projects[0]?.id ?? "");
        setState({ at: "ready", authorization: body });
      } catch {
        if (current) setState({ at: "unreachable" });
      }
    })();

    return () => {
      current = false;
    };
  }, []);

  async function answer(path: string): Promise<void> {
    if (state.at !== "ready") return;
    setProblem(null);
    setBusy(true);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          user_code: state.authorization.user_code,
          projectId: projectId,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
      };

      if (!response.ok) {
        setProblem(body.message ?? "that did not go through");
        return;
      }

      window.location.assign(ENDING[body.status ?? ""] ?? "/device/denied");
    } catch {
      setProblem("Egma could not be reached. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  if (state.at === "loading") return <StatePage title="Loading authorization" lead="Checking the terminal code." />;

  if (state.at === "unreachable") {
    return (
      <StatePage
        title="Egma could not be reached"
        lead="Nothing was approved. Check that your instance is running and try the code again."
      >
        <LinkLine>
          <a href="/device">Enter the code again</a>
        </LinkLine>
      </StatePage>
    );
  }

  const { authorization } = state;
  const projects = authorization.projects;

  return (
    <AuthShell
      eyebrow="Terminal access"
      title="Authorize this terminal?"
      lead={
        <>
          A terminal showing the code{" "}
          <strong className="font-mono">{authorization.user_code}</strong>{" "}
          is asking for access. Approve it only if that code is on your own
          screen.
        </>
      }
    >
      {problem === null ? null : <Notice tone="error">{problem}</Notice>}

      {/*
       * What the terminal is being let into, as facts rather than as a form.
       * The project is a control only when there is more than one to choose
       * between; one project is a fact and a select over it is clutter.
       */}
      <dl className={FACT_LIST}>
        <div className={FACT_ROW}>
          <dt className={FACT_NAME}>Organization</dt>
          <dd className={FACT_VALUE}>{authorization.organization.name}</dd>
        </div>

        {projects.length > 1 ? (
          <div className={FACT_ROW}>
            <dt className={FACT_NAME}>
              <label htmlFor="project">Project</label>
            </dt>
            <dd className={`${FACT_VALUE} [&_select]:min-w-40`}>
              <Select
                id="project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </dd>
          </div>
        ) : (
          <div className={FACT_ROW}>
            <dt className={FACT_NAME}>Project</dt>
            <dd className={FACT_VALUE}>{projects[0]?.name ?? "—"}</dd>
          </div>
        )}
      </dl>

      {/* Deny reads first and Approve is the filled one, so the stronger of the
          two is never the one somebody reaches by habit. Stacked on a narrow
          screen, Approve stays at the bottom under the thumb. */}
      <div className="mt-6 flex gap-3 max-[620px]:flex-col-reverse [&>*]:flex-1">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={() => void answer("/api/device/deny")}
        >
          Deny
        </Button>
        <Button
          type="button"
          disabled={busy}
          onClick={() => void answer("/api/device/approve")}
        >
          {busy ? "Working…" : "Approve"}
        </Button>
      </div>
    </AuthShell>
  );
}
