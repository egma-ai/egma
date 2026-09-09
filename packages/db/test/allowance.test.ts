import { describe, expect, it } from "vitest";

import {
  ALLOWANCE_KINDS,
  SHORTEST_BILLABLE_SECONDS,
  allowanceKindOf,
  allowancePeriodAt,
  allowanceUsedBy,
  billableSecondsOf,
  minutesFromSeconds,
  type AllowanceKind,
} from "../src/billing/allowance.ts";
import { CONNECTION_TYPES } from "../src/schema/agents.ts";
import type { ConnectionType, Modality } from "../src/schema/agents.ts";

/**
 * What a month of platform usage is, asked directly of the three rules that
 * define it. No store: a simulation row's frozen facts go in and a quantity
 * comes out, which is the whole reason these are one pure module.
 */

describe("which allowance a conversation is counted against", () => {
  const cases: readonly {
    readonly modality: Modality;
    readonly connectionType: ConnectionType;
    readonly kind: AllowanceKind;
  }[] = [
    // Chat is a chat simulation, whichever chat lane carried it.
    {
      modality: "chat",
      connectionType: "livekit_room",
      kind: "chat_simulations",
    },
    {
      modality: "chat",
      connectionType: "retell_text_mode",
      kind: "chat_simulations",
    },
    // Voice over a phone number is phone minutes: a carrier is charging for it.
    {
      modality: "voice",
      connectionType: "phone_number",
      kind: "phone_minutes",
    },
    // Every other voice lane is web-call minutes: nobody is.
    {
      modality: "voice",
      connectionType: "retell_web_call",
      kind: "web_call_minutes",
    },
    {
      modality: "voice",
      connectionType: "livekit_room",
      kind: "web_call_minutes",
    },
  ];

  for (const { modality, connectionType, kind } of cases) {
    it(`counts a ${modality} conversation over ${connectionType} as ${kind}`, () => {
      expect(allowanceKindOf({ modality, connectionType })).toBe(kind);
    });
  }

  it("has an answer for every lane the simulator can select", () => {
    for (const connectionType of CONNECTION_TYPES) {
      for (const modality of ["voice", "chat"] as const) {
        const kind = allowanceKindOf({ modality, connectionType });
        expect(ALLOWANCE_KINDS).toContain(kind);
      }
    }
  });

  it("counts a chat lane as chat even if its modality were voice", () => {
    // The modality decides first, so a lane that gains a chat variant later
    // cannot quietly start counting as minutes — and the reverse holds too:
    // the lane name alone never overrules what actually ran.
    expect(
      allowanceKindOf({ modality: "chat", connectionType: "phone_number" }),
    ).toBe("chat_simulations");
  });
});

describe("how many seconds one conversation counts", () => {
  const at = (seconds: number): { startedAt: Date; executionEndedAt: Date } => ({
    startedAt: new Date("2026-09-07T10:00:00.000Z"),
    executionEndedAt: new Date(
      new Date("2026-09-07T10:00:00.000Z").getTime() + seconds * 1_000,
    ),
  });

  const cases: readonly [string, number, number][] = [
    ["an instant conversation still counts the floor", 0, 10],
    ["a two-second conversation counts the floor", 2, 10],
    ["exactly the floor counts the floor", 10, 10],
    ["past the floor counts its own seconds", 11, 11],
    ["a part of a second is a whole second", 11.2, 12],
    ["a part of a second at the floor still counts the floor", 9.9, 10],
    ["a forty-second conversation counts forty, not sixty", 40, 40],
    ["a full minute counts sixty", 60, 60],
    ["an unanswered ring counts its wait", 30, 30],
    ["the ten-minute ceiling counts its whole self", 600, 600],
  ];

  for (const [what, seconds, counted] of cases) {
    it(what, () => {
      expect(billableSecondsOf(at(seconds))).toBe(counted);
    });
  }

  it("counts nothing for a conversation that never began", () => {
    expect(billableSecondsOf({ startedAt: null, executionEndedAt: null })).toBe(0);
  });

  it("counts nothing for a conversation still running", () => {
    expect(
      billableSecondsOf({
        startedAt: new Date("2026-09-07T10:00:00.000Z"),
        executionEndedAt: null,
      }),
    ).toBe(0);
  });

  it("counts the floor for a span whose clock went backwards", () => {
    expect(billableSecondsOf(at(-30))).toBe(SHORTEST_BILLABLE_SECONDS);
  });

  it("turns seconds into minutes once, at the end", () => {
    // Ninety seconds is a minute and a half. Two forty-five-second
    // conversations are also a minute and a half — dividing each one first and
    // adding the halves is the same number here and stops being the same
    // number the moment a floor is applied to each, which is why the sum is
    // taken in seconds.
    expect(minutesFromSeconds(90)).toBe(1.5);
    expect(minutesFromSeconds(billableSecondsOf(at(45)) * 2)).toBe(1.5);
  });
});

