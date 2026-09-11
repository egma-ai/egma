import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

import type { IngestionStore } from "@egma/ingestion";
import {
  presignedObjectUrl,
  type BlobStore,
} from "../../src/recordings/signed-link.ts";

/**
 * Start the deployed MinIO image to test signatures and storage permissions
 * on real requests. Suites report unavailable storage rather than substitute
 * a fake; required-storage runs fail through the helper below.
 */

export const MINIO_IMAGE = "quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z";

/**
 * The store's root credential, which is also what the simulator writes with.
 * Sentinels, so anything scanning output can tell them apart from the read-only
 * pair below — the whole point of this file is that the two are not the same
 * credential and cannot do the same things.
 */
const ROOT_ACCESS_KEY_ID = "SENTINEL-object-storage-key-id-6d19";
const ROOT_SECRET_ACCESS_KEY = "SENTINEL-object-storage-secret-3f8c1a9d47b2";

/** What the control plane holds: read, and nothing else. */
const READ_ACCESS_KEY_ID = "SENTINEL-read-only-key-id-4b71";
const READ_SECRET_ACCESS_KEY = "SENTINEL-read-only-secret-8c2fd05a91e6";

/**
 * What the ingestion path holds. A third credential, not a widening of either
 * pair above: it can write, read, list and delete inside one prefix of one
 * bucket, and it can do nothing at all to a recording. A sentinel like the
 * others, so a test that finds one of these strings in a sealed segment or in a
 * service's environment can say which credential leaked.
 */
const INGEST_ACCESS_KEY_ID = "SENTINEL-ingest-key-id-9e34";
const INGEST_SECRET_ACCESS_KEY = "SENTINEL-ingest-secret-2a75be08cf13";

export const BUCKET = "egma-recordings";

/** The second bucket on the same store. Never the recordings one. */
export const INGEST_BUCKET = "egma-ingestion";

/**
 * Allow only GetObject in the recording bucket, with no listing or writes.
 * deployment.test.ts compares this policy with the deployed copy.
 */
export const READ_ONLY_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: [`arn:aws:s3:::${BUCKET}/*`],
    },
  ],
} as const;

/**
 * Allow ingestion read, write, delete, and prefix-scoped listing only under
 * pending/ in the ingestion bucket. The credential must not reach recordings.
 * deployment.test.ts compares this policy with the deployed copy.
 */
export const INGEST_POLICY = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      Resource: [`arn:aws:s3:::${INGEST_BUCKET}/pending/*`],
    },
    {
      Effect: "Allow",
      Action: ["s3:ListBucket"],
      Resource: [`arn:aws:s3:::${INGEST_BUCKET}`],
      Condition: { StringLike: { "s3:prefix": ["pending/*"] } },
    },
  ],
} as const;

/** How long the image is given to arrive, and then the container to answer. */
const START_MILLISECONDS = 300_000;
const READY_MILLISECONDS = 60_000;

export type RunningObjectStorage = {
  readonly available: true;
  /** What the control plane is configured with: the read-only half. */
  readonly store: BlobStore;
  /** The write half, for putting a recording there in the first place. */
  readonly writeStore: BlobStore;
  /**
   * The ingestion bucket and the credential confined to its pending prefix —
   * the second bucket on the same store, as the deployment makes it.
   */
  readonly ingestStore: IngestionStore;
  /** Put bytes in the store under a key, and answer the reference. */
  put(key: string, body: Uint8Array): Promise<string>;
  stop(): void;
};

export type AbsentObjectStorage = {
  readonly available: false;
  /** Said out loud, so a skip is never silent. */
  readonly why: string;
};

export type ObjectStorage = RunningObjectStorage | AbsentObjectStorage;

/**
 * The setting a run uses to say that skipping is not an answer here.
 *
 * A contributor with no docker is promised the suite costs them nothing, and
 * that promise is why the recording suites skip. A gate is the other case: the
 * whole reason it exists is to prove the recording path, and a gate that went
 * green because the store was missing proves the opposite of what it claims. So
 * the gate sets this, and a missing store becomes a failure that names itself.
 */
export const REQUIRE_OBJECT_STORAGE = "EGMA_REQUIRE_OBJECT_STORAGE";

