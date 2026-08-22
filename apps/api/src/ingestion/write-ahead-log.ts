import {
  closeSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { crc32 } from "node:zlib";

/**
 * The bounded local log evidence is staged in between being accepted and being
 * durable, and the only thing that survives an unclean stop.
 *
 * It exists for four reasons and no others: to group small arrivals into one
 * segment worth uploading, to give the process something to come back to after
 * a crash it did not choose, to make overload an explicit refusal instead of a
 * silent loss, and to hold a sealed segment's identity so an ambiguous upload
 * reaches for the same object rather than inventing a second one. **It is not
 * the acknowledgement boundary** — nothing here has been promised to a customer
 * — and it is not a query store. What it holds is on its way somewhere.
 *
 * ## A frame, and why the length and the checksum are both there
 *
 * `[u32 length][u32 CRC32 of the payload][payload]`, big-endian, appended and
 * never rewritten. The length alone would let recovery walk the file, and would
 * also let a half-written length walk it straight off a cliff — a torn write
 * that landed four plausible bytes claims a payload that is not there, and the
 * next frame boundary is then wherever those bytes said. The checksum is what
 * separates *a complete frame* from *four bytes that look like one*, which is
 * the one question recovery has to answer after a power cut. CRC32 rather than
 * a cryptographic digest because the question is integrity of a local file, not
 * identity of evidence: the durable content hash is over the record and lives
 * in `record.ts`.
 *
 * ## What recovery may and may not do
 *
 * It reads forward, keeps every frame whose checksum holds, and stops at the
 * first frame that is short or fails its checksum. It never repairs a frame,
 * never re-reads a damaged region hoping for a boundary further on, and never
 * synthesises a record — a log that invented evidence would be worse than one
 * that lost some, because the loss is visible and the invention is not.
 *
 * The damaged tail is **isolated rather than deleted**: its bytes are moved
 * beside the file with a `.torn` suffix and the file is truncated at the last
 * good boundary. Nothing reads a `.torn` file again. It is there so that the
 * operator meeting a gap has the bytes that made it, which is the same rule the
 * ingestion bucket follows for an object it cannot process.
 *
 * Reading then continues with the next file. Damage in an older sealed file
 * costs the records inside it and no more; dropping the newer complete files
 * behind it would turn one lost region into every lost record after it.
 *
 * ## Rolling files, and why they are files rather than one file
 *
 * One active file takes appends. When the next frame would carry it past
 * `maxFileBytes` it is sealed and a new one starts. A sealed file whose every
 * frame has reached the object store is deleted whole — that is the entire
 * compaction story, and it is the reason there is more than one file: a single
 * growing file can only be compacted by rewriting it, and rewriting a
 * write-ahead log is how a write-ahead log stops being one.
 *
 * ## Durability, and the one place it is bought
 *
 * An append reaches the operating system immediately and the disk when the
 * caller asks. `sync()` is called before a segment is uploaded, so what the log
 * promises is: anything that reached the object store was on this disk first.
 * Paying for a disk flush on every appended record would buy nothing that
 * matters — a record lost with the process before the segment holding it was
 * ever sealed was never acknowledged to anybody.
 */

/** `[u32 length][u32 CRC32]` in front of every payload. */
const FRAME_HEADER_BYTES = 8;

/** The active file, and the sealed ones behind it. */
const LOG_SUFFIX = ".log";

/** Where a damaged tail is put so that nothing reads it and nobody loses it. */
const ISOLATED_SUFFIX = ".torn";

/** Zero-padded so a plain lexicographic sort of the directory is age order. */
const LOG_FILE_PATTERN = /^[0-9]{8}\.log$/u;
const ORDINAL_DIGITS = 8;

/**
 * The log will not take more, and says so.
 *
 * Raised rather than answered, and raised **before** anything is written, so
 * the refusal is the whole outcome: nothing older is discarded to make room, no
 * partial frame reaches the file, and the caller's own retryable refusal is the
 * only thing the sender sees. A discard would make an overloaded Egma look
 * healthy while losing the evidence it already staged, which is the one failure
 * this whole path exists to rule out.
 */
export class IngestionBackpressureError extends Error {}

/** What the log will hold before it starts refusing. */
export type WriteAheadLogBounds = {
  /** Across every file, including sealed ones not yet compacted. */
  readonly maxBytes: number;
  /** Frames staged and not yet released. Records vary in size; both bounds bind. */
  readonly maxRecords: number;
  /** Where the active file is sealed and a new one started. */
  readonly maxFileBytes: number;
};

/** One staged payload, and where in the log it is. */
export type StagedEntry = {
  /** The file's name inside the log directory, never a path. */
  readonly file: string;
  /** The frame's own offset, which is what makes an entry addressable. */
  readonly offset: number;
  readonly payload: Uint8Array;
};

export type WriteAheadLog = {
  /**
   * Append one payload. Answers where it landed, so a caller that later
   * confirms durability can name exactly what it confirmed.
   */
  append(payload: Uint8Array): StagedEntry;
  /**
   * Whether one more frame carrying this many payload bytes would still fit.
   *
   * The same judgment `append` makes, asked without writing anything — and it
   * is the same judgment because `append` asks this. A caller deciding whether
   * this log will take more evidence must not re-derive the rule from `bytes`
   * and the bound it was opened with: the bound is on frames, a frame is the
   * payload plus this log's own header, and a caller comparing usage against
   * the bound would call a log writable while the very next append refused it.
   */
  accepts(payloadBytes: number): boolean;
  /** Everything staged and not yet released, oldest first. */
  staged(): readonly StagedEntry[];
  /**
   * Say that these entries are durable somewhere else. A sealed file whose
   * every frame has been released is deleted; the active file stays, because it
   * is still being appended to.
   */
  release(entries: readonly StagedEntry[]): void;
  /** Push what has been appended to the disk. Called before an upload starts. */
  sync(): void;
  close(): void;
  /** Bytes across every file this log owns, sealed ones included. */
  readonly bytes: number;
  /** Frames staged and not yet released. */
  readonly records: number;
};

type LogFile = {
  readonly name: string;
  bytes: number;
  /** Offsets of frames not yet released. Empty and sealed means the file can go. */
  readonly staged: Set<number>;
  sealed: boolean;
};

function frameFor(payload: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  frame.writeUInt32BE(crc32(payload), 4);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    frame,
    FRAME_HEADER_BYTES,
  );
  return frame;
}

