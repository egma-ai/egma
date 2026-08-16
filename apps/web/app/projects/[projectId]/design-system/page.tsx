import { notFound } from "next/navigation";

import { DesignSystemProof } from "../../../design-system/proof.tsx";

/**
 * The development proof needs an honest project address so the real AppShell
 * can show its selector, navigation, account control, and mobile drawer.
 */
export default function ProjectDesignSystemPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <DesignSystemProof />;
}