/** Off, absent, or plainly a no. Anything else means somebody asked. */
function required(env: NodeJS.ProcessEnv): boolean {
  const asked = env[REQUIRE_OBJECT_STORAGE];
  if (asked === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(asked.toLowerCase());
}

/**
 * No store, and what happens next: a visible skip, or a failure where the run
 * said a store had to be there.
 */
export function absentObjectStorage(
  why: string,
  env: NodeJS.ProcessEnv = process.env,
): AbsentObjectStorage {
  if (required(env)) {
    throw new Error(
      `${REQUIRE_OBJECT_STORAGE} is set, so the recording suites must prove ` +
        `themselves against a real object store rather than skip: ${why}`,
    );
  }
  return { available: false, why };
}

function run(
  command: string,
  argv: readonly string[],
  timeout: number,
): { ok: boolean; output: string } {
  const finished = spawnSync(command, [...argv], {
    encoding: "utf8",
    timeout,
  });
  return {
    ok: finished.status === 0,
    output: `${finished.stdout ?? ""}${finished.stderr ?? ""}${
      finished.error === undefined ? "" : String(finished.error.message)
    }`.trim(),
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("could not find a free port"));
        return;
      }
      probe.close(() => {
        resolve(address.port);
      });
    });
  });
}

async function answering(url: string, within: number): Promise<boolean> {
  const until = Date.now() + within;
  for (;;) {
    try {
      const answer = await fetch(url);
      if (answer.ok) return true;
    } catch {
      // Not up yet.
    }
    if (Date.now() > until) return false;
    await new Promise((resume) => setTimeout(resume, 250));
  }
}

/**
 * Start MinIO and provision the bucket and restricted credentials. Report
 * unavailability unless EGMA_REQUIRE_OBJECT_STORAGE requires setup to succeed.
 */