function nameFor(ordinal: number): string {
  return `${String(ordinal).padStart(ORDINAL_DIGITS, "0")}${LOG_SUFFIX}`;
}

/**
 * One file, read forward until the first frame that is not whole.
 *
 * Answers the complete frames and the byte offset the damage starts at, which
 * is `undefined` where the file ended cleanly. A zero-length payload is a legal
 * frame and is read as one; refusing it here would make the log's rules depend
 * on what a caller happened to be staging.
 */
function framesIn(
  file: string,
  bytes: Buffer,
): {
  readonly frames: readonly StagedEntry[];
  readonly damagedFrom: number | undefined;
} {
  const frames: StagedEntry[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + FRAME_HEADER_BYTES > bytes.length) break;
    const length = bytes.readUInt32BE(at);
    const checksum = bytes.readUInt32BE(at + 4);
    const from = at + FRAME_HEADER_BYTES;
    if (from + length > bytes.length) break;
    const payload = bytes.subarray(from, from + length);
    if (crc32(payload) !== checksum) break;
    frames.push({ file, offset: at, payload: new Uint8Array(payload) });
    at = from + length;
  }
  return { frames, damagedFrom: at === bytes.length ? undefined : at };
}

/** Write a whole buffer, however many calls the operating system wants. */
function writeWhole(handle: number, frame: Buffer): void {
  let written = 0;
  while (written < frame.byteLength) {
    written += writeSync(handle, frame, written, frame.byteLength - written);
  }
}

/**
 * Open the log at a directory, recovering whatever the last stop left there.
 *
 * The directory is made if it is absent, so a fresh deployment and a restarted
 * one take the same path. Everything else about recovery is described at the
 * top of this file.
 */