describe("how much of an allowance one conversation used", () => {
  const span = {
    startedAt: new Date("2026-09-07T10:00:00.000Z"),
    executionEndedAt: new Date("2026-09-07T10:01:30.000Z"),
  };

  it("counts a chat as one simulation at its start, not its length", () => {
    expect(
      allowanceUsedBy({
        modality: "chat",
        connectionType: "livekit_room",
        ...span,
      }),
    ).toEqual({ kind: "chat_simulations", used: 1 });
  });

  it("counts a chat that never began as nothing", () => {
    expect(
      allowanceUsedBy({
        modality: "chat",
        connectionType: "livekit_room",
        startedAt: null,
        executionEndedAt: null,
      }),
    ).toEqual({ kind: "chat_simulations", used: 0 });
  });

  it("counts a voice conversation in minutes", () => {
    expect(
      allowanceUsedBy({
        modality: "voice",
        connectionType: "phone_number",
        ...span,
      }),
    ).toEqual({ kind: "phone_minutes", used: 1.5 });
  });
});

describe("when an organization's month turns over", () => {
  const period = (anchor: string, at: string) =>
    allowancePeriodAt(new Date(anchor), new Date(at));

  it("begins on the anchor's own day and time", () => {
    expect(period("2026-01-12T09:30:00.000Z", "2026-03-04T12:00:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-02-12T09:30:00.000Z"),
        resetsAt: new Date("2026-03-12T09:30:00.000Z"),
      },
    );
  });

  it("puts the anchor instant itself in the first period", () => {
    expect(period("2026-01-12T09:30:00.000Z", "2026-01-12T09:30:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-01-12T09:30:00.000Z"),
        resetsAt: new Date("2026-02-12T09:30:00.000Z"),
      },
    );
  });

  it("puts the reset instant itself in the next period", () => {
    // Exclusive at the top: a conversation begun at the reset is next month's,
    // so no instant is counted in two months and none is counted in neither.
    expect(period("2026-01-12T09:30:00.000Z", "2026-02-12T09:30:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-02-12T09:30:00.000Z"),
        resetsAt: new Date("2026-03-12T09:30:00.000Z"),
      },
    );
  });

  it("clamps a 31st into a short month", () => {
    expect(period("2026-01-31T00:00:00.000Z", "2026-02-15T00:00:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-01-31T00:00:00.000Z"),
        resetsAt: new Date("2026-02-28T00:00:00.000Z"),
      },
    );
  });

  it("clamps into February and then goes back to the 31st", () => {
    // The clamp applies to the month being computed and never moves the
    // anchor, so one short February cannot walk a customer's date backwards
    // for the rest of their life.
    expect(period("2026-01-31T00:00:00.000Z", "2026-03-15T00:00:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-02-28T00:00:00.000Z"),
        resetsAt: new Date("2026-03-31T00:00:00.000Z"),
      },
    );
    expect(period("2026-01-31T00:00:00.000Z", "2026-04-15T00:00:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-03-31T00:00:00.000Z"),
        resetsAt: new Date("2026-04-30T00:00:00.000Z"),
      },
    );
  });

  it("knows a leap February", () => {
    expect(period("2028-01-31T00:00:00.000Z", "2028-02-15T00:00:00.000Z")).toEqual(
      {
        startedAt: new Date("2028-01-31T00:00:00.000Z"),
        resetsAt: new Date("2028-02-29T00:00:00.000Z"),
      },
    );
  });

  it("crosses a year", () => {
    expect(period("2026-11-20T14:00:00.000Z", "2027-01-05T00:00:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-12-20T14:00:00.000Z"),
        resetsAt: new Date("2027-01-20T14:00:00.000Z"),
      },
    );
  });

  it("answers the first period for an instant before the anchor", () => {
    expect(period("2026-09-07T00:00:00.000Z", "2026-08-01T00:00:00.000Z")).toEqual(
      {
        startedAt: new Date("2026-09-07T00:00:00.000Z"),
        resetsAt: new Date("2026-10-07T00:00:00.000Z"),
      },
    );
  });

  it("leaves no gap and no overlap between one period and the next", () => {
    // Walked for four years from a 31st anchor, which is where every clamping
    // rule that is nearly right stops being right.
    const anchor = new Date("2026-01-31T23:59:59.999Z");
    let at = anchor;
    for (let month = 0; month < 48; month += 1) {
      const current = allowancePeriodAt(anchor, at);
      expect(current.startedAt.getTime()).toBeLessThanOrEqual(at.getTime());
      expect(current.resetsAt.getTime()).toBeGreaterThan(at.getTime());

      // The period the reset instant falls in begins exactly where this one
      // ended: no instant belongs to two months, and none belongs to neither.
      const next = allowancePeriodAt(anchor, current.resetsAt);
      expect(next.startedAt).toEqual(current.resetsAt);
      at = current.resetsAt;
    }
  });
});
