import { notFound, redirect } from "next/navigation";

/**
 * A development-only proof surface for the shared product system.
 *
 * It is intentionally absent from production. The product routes use the same
 * components, so this page is a place to inspect their states without adding a
 * second implementation or sample navigation to the application.
 */
export default function DesignSystemPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  redirect("/projects/prj_proof/design-system");
}
