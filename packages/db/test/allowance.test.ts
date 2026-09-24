import { describe, expect, it } from "vitest";

import {
  allowanceKindOf,
  allowancePeriodAt,
  billableSecondsOf,
  minutesFromSeconds,
  type AllowanceKind,
} from "../src/billing/allowance.ts";
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
    // Voice over a phone number is phone minutes: a carrier is charging for it.
    {
      modality: "voice",
      connectionType: "phone_number",
      kind: "phone_minutes",
    },
    // Every other voice lane is web-call minutes: nobody is.
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
