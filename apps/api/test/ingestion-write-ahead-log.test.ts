import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  IngestionBackpressureError,
  openWriteAheadLog,
} from "../src/ingestion/write-ahead-log.ts";

/**
 * The staging log, put through the two things that happen to it: an unclean
 * stop, and more evidence than it was told it may hold.
 *
 * Both are proved against a real directory rather than an in-memory stand-in.
 * Everything interesting here is a property of bytes on a disk — a length that
 * was written when the payload was not, a file that ends in the middle of a
 * frame, a checksum that no longer matches what follows it — and a fake would
 * agree with whatever this code believed about all three.
 *
 * The tear is made the way a power cut makes one: the file is written and then
 * cut short, or a byte in it is changed. Nothing here asks the log to tell it
 * where the damage is; it is opened again and asked what it has, which is
 * exactly what a restart does.
 */

const BOUNDS = {
  maxBytes: 1_000_000,
  maxRecords: 1_000,
  maxFileBytes: 4_096,
};

const directories: string[] = [];

function aDirectory(): string {
  const made = mkdtempSync(path.join(tmpdir(), "egma-ingestion-log-"));
  directories.push(made);
  return made;
}

function bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function text(payload: Uint8Array): string {
  return Buffer.from(payload).toString("utf8");
}

function filesIn(directory: string): string[] {
  return readdirSync(directory).sort();
}

