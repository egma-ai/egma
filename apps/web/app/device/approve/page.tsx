"use client";

import { useEffect, useState } from "react";

import { withReturnTo } from "../../../lib/return-to.ts";
import { AuthShell, Notice, StatePage, styles } from "../../ui.tsx";

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
          project_id: projectId,
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
      setProblem("egma could not be reached. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  if (state.at === "loading") return <StatePage title="Loading authorization" lead="Checking the terminal code." />;

  if (state.at === "unreachable") {
    return (
      <StatePage
        title="egma could not be reached"
        lead="Nothing was approved. Check that your instance is running and try the code again."
      >
        <p className={styles.linkLine}>
          <a href="/device">Enter the code again</a>
        </p>
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
          <strong
            className={styles.mono}
          >
            {authorization.user_code}
          </strong>{" "}
          is asking for access. Approve it only if that code is on your own
          screen.
        </>
      }
    >
      {problem === null ? null : <Notice tone="error">{problem}</Notice>}

      <dl className={styles.definitionList}>
        <div className={styles.definitionRow}><dt>Organization</dt><dd>{authorization.organization.name}</dd></div>

      {projects.length > 1 ? (
        <div className={styles.definitionRow}>
          <dt><label htmlFor="project">Project</label></dt>
          <dd>
          <select
            id="project"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          </dd>
        </div>
      ) : (
        <div className={styles.definitionRow}><dt>Project</dt><dd>{projects[0]?.name ?? "—"}</dd></div>
      )}
      </dl>

      <div className={styles.buttonRow}>
        <button
          className={styles.buttonSecondary}
          type="button"
          disabled={busy}
          onClick={() => void answer("/api/device/deny")}
        >
          Deny
        </button>
        <button
          className={styles.button}
          type="button"
          disabled={busy}
          onClick={() => void answer("/api/device/approve")}
        >
          {busy ? "Working…" : "Approve"}
        </button>
      </div>
    </AuthShell>
  );
}
