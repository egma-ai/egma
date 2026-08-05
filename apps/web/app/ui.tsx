import type { CSSProperties, ReactNode } from "react";

/**
 * The whole of the interface these pages need: a card, a field, a button and a
 * line of red text — and, since the transcript pages arrived, a wider screen to
 * put a table on.
 *
 * There is deliberately no design system, no client state library and no data
 * layer here. The forms on the way into the product asked for none, and the
 * first two pages of the dashboard asked for none either: they wanted a second
 * width and six more entries in the same object, which is what they got. A
 * component library imported for two pages is a dependency every page after
 * them inherits, and the point at which one is worth taking on is a point
 * something will have to actually reach.
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

  /* The wider half, for the pages that show what happened rather than ask. */

  screen: {
    width: "100%",
    maxWidth: "64rem",
  } satisfies CSSProperties,
  /** A table wider than the window scrolls itself rather than the page. */
  scroller: {
    overflowX: "auto",
    border: "1px solid #eee",
    borderRadius: "0.375rem",
  } satisfies CSSProperties,
  table: {
    borderCollapse: "collapse",
    width: "100%",
    fontSize: "0.875rem",
  } satisfies CSSProperties,
  columnHeading: {
    textAlign: "left",
    fontWeight: 600,
    color: "#555",
    whiteSpace: "nowrap",
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid #eee",
  } satisfies CSSProperties,
  cell: {
    padding: "0.5rem 0.75rem",
    borderBottom: "1px solid #f2f2f2",
    whiteSpace: "nowrap",
    verticalAlign: "top",
  } satisfies CSSProperties,
  /** What went wrong, wherever a number or a step has to carry it. */
  wrong: { color: "#b00020", fontWeight: 600 } satisfies CSSProperties,
  muted: { color: "#777" } satisfies CSSProperties,
  monospace: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.8125rem",
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

/**
 * The same page, at the width a table needs. `Card` with a wider box would have
 * done, and it is a separate component because a form at sixty-four rems is a
 * worse form — the two widths are for two different jobs.
 */
export function Screen({
  title,
  lead,
  aside,
  children,
}: {
  title: string;
  lead?: ReactNode;
  /** What sits beside the heading: a control, a link back. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main style={styles.page}>
      <div style={styles.screen}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            flexWrap: "wrap",
            gap: "1rem",
          }}
        >
          <h1 style={styles.title}>{title}</h1>
          {aside}
        </div>
        {lead === undefined ? null : <p style={styles.lead}>{lead}</p>}
        {children}
      </div>
    </main>
  );
}
