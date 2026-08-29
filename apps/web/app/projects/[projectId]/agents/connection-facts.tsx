"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
 * Every way into one agent, or the fact that there is none.
 *
 * **"No connections yet" is a state of the agent, not an empty cell.** An agent
 * nobody has wired is an agent egma cannot test, and a row that simply left the
 * space blank would leave that to be found out at the start of a run. It is
 * quiet rather than a warning, because being unwired is a fact about setup and
 * not a failure anybody has had yet.
 *
 * **The overflow chip counts rather than lists, and opens what it counts.**
 * Two links, then "+3" — and pressing the chip drops a popover holding every
 * connection this agent has, each one a link to its own sheet (`IZJ-0`). It is
 * links and nothing else: no rename, no delete, no facts. There is no agent
 * page behind it any more, so a chip that only navigated would now have
 * nowhere honest to go.
 */
export function ConnectionsOnRow({
  connections,
  agentName,
  hrefOf,
}: {
  readonly connections: readonly ListedConnection[];
  /** Whose connections these are, for the control that says so out loud. */
  readonly agentName: string;
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
        <Popover>
          {/*
           * **The chip is not underlined, and the links beside it are.** A cell
           * link in this product wears an underline (`DESIGN.md`), and a chip
           * is a chip: the board draws it as a bordered count on the quiet
           * surface, and an underline inside that border reads as a second,
           * broken link rather than as one control.
           */}
          <PopoverTrigger asChild>
            <Badge asChild shape="count">
              <button className="flex-none cursor-pointer no-underline" type="button">
                <span aria-hidden="true">{`+${String(overflow)}`}</span>
                <span className="sr-only">
                  {`Show all ${String(connections.length)} connections for ${agentName}`}
                </span>
              </button>
            </Badge>
          </PopoverTrigger>
          {/*
           * 224px and 34px rows, off `IZJ-0`, and the panel grows from the chip
           * it was opened from — the origin `tailwind-theme.css` reads off
           * Radix for every popover in the product.
           */}
          <PopoverContent
            align="start"
            className="w-[224px] p-0 py-1.5"
            aria-label={`Connections for ${agentName}`}
          >
            <ul className="m-0 flex list-none flex-col p-0">
              {connections.map((one) => (
                <li key={one.id} className="contents">
                  <Link
                    className="flex min-h-[34px] items-center truncate px-4 text-sm text-foreground transition-colors duration-(--duration-hover) ease-out pointer-hover:bg-surface-soft"
                    href={hrefOf(one)}
                    title={one.name}
                  >
                    {one.name}
                  </Link>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </span>
  );
}
