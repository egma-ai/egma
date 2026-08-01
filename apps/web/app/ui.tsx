import type { CSSProperties, ReactNode } from "react";

/**
 * The whole of the interface these pages need: a card, a field, a button and a
 * line of red text.
 *
 * There is deliberately no design system, no client state library and no data
 * layer here. These are forms and status screens on the way into the product,
 * and what the dashboard needs later is the dashboard's decision to make.
 */

export const styles = {
  page: {
    display: "flex",
    justifyContent: "center",
    padding: "4rem 1.5rem",
  } satisfies CSSProperties,
  card: {
    width: "100%",
    maxWidth: "26rem",
  } satisfies CSSProperties,
  title: {
    fontSize: "1.375rem",
    margin: "0 0 0.25rem",
  } satisfies CSSProperties,
  lead: {
    color: "#555",
    margin: "0 0 1.75rem",
    lineHeight: 1.5,
  } satisfies CSSProperties,
  label: {
    display: "block",
    fontSize: "0.8125rem",
    fontWeight: 600,
    margin: "0 0 0.375rem",
  } satisfies CSSProperties,
  hint: {
    display: "block",
    fontWeight: 400,
    color: "#666",
    marginTop: "0.125rem",
  } satisfies CSSProperties,
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "0.5rem 0.625rem",
    fontSize: "0.9375rem",
    border: "1px solid #ccc",
    borderRadius: "0.375rem",
    fontFamily: "inherit",
  } satisfies CSSProperties,
  field: { marginBottom: "1rem" } satisfies CSSProperties,
  button: {
    width: "100%",
    padding: "0.625rem",
    fontSize: "0.9375rem",
    fontWeight: 600,
    color: "#fff",
    background: "#111",
    border: 0,
    borderRadius: "0.375rem",
    cursor: "pointer",
    fontFamily: "inherit",
  } satisfies CSSProperties,
  problem: {
    color: "#b00020",
    fontSize: "0.875rem",
    margin: "0 0 1rem",
    lineHeight: 1.45,
  } satisfies CSSProperties,
  aside: {
    color: "#555",
    fontSize: "0.875rem",
    marginTop: "1.5rem",
  } satisfies CSSProperties,
  definition: {
    display: "flex",
    justifyContent: "space-between",
    padding: "0.5rem 0",
    borderTop: "1px solid #eee",
    fontSize: "0.9375rem",
  } satisfies CSSProperties,
} as const;

export function Card({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>{title}</h1>
        {lead === undefined ? null : <p style={styles.lead}>{lead}</p>}
        {children}
      </div>
    </main>
  );
}
