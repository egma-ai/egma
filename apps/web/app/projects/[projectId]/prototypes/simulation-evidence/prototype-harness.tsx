"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { projectPath } from "../../../../../lib/project-context.ts";
import {
  simulationPath,
  type SimulationEvidence,
} from "../../../../../lib/simulations.ts";
import { Failure, Loading, NotFound } from "../../../../../ui/page-state.tsx";
import { useProjectRead } from "../../../../../ui/resource.ts";
import {
  PageBody,
  PageHeader,
  ProductPage,
} from "../../../../../ui/shell.tsx";
import { BehaviorMatrix } from "./behavior-matrix.tsx";
import { CallMap } from "./call-map.tsx";
import { DecisionDossier } from "./decision-dossier.tsx";
import pickerStyles from "./picker.module.css";
import styles from "./prototype.module.css";
import { usePrototypeRecording } from "./shared.tsx";

const VARIANTS = [
  { name: "Behavior Matrix", render: BehaviorMatrix },
  { name: "Call Map", render: CallMap },
  { name: "Decision Dossier", render: DecisionDossier },
] as const;

export function PrototypeHarness({
  projectId,
  simulationId,
  initialVariant,
}: {
  readonly projectId: string;
  readonly simulationId: string;
  readonly initialVariant: number;
}) {
  const { answer, reload } = useProjectRead<SimulationEvidence>(
    simulationPath(simulationId),
    projectId,
  );
  const [variant, setVariant] = useState(initialVariant);
  const picker = useRef<HTMLElement | null>(null);
  const highlight = useRef<HTMLSpanElement | null>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const evidence = answer?.status === "ready" ? answer.value : null;
  const recording = usePrototypeRecording(evidence, projectId);

  const moveHighlight = useCallback(() => {
    const selected = items.current[variant];
    if (selected === null || selected === undefined || highlight.current === null) {
      return;
    }
    highlight.current.style.width = `${String(selected.offsetWidth)}px`;
    highlight.current.style.transform = `translateX(${String(selected.offsetLeft)}px)`;
  }, [variant]);

  useEffect(() => {
    if (answer?.status === "signed-out") window.location.replace("/sign-in");
  }, [answer]);

  useLayoutEffect(() => {
    moveHighlight();
    window.addEventListener("resize", moveHighlight);
    return () => window.removeEventListener("resize", moveHighlight);
  }, [answer, moveHighlight]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => picker.current?.setAttribute("data-ready", ""));
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (/^(INPUT|TEXTAREA|SELECT)$/u.test(target.tagName) || target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const number = Number.parseInt(event.key, 10);
      if (number >= 1 && number <= VARIANTS.length) {
        choose(number - 1);
      } else if (event.key === "ArrowRight") {
        choose((variant + 1) % VARIANTS.length);
      } else if (event.key === "ArrowLeft") {
        choose((variant - 1 + VARIANTS.length) % VARIANTS.length);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function choose(next: number): void {
    if (next < 0 || next >= VARIANTS.length) return;
    setVariant(next);
    const url = new URL(window.location.href);
    url.searchParams.set("v", String(next + 1));
    window.history.replaceState(null, "", url);
  }

  if (answer === null || answer.status === "signed-out") {
    return (
      <ProductPage wide>
        <PageHeader eyebrow="Prototype" title="Simulation evidence" />
        <PageBody>
          <Loading what="this simulation" />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "missing") {
    return (
      <ProductPage wide>
        <PageHeader eyebrow="Prototype" title="Simulation evidence" />
        <PageBody>
          <NotFound message={answer.refusal.message} />
        </PageBody>
      </ProductPage>
    );
  }

  if (answer.status === "failed") {
    return (
      <ProductPage wide>
        <PageHeader eyebrow="Prototype" title="Simulation evidence" />
        <PageBody>
          <Failure message={answer.refusal.message} onRetry={reload} />
        </PageBody>
      </ProductPage>
    );
  }

  const shownEvidence = answer.value;
  const Variant = VARIANTS[variant]?.render ?? BehaviorMatrix;

  return (
    <>
      <ProductPage wide>
        <PageHeader
          title={shownEvidence.test.name ?? "Simulation evidence"}
          breadcrumbs={[
            { label: "Runs", href: projectPath(projectId, "runs") },
            {
              label: shownEvidence.run_label ?? "Run",
              href: projectPath(projectId, "runs", shownEvidence.run_id),
            },
            { label: "Prototype" },
          ]}
          lead={
            <>
              <Link href={projectPath(projectId, "personas", shownEvidence.persona.id)}>
                {shownEvidence.persona.name ?? "Caller"}
              </Link>{" "}
              calling{" "}
              <Link href={projectPath(projectId, "agents", shownEvidence.agent.id)}>
                {shownEvidence.agent.name ?? "the agent"}
              </Link>
            </>
          }
        />
        <PageBody>
          <div className={styles.stage} key={VARIANTS[variant]?.name}>
            <Variant evidence={shownEvidence} recording={recording} />
          </div>
        </PageBody>
      </ProductPage>

      <nav
        ref={picker}
        className={`proto-picker ${pickerStyles.pickerRoot}`}
        aria-label="Prototype variants"
      >
        <span ref={highlight} className="proto-picker-highlight" aria-hidden="true" />
        {VARIANTS.map((one, at) => (
          <button
            ref={(node) => {
              items.current[at] = node;
            }}
            className="proto-picker-item"
            data-active={variant === at ? "" : undefined}
            aria-current={variant === at ? "true" : undefined}
            key={one.name}
            type="button"
            onClick={() => choose(at)}
          >
            {one.name}
          </button>
        ))}
      </nav>
    </>
  );
}
