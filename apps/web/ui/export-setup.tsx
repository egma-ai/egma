"use client";

import { useEffect, useState } from "react";

import { QUIET } from "../lib/transcript-copy.ts";
import { ButtonLink } from "./controls.tsx";
import setup from "./export-setup.module.css";
import { settingsPath } from "./settings-nav.tsx";

/**
 * How an agent is pointed at this deployment, in the one place that says it.
 *
 * Two surfaces teach it — the quiet Monitoring page, and the Monitoring
 * section of the form that adds a connection — and they must teach the same
 * thing. A second copy of the address logic is a second answer to "where does
 * my agent export to", and the one that is wrong is whichever was edited last.
 * The words are `QUIET.setUp`'s, which the vocabulary test already reads.
 */

/**
 * This deployment's own address, or `null` until a browser can say what it is.
 *
 * **The address is never written down anywhere.** A self-hoster's egma is
 * wherever they put it, so a printed example would be somebody else's
 * deployment. It only exists in a browser, which is why it arrives one render
 * after mount — and why every caller draws nothing until it has: a render
 * printing `OTEL_EXPORTER_OTLP_ENDPOINT=` with nothing after the sign is a
 * variable somebody could copy and an instruction that is wrong for as long as
 * it is on screen.
 */
export function useDeploymentOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(globalThis.location.origin);
  }, []);

  return origin;
}

/**
 * The address, the two variables, and where the key comes from.
 *
 * The key is minted in project settings, where Egma shows the secret once —
 * this offers the way there and never handles a secret itself, so there is
 * nothing here to store, re-fetch, or leak.
 */
export function ExportSetUp({
  projectId,
  origin,
}: {
  readonly projectId: string;
  readonly origin: string;
}) {
  return (
    <div className={setup.setUp}>
      <p className={setup.note}>{QUIET.setUp.endpoint}</p>
      <pre className={setup.address}>{origin}</pre>
      <p className={setup.note}>{QUIET.setUp.variables}</p>
      <pre className={setup.exports}>{QUIET.setUp.exports(origin)}</pre>
      <p className={setup.note}>{QUIET.setUp.keyLead}</p>
      <ButtonLink weight="strong" href={settingsPath(projectId, "keys")}>
        {QUIET.setUp.key}
      </ButtonLink>
      {/*
        The caution about the one step of this that fails in silence: an
        organization-wide key is accepted, stored, and filed outside every
        project, so a correct-looking export shows nothing.
      */}
      <p className={setup.note}>{QUIET.setUp.caution}</p>
    </div>
  );
}