export function openWriteAheadLog(
  directory: string,
  bounds: WriteAheadLogBounds,
): WriteAheadLog {
  mkdirSync(directory, { recursive: true });

  const files: LogFile[] = [];
  const entries: StagedEntry[] = [];

  const present = readdirSync(directory)
    .filter((name) => LOG_FILE_PATTERN.test(name))
    .sort();

  for (const name of present) {
    const where = path.join(directory, name);
    const held = readFileSync(where);
    const { frames, damagedFrom } = framesIn(name, held);
    if (damagedFrom !== undefined) {
      writeFileSync(`${where}${ISOLATED_SUFFIX}`, held.subarray(damagedFrom));
      const handle = openSync(where, "r+");
      ftruncateSync(handle, damagedFrom);
      fsyncSync(handle);
      closeSync(handle);
    }
    const bytes = damagedFrom ?? held.length;
    if (bytes === 0) {
      // Nothing complete in it and nothing to isolate that was not isolated
      // just now. Leaving an empty file would leave it empty forever: it can
      // never be compacted, because compaction is the release of frames it does
      // not have.
      rmSync(where, { force: true });
      continue;
    }
    files.push({
      name,
      bytes,
      staged: new Set(frames.map((frame) => frame.offset)),
      sealed: true,
    });
    entries.push(...frames);
  }

  // Recovery never appends to a file it read back, even one with room left. The
  // last frame of a recovered file is the last thing the previous process is
  // known to have written whole; starting a fresh file means a torn region that
  // was isolated above can never be written over by a frame that would then sit
  // past a hole.
  const last = files[files.length - 1];
  let ordinal = last === undefined ? 0 : Number(last.name.slice(0, ORDINAL_DIGITS));

  let active: LogFile | undefined;
  let handle: number | undefined;

  const totalBytes = (): number =>
    files.reduce((sum, file) => sum + file.bytes, 0);
  const totalRecords = (): number =>
    files.reduce((sum, file) => sum + file.staged.size, 0);

  const sealTheActiveFile = (): void => {
    if (handle !== undefined) {
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
    }
    if (active !== undefined) {
      active.sealed = true;
      active = undefined;
    }
  };

  // Both bounds, said once. The byte bound counts the frame that would be
  // written rather than the payload — the log's disk cost is frames, and a
  // bound that measured payloads would be exceeded by exactly the amount
  // nobody counted.
  const roomForBytes = (payloadBytes: number): boolean =>
    totalBytes() + FRAME_HEADER_BYTES + payloadBytes <= bounds.maxBytes;
  const roomForOneRecord = (): boolean =>
    totalRecords() + 1 <= bounds.maxRecords;

  return {
    accepts(payloadBytes) {
      return roomForBytes(payloadBytes) && roomForOneRecord();
    },

    append(payload) {
      const frame = frameFor(payload);

      // Checked before the file is touched, and by the same two predicates
      // anyone asking "will this log take more" is answered with.
      if (!roomForBytes(payload.byteLength)) {
        throw new IngestionBackpressureError(
          `the local ingestion log holds ${totalBytes()} bytes and its bound is ` +
            `${bounds.maxBytes}, so this evidence cannot be staged. Nothing ` +
            `already staged has been discarded to make room for it.`,
        );
      }
      if (!roomForOneRecord()) {
        throw new IngestionBackpressureError(
          `the local ingestion log holds ${totalRecords()} staged records and ` +
            `its bound is ${bounds.maxRecords}, so this evidence cannot be ` +
            `staged. Nothing already staged has been discarded to make room ` +
            `for it.`,
        );
      }

      // A frame larger than the file bound still gets a file of its own rather
      // than a refusal: the file bound is a compaction unit, and refusing a
      // record for being bigger than one would be a size limit nobody declared.
      if (
        active !== undefined &&
        active.bytes > 0 &&
        active.bytes + frame.byteLength > bounds.maxFileBytes
      ) {
        sealTheActiveFile();
      }
      if (active === undefined) {
        ordinal += 1;
        const name = nameFor(ordinal);
        handle = openSync(path.join(directory, name), "ax");
        active = { name, bytes: 0, staged: new Set(), sealed: false };
        files.push(active);
      }

      const file = active;
      const offset = file.bytes;
      writeWhole(handle as number, frame);
      file.bytes += frame.byteLength;
      file.staged.add(offset);

      const entry: StagedEntry = { file: file.name, offset, payload };
      entries.push(entry);
      return entry;
    },

    staged() {
      // Filtered out of the arrival-ordered list rather than walked out of the
      // files, so the answer is in the order evidence was staged — which is the
      // order a segment's records are sealed in, and therefore what makes a
      // re-grouped retry produce the same bytes.
      const held = new Map(files.map((file) => [file.name, file]));
      const alive: StagedEntry[] = [];
      for (const entry of entries) {
        if (held.get(entry.file)?.staged.has(entry.offset) === true) {
          alive.push(entry);
        }
      }
      return alive;
    },

    release(released) {
      const held = new Map(files.map((file) => [file.name, file]));
      for (const entry of released) {
        held.get(entry.file)?.staged.delete(entry.offset);
      }
      for (const file of [...files]) {
        if (!file.sealed || file.staged.size > 0) continue;
        rmSync(path.join(directory, file.name), { force: true });
        files.splice(files.indexOf(file), 1);
        // The entries of a deleted file are gone with it. Left in the arrival
        // list they would make every later `staged()` walk records that no
        // longer exist, and the list is walked on every flush.
        for (let at = entries.length - 1; at >= 0; at -= 1) {
          if (entries[at]?.file === file.name) entries.splice(at, 1);
        }
      }
    },

    sync() {
      if (handle !== undefined) fsyncSync(handle);
    },

    close() {
      sealTheActiveFile();
    },

    get bytes() {
      return totalBytes();
    },

    get records() {
      return totalRecords();
    },
  };
}