afterEach(() => {
  // A directory per case, removed here so a developer's temp directory does not
  // fill up over a week of runs.
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("staged evidence across a restart", () => {
  it("hands back every complete record the last process wrote", () => {
    const directory = aDirectory();

    const first = openWriteAheadLog(directory, BOUNDS);
    first.append(bytes("one"));
    first.append(bytes("two"));
    first.append(bytes("three"));
    first.close();

    const second = openWriteAheadLog(directory, BOUNDS);
    expect(second.staged().map((entry) => text(entry.payload))).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(second.records).toBe(3);
  });

  it("keeps what was whole and isolates a tail that was cut in half", () => {
    // A frame whose length says more bytes are coming than the file holds.
    // Reading the length and trusting it is what walks recovery off the end of
    // the file; the point of the frame header is that the answer is knowable.
    const directory = aDirectory();

    const first = openWriteAheadLog(directory, BOUNDS);
    first.append(bytes("the conversation that finished"));
    first.append(bytes("the conversation that did not"));
    first.close();

    const [file] = filesIn(directory);
    const whole = readFileSync(path.join(directory, file as string));
    writeFileSync(
      path.join(directory, file as string),
      whole.subarray(0, whole.length - 7),
    );

    const second = openWriteAheadLog(directory, BOUNDS);
    expect(second.staged().map((entry) => text(entry.payload))).toEqual([
      "the conversation that finished",
    ]);

    // The bytes that made the gap are still there, under a name nothing reads.
    // An operator meeting a hole gets to see what made it.
    expect(filesIn(directory)).toContain(`${file as string}.torn`);
    expect(
      readFileSync(path.join(directory, `${file as string}.torn`)).length,
    ).toBeGreaterThan(0);
  });

  it("stops at a frame whose checksum no longer matches its payload", () => {
    // The failure a length alone cannot see: every frame is the right size and
    // one of them is not what was written. Without the checksum this record
    // would be handed on as evidence, changed, with nothing saying so.
    const directory = aDirectory();

    const first = openWriteAheadLog(directory, BOUNDS);
    first.append(bytes("first"));
    const damaged = first.append(bytes("second"));
    first.append(bytes("third"));
    first.close();

    const [file] = filesIn(directory);
    const held = readFileSync(path.join(directory, file as string));
    held[damaged.offset + 8] = (held[damaged.offset + 8] as number) ^ 0xff;
    writeFileSync(path.join(directory, file as string), held);

    const second = openWriteAheadLog(directory, BOUNDS);
    expect(second.staged().map((entry) => text(entry.payload))).toEqual([
      "first",
    ]);
    expect(filesIn(directory)).toContain(`${file as string}.torn`);
  });

  it("never invents a record out of a frame it could not read", () => {
    // Bytes that are not a log at all. The one answer that must never come back
    // is a plausible record: a log that guessed would put evidence nobody sent
    // into a customer's trace.
    const directory = aDirectory();
    writeFileSync(path.join(directory, "00000001.log"), Buffer.alloc(64, 0x41));

    const log = openWriteAheadLog(directory, BOUNDS);
    expect(log.staged()).toEqual([]);
    expect(log.records).toBe(0);
  });

  it("reads a frame that was appended after an isolated tail", () => {
    // Recovery truncates and then a new file takes the appends, so a record
    // staged after a crash cannot end up sitting past a hole in the file the
    // crash damaged.
    const directory = aDirectory();

    const first = openWriteAheadLog(directory, BOUNDS);
    first.append(bytes("before the crash"));
    first.close();

    const [file] = filesIn(directory);
    const whole = readFileSync(path.join(directory, file as string));
    writeFileSync(
      path.join(directory, file as string),
      Buffer.concat([whole, Buffer.from([0, 0, 0, 9, 1, 2, 3])]),
    );

    const second = openWriteAheadLog(directory, BOUNDS);
    second.append(bytes("after the crash"));
    second.close();

    const third = openWriteAheadLog(directory, BOUNDS);
    expect(third.staged().map((entry) => text(entry.payload))).toEqual([
      "before the crash",
      "after the crash",
    ]);
  });

  it("keeps the complete records in a file written after a damaged one", () => {
    // Damage in an older file costs the records inside it and no more. Dropping
    // the newer files behind it would turn one lost region into every lost
    // record after it, which is the more expensive of the two mistakes.
    const directory = aDirectory();

    const first = openWriteAheadLog(directory, { ...BOUNDS, maxFileBytes: 16 });
    first.append(bytes("older file"));
    first.append(bytes("newer file"));
    first.close();

    const [older, newer] = filesIn(directory);
    expect(newer, "the bound rolled a second file").not.toBeUndefined();
    const held = readFileSync(path.join(directory, older as string));
    held[held.length - 1] = (held[held.length - 1] as number) ^ 0xff;
    writeFileSync(path.join(directory, older as string), held);

    const second = openWriteAheadLog(directory, BOUNDS);
    expect(second.staged().map((entry) => text(entry.payload))).toEqual([
      "newer file",
    ]);
  });
});

describe("a log that has been told what it may hold", () => {
  it("refuses past the byte bound and discards nothing to make room", () => {
    const directory = aDirectory();
    const log = openWriteAheadLog(directory, {
      ...BOUNDS,
      maxBytes: 64,
    });

    log.append(bytes("a".repeat(20)));
    log.append(bytes("b".repeat(20)));
    const held = log.staged().map((entry) => text(entry.payload));

    expect(() => log.append(bytes("c".repeat(20)))).toThrow(
      IngestionBackpressureError,
    );

    // The whole reason the refusal exists. An overloaded Egma that dropped the
    // oldest staged record to answer this request would look healthy and would
    // have lost evidence it already took responsibility for.
    expect(log.staged().map((entry) => text(entry.payload))).toEqual(held);
    expect(log.records).toBe(2);
  });

  it("refuses past the record bound, because records are not one size", () => {
    const directory = aDirectory();
    const log = openWriteAheadLog(directory, { ...BOUNDS, maxRecords: 2 });

    log.append(bytes("one"));
    log.append(bytes("two"));

    expect(() => log.append(bytes("three"))).toThrow(IngestionBackpressureError);
    expect(log.records).toBe(2);
  });

  it("says which bound it met, and that nothing was thrown away", () => {
    // The sentence a `503` is built out of. An operator reading it has to be
    // able to tell backpressure from a lost disk without reading this file.
    const directory = aDirectory();
    const log = openWriteAheadLog(directory, { ...BOUNDS, maxRecords: 1 });
    log.append(bytes("one"));

    expect(() => log.append(bytes("two"))).toThrow(/staged records/u);
    expect(() => log.append(bytes("two"))).toThrow(/has been discarded/u);
  });

  it("takes evidence again once what was staged has become durable", () => {
    const directory = aDirectory();
    const log = openWriteAheadLog(directory, { ...BOUNDS, maxRecords: 2 });

    const first = log.append(bytes("one"));
    log.append(bytes("two"));
    expect(() => log.append(bytes("three"))).toThrow(IngestionBackpressureError);

    log.release([first]);
    expect(() => log.append(bytes("three"))).not.toThrow();
  });

  it("deletes a sealed file only when every record in it is durable", () => {
    // Compaction is the deletion of a whole sealed file and nothing else. A log
    // that rewrote a file to reclaim part of it would stop being a
    // write-ahead log.
    const directory = aDirectory();
    const log = openWriteAheadLog(directory, { ...BOUNDS, maxFileBytes: 40 });

    const first = log.append(bytes("aaaaaaaaaa"));
    const second = log.append(bytes("bbbbbbbbbb"));
    log.append(bytes("cccccccccc"));
    const before = filesIn(directory).length;
    expect(before).toBeGreaterThan(1);

    log.release([first]);
    expect(filesIn(directory).length).toBe(before);

    log.release([second]);
    expect(filesIn(directory).length).toBe(before - 1);
    expect(log.staged().map((entry) => text(entry.payload))).toEqual([
      "cccccccccc",
    ]);
  });
});

describe("the frame a record is written in", () => {
  it("is a length, a checksum of the payload, and the payload", () => {
    // The one place this suite reads the bytes rather than the behaviour. The
    // frame layout is what a recovery in another language, or a repair by hand,
    // would have to know; it is written down here so that changing it is a
    // decision rather than an accident.
    const directory = aDirectory();
    const log = openWriteAheadLog(directory, BOUNDS);
    log.append(bytes("evidence"));
    log.close();

    const [file] = filesIn(directory);
    const held = readFileSync(path.join(directory, file as string));

    expect(held.readUInt32BE(0)).toBe("evidence".length);
    expect(held.readUInt32BE(4)).toBe(crc32(Buffer.from("evidence", "utf8")));
    expect(held.subarray(8).toString("utf8")).toBe("evidence");
  });
});
