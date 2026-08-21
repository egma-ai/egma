"use client";

import { Badge } from "@/components/ui/badge";
import { NO_ENVIRONMENT, type ListedConnection } from "@/lib/agents.ts";

/**
 * How egma reaches an agent, said on the row rather than one click away.
 *
 * **These are the four facts somebody brings to a list of agents.** Which
 * supported setup, which modality, and which environment. A staging chat connection and a production
 * phone number are different enough that telling them apart should not cost a
 * page load, and an agent egma cannot reach at all should be visible here
 * rather than discovered when a run refuses to start.
 *
 * Everything is drawn from what the list read already carried. There is no
 * second request behind any of it: the product label comes down on the
 * connection, derived by the registry that gates the connection forms, so this
 * application keeps no label table able to disagree with it.
 */

/**
 * What a person is shown for a channel.
 *
 * Two values, and the words are the product's rather than the API's: a
 * connection's modality is `voice` or `chat`, and a person reading a list is
 * shown Voice or Chat. The connection page draws them that way, and these
 * surfaces say the same words rather than inventing a third pair.
 *
 * **It said Text until #158**, which made Retell a Chat connection and renamed
 * the word on the connection page and in the new-connection form. The rename
 * arrives here because saying "the same words" is the whole reason this
 * function exists: leaving it behind would have produced exactly the third
 * pair the paragraph above refuses.
 */
export function modalityLabel(modality: string): string {
  return modality === "voice" ? "Voice" : "Chat";
}

/**
 * One connection, in one line of reading.
 *
 * The environment label leads because it is what somebody scans for — an
 * unlabelled connection says so in a word rather than leaving a blank cell
 * that reads as a rendering fault.
 */
export function ConnectionFacts({
  connection,
}: {
  readonly connection: ListedConnection;
}) {
  return (
    /*
     * It wraps rather than clips. On a narrow screen the table restyles into
     * labelled rows and this cell gets about seventy per cent of a phone.
     * On a wide screen there is room and it never wraps.
     */
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <span className="truncate text-sm font-medium text-foreground">
        {connection.environment ?? NO_ENVIRONMENT}
      </span>
      <span className="truncate text-sm text-muted-foreground">
        {connection.productLabel} · {modalityLabel(connection.modality)}
      </span>
    </span>
  );
}

/**
 * Every way into one agent, or the fact that there is none.
 *
 * **"No connections" is a state of the agent, not an empty cell.** An agent
 * nobody has wired is an agent egma cannot test, and a row that simply left the
 * space blank would leave that to be found out at the start of a run. It is a
 * word and a mark, because `DESIGN.md` does not let colour carry a state on its
 * own — and it is the same neutral chip as the rest, because being unreachable
 * is a fact about setup rather than a failure anybody has had yet.
 */
export function ConnectionsOnRow({
  connections,
}: {
  readonly connections: readonly ListedConnection[];
}) {
  if (connections.length === 0) {
    return (
      <Badge variant="neutral">
        <NoWayInMark />
        No connections
      </Badge>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {connections.map((one) => (
        <li className="min-w-0" key={one.id}>
          <ConnectionFacts connection={one} />
        </li>
      ))}
    </ul>
  );
}

/** A way in that is not there: the same circle, struck through. */
function NoWayInMark() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <circle
        cx="6"
        cy="6"
        r="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="3"
        y1="9"
        x2="9"
        y2="3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
