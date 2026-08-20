"use client";

import { useEffect, useMemo, useRef } from "react";

import { cn } from "@/lib/utils";

type Dot = {
  phase: number;
  progress: number;
  size: number;
  alpha: number;
  drift: number;
};

/** The shared animated trust field on the sign-in and sign-up brand surfaces. */
export function TrustGate() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seed = useMemo(() => "C".charCodeAt(0) * 997, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return undefined;
    const context = canvas.getContext("2d");
    if (context === null) return undefined;
    const canvasElement = canvas;
    const drawingContext = context;
    let frame = 0;
    let dots: Dot[] = [];
    let width = 0;
    let height = 0;
    let ink = "";
    let visible = true;
    const reduced = globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const gates = [0.36, 0.61, 0.82] as const;

    function randomAt(index: number): number {
      const value = Math.sin(seed + index * 12.9898) * 43758.5453;
      return value - Math.floor(value);
    }

    function resize(): void {
      const bounds = canvasElement.getBoundingClientRect();
      const ratio = Math.min(globalThis.devicePixelRatio, 2);
      width = bounds.width;
      height = bounds.height;
      ink = getComputedStyle(canvasElement).color;
      canvasElement.width = Math.max(1, Math.floor(width * ratio));
      canvasElement.height = Math.max(1, Math.floor(height * ratio));
      drawingContext.setTransform(ratio, 0, 0, ratio, 0, 0);
      const count = Math.min(650, Math.max(360, Math.floor((width * height) / 1400)));
      dots = Array.from({ length: count }, (_, index) => ({
        phase: randomAt(index + 199) * Math.PI * 2,
        progress: randomAt(index + 99),
        size: 0.5 + randomAt(index + 299) * 1.4,
        alpha: 0.18 + randomAt(index + 399) * 0.62,
        drift: 0.5 + randomAt(index + 499) * 2.2,
      }));
    }

    function circle(x: number, y: number, radius: number): void {
      drawingContext.beginPath();
      drawingContext.arc(x, y, radius, 0, Math.PI * 2);
      drawingContext.stroke();
    }

    function draw(time: number): void {
      drawingContext.clearRect(0, 0, width, height);
      drawingContext.fillStyle = ink;
      drawingContext.strokeStyle = ink;
      drawingContext.lineWidth = 1;
      const seconds = reduced ? 0 : time / 1000;
      const centerY = height * 0.47;
      const startX = width * 0.1;
      const endX = width * 0.88;

      drawingContext.globalAlpha = 0.15;
      drawingContext.beginPath();
      drawingContext.moveTo(startX, centerY);
      drawingContext.lineTo(endX, centerY);
      drawingContext.stroke();
      gates.forEach((progress, index) => {
        circle(startX + (endX - startX) * progress, centerY, 34 - index * 6);
      });
      circle(endX, centerY, 7);

      for (const dot of dots) {
        const progress = (dot.progress + seconds * (0.026 + dot.drift * 0.0035)) % 1;
        const x = startX + (endX - startX) * progress;
        const spread = (1 - progress) ** 2.15 * height * 0.27;
        const y = centerY + Math.sin(dot.phase * 1.7 + progress * 7) * spread;
        const gateEnergy = Math.max(
          Math.max(0, 1 - Math.abs(progress - gates[0]) / 0.035),
          Math.max(0, 1 - Math.abs(progress - gates[1]) / 0.035),
          Math.max(0, 1 - Math.abs(progress - gates[2]) / 0.035),
        );
        const trusted = Math.max(0, (progress - 0.78) / 0.22);
        drawingContext.globalAlpha = Math.min(0.96, dot.alpha * (0.42 + gateEnergy * 1.25 + trusted * 0.5));
        drawingContext.beginPath();
        drawingContext.arc(x, y, dot.size * (1 + gateEnergy * 0.85), 0, Math.PI * 2);
        drawingContext.fill();
      }
      drawingContext.globalAlpha = 1;
      if (visible && !reduced) frame = globalThis.requestAnimationFrame(draw);
    }

    function onVisibility(): void {
      visible = document.visibilityState === "visible";
      if (visible && !reduced) frame = globalThis.requestAnimationFrame(draw);
      else globalThis.cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(resize);
    const themeObserver = new MutationObserver(() => {
      ink = getComputedStyle(canvasElement).color;
    });
    observer.observe(canvasElement);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    frame = globalThis.requestAnimationFrame(draw);
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      globalThis.cancelAnimationFrame(frame);
    };
  }, [seed]);

  return (
    <canvas
      ref={canvasRef}
      /*
       * The ink is read back off this element with `getComputedStyle`, so the
       * colour has to be a real declaration rather than a value passed in: the
       * canvas follows the theme because `text-foreground` does.
       *
       * It leaves the page entirely on a narrow screen. The brand panel is a
       * strip there, and a field of moving dots in a 144px band is decoration
       * competing with the one sentence somebody came to read.
       */
      className={cn(
        "absolute inset-0 block h-full w-full text-foreground opacity-[0.42]",
        "max-[620px]:hidden",
      )}
      aria-hidden="true"
    />
  );
}