export async function startObjectStorage(
  label: string,
): Promise<ObjectStorage> {
  const port = await freePort();
  const name = `egma-test-minio-${label}-${process.pid}-${port}`;

  const started = run(
    "docker",
    [
      "run",
      "--rm",
      "--detach",
      "--name",
      name,
      "--publish",
      `127.0.0.1:${port}:9000`,
      "--env",
      `MINIO_ROOT_USER=${ROOT_ACCESS_KEY_ID}`,
      "--env",
      `MINIO_ROOT_PASSWORD=${ROOT_SECRET_ACCESS_KEY}`,
      MINIO_IMAGE,
      "server",
      "/data",
    ],
    START_MILLISECONDS,
  );
  if (!started.ok) {
    return absentObjectStorage(
      `docker would not start ${MINIO_IMAGE}, so the object-storage path is ` +
        `not proved here: ${started.output}`,
    );
  }

  const stop = (): void => {
    run("docker", ["rm", "--force", name], 60_000);
  };

  const endpoint = `http://127.0.0.1:${port}`;
  if (!(await answering(`${endpoint}/minio/health/cluster`, READY_MILLISECONDS))) {
    stop();
    return absentObjectStorage(
      `${MINIO_IMAGE} started but never answered its health probe at ` +
        `${endpoint}, so the object-storage path is not proved here`,
    );
  }

  // The bucket and the read-only user, through `mc` inside the container —
  // which is where the deployment does it too, and with the same commands.
  const provisioned = run(
    "docker",
    [
      "exec",
      name,
      "sh",
      "-c",
      [
        // `egma` here is the name `mc` files this store under on its own disk,
        // and every line below reaches the store by it. It is an identifier,
        // not the product's name: `main`'s identity sweep capitalized four of
        // these six at a3ab932 and left `mc mb egma/...` as it was, so the
        // alias the bucket was made under no longer existed and the bucket was
        // never created — every recording assertion in the browser lane failed
        // with `NoSuchBucket`, naming the store rather than this line.
        `mc alias set egma http://127.0.0.1:9000 ${ROOT_ACCESS_KEY_ID} ${ROOT_SECRET_ACCESS_KEY}`,
        `mc mb --ignore-existing egma/${BUCKET}`,
        `printf '%s' '${JSON.stringify(READ_ONLY_POLICY)}' > /tmp/read-recordings.json`,
        "mc admin policy create egma egma-read-recordings /tmp/read-recordings.json",
        `mc admin user add egma ${READ_ACCESS_KEY_ID} ${READ_SECRET_ACCESS_KEY}`,
        `mc admin policy attach egma egma-read-recordings --user ${READ_ACCESS_KEY_ID}`,
        // And the second bucket beside it, with its own user and its own
        // policy. Two buckets on one store is the deployment's shape, so it is
        // this file's shape too: a suite proving ingestion against a store that
        // held no recordings would not be proving that the two stay apart.
        `mc mb --ignore-existing egma/${INGEST_BUCKET}`,
        `printf '%s' '${JSON.stringify(INGEST_POLICY)}' > /tmp/ingestion.json`,
        "mc admin policy create egma egma-ingestion /tmp/ingestion.json",
        `mc admin user add egma ${INGEST_ACCESS_KEY_ID} ${INGEST_SECRET_ACCESS_KEY}`,
        `mc admin policy attach egma egma-ingestion --user ${INGEST_ACCESS_KEY_ID}`,
      ].join(" && "),
    ],
    READY_MILLISECONDS,
  );
  if (!provisioned.ok) {
    stop();
    return absentObjectStorage(
      "the object store started but its buckets and confined users could " +
        `not be made, so the object-storage path is not proved here: ${provisioned.output}`,
    );
  }

  const common = { publicUrl: endpoint, bucket: BUCKET, region: "us-east-1" };
  const writeStore: BlobStore = {
    ...common,
    accessKeyId: ROOT_ACCESS_KEY_ID,
    secretAccessKey: ROOT_SECRET_ACCESS_KEY,
  };

  return {
    available: true,
    store: {
      ...common,
      accessKeyId: READ_ACCESS_KEY_ID,
      secretAccessKey: READ_SECRET_ACCESS_KEY,
    },
    writeStore,
    ingestStore: {
      endpoint,
      bucket: INGEST_BUCKET,
      region: "us-east-1",
      accessKeyId: INGEST_ACCESS_KEY_ID,
      secretAccessKey: INGEST_SECRET_ACCESS_KEY,
    },
    async put(key, body) {
      // Through a presigned PUT with the *write* credential, which is the one
      // credential in this arrangement that is allowed to. It doubles as the
      // control: the same call with the read credential is what the refusal
      // test makes, so a `put` that stopped working would be a signer fault
      // rather than a permission one.
      const wrote = await fetch(
        presignedObjectUrl({
          store: writeStore,
          key,
          method: "PUT",
          at: new Date(),
          expiresInSeconds: 300,
        }),
        { method: "PUT", body },
      );
      if (!wrote.ok) {
        throw new Error(
          `the test store refused a recording: ${wrote.status} ${await wrote.text()}`,
        );
      }
      return key;
    },
    stop,
  };
}

/**
 * Generate a short stereo PCM WAV for browser decoding, duration, and seeking
 * tests. It is synthetic audio and does not prove recorded speaker content.
 */
export function aRecording(seconds = 1, sampleRateHertz = 8000): Uint8Array {
  const frames = seconds * sampleRateHertz;
  const bytesPerFrame = 2 * 2; // Two channels, sixteen bits each.
  const data = new DataView(new ArrayBuffer(44 + frames * bytesPerFrame));

  const ascii = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      data.setUint8(at + index, text.charCodeAt(index));
    }
  };

  ascii(0, "RIFF");
  data.setUint32(4, 36 + frames * bytesPerFrame, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM.
  data.setUint16(22, 2, true); // Two channels.
  data.setUint32(24, sampleRateHertz, true);
  data.setUint32(28, sampleRateHertz * bytesPerFrame, true);
  data.setUint16(32, bytesPerFrame, true);
  data.setUint16(34, 16, true);
  ascii(36, "data");
  data.setUint32(40, frames * bytesPerFrame, true);

  for (let frame = 0; frame < frames; frame += 1) {
    const at = 44 + frame * bytesPerFrame;
    // A tone on the left and quiet on the right, which is what one speaker to a
    // channel sounds like when only one of them is talking.
    const tone = Math.round(
      8000 * Math.sin((2 * Math.PI * 440 * frame) / sampleRateHertz),
    );
    data.setInt16(at, tone, true);
    data.setInt16(at + 2, 0, true);
  }

  return new Uint8Array(data.buffer);
}
