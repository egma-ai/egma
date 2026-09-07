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
 * Open connection sheets from the agent row using the list response; no
 * additional request is needed to build these links.
 */

/**
 * Show two connection links and an overflow popover containing all connections.
 * Use an explicit empty label when the agent has none.
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
