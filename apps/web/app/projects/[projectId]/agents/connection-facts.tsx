"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { connectionsOnRow, type ListedConnection } from "@/lib/agents.ts";

/**
 * How egma reaches an agent, said on the row rather than one click away.
 *
 * **The cell names the ways in and lets a person open one.** That is what the
 * board draws (`6ZJ-0`): each connection is its own underlined link, and
 * following it opens that connection over the list a person is already reading
 * rather than sending them two pages away and back. An agent egma cannot reach
 * at all says so here, in words, rather than at the moment a run refuses to
 * start.
 *
 * **It used to be a line of facts per connection** — environment, product
 * label, modality — stacked one under another, which made a row with three
 * connections three times as tall as its neighbour and gave a person nothing to
 * press. The resolved comment threads on the decision page ruled the other way:
 * consistent row heights, two names then an overflow chip, and link text in the
 * text colour. Those four facts have not gone anywhere; they are what the
 * connection sheet opens onto.
 *
 * Everything is drawn from what the list read already carried. There is no
 * second request behind any of it.
 */

/**
 * What a person is shown for a channel.
 *
 * Two values, and the words are the product's rather than the API's: a
 * connection's modality is `voice` or `chat`, and a person reading a list is
 * shown Voice or Chat. The connection sheet draws them that way, and these
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
 * Every way into one agent, or the fact that there is none.
 *
 * **"No connections yet" is a state of the agent, not an empty cell.** An agent
 * nobody has wired is an agent egma cannot test, and a row that simply left the
 * space blank would leave that to be found out at the start of a run. It is
 * quiet rather than a warning, because being unwired is a fact about setup and
 * not a failure anybody has had yet.
 *
 * **The overflow chip counts rather than lists.** Two links, then "+3" — and
 * the chip opens the agent, which is the one page that holds every connection.
 * A row that grew a line per connection would be a different height per agent,
 * and a column of ragged rows is what makes a dense list hard to scan.
 */
export function ConnectionsOnRow({
  connections,
  agentHref,
  hrefOf,
}: {
  readonly connections: readonly ListedConnection[];
  /** Where the overflow chip goes: the one page that holds them all. */
  readonly agentHref: string;
  readonly hrefOf: (connection: ListedConnection) => string;
}) {
  if (connections.length === 0) {
    return <span className="text-faint">No connections yet</span>;
  }

  const { shown, overflow } = connectionsOnRow(connections);

  return (
    /*
     * 20px between the links, which is `6ZJ-0`, and one line however long the
     * names are. **The cell never wraps.** A second line here makes one row
     * taller than the rows above and below it, and a column of ragged rows is
     * what makes a dense list hard to scan — the same reason the chip counts
     * instead of listing. A long name is cut with an ellipsis and carries its
     * full text in a tooltip, and the connection sheet behind the link says
     * the whole name again.
     */
    <span className="flex min-w-0 flex-nowrap items-center gap-x-5 whitespace-nowrap">
      {shown.map((one) => (
        <Link
          className="min-w-0 truncate text-foreground"
          href={hrefOf(one)}
          key={one.id}
          title={one.name}
        >
          {one.name}
        </Link>
      ))}
      {overflow === 0 ? null : (
        /*
         * The chip is a link and says what it counts. "+3" alone is a number a
         * screen reader would read as a number; the hidden half names what the
         * number is of, so the same control means the same thing however it is
         * read.
         */
        <Badge asChild shape="count">
          {/*
           * **The chip is not underlined, and the links beside it are.** A cell
           * link in this product wears an underline (`DESIGN.md`), and a chip
           * is a chip: the board draws it as a bordered count on the quiet
           * surface, and an underline inside that border reads as a second,
           * broken link rather than as one control.
           */}
          <Link className="flex-none no-underline" href={agentHref}>
            <span aria-hidden="true">{`+${String(overflow)}`}</span>
            <span className="sr-only">{`${String(overflow)} more connections`}</span>
          </Link>
        </Badge>
      )}
    </span>
  );
}
