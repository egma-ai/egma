import { spawnSync } from "node:child_process";
import { createServer } from "node:net";

import {
  presignedObjectUrl,
  type BlobStore,
} from "../../src/recordings/signed-link.ts";

/**
 * A real object store, with a real read-only credential in it.
 *
 * There is no fake here and there cannot be one. Everything that goes wrong
 * between a signer and an object store goes wrong on the wire — a signature
 * computed over the wrong host, a query parameter sorted the wrong way, an
 * expiry the store disagrees about, a credential that turns out to be allowed to
 * write — and a stand-in would agree with whatever this code believed about all
 * four. What runs is MinIO, in a container, and where one cannot be started the
 * suites that need it **skip and say so**, which is the promise ticket 01 made a
 * contributor: running the tests costs them no new infrastructure.
 *
 * The image is the one the compose file deploys. Proving the signing path
 * against a store nobody runs would prove it about the wrong store the first
 * time the two drifted.
 */

export const MINIO_IMAGE = "minio/minio:RELEASE.2025-09-07T16-13-09Z";

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

export const BUCKET = "egma-recordings";

/**
 * The policy the read-only credential is given, written the way the compose
 * file's bucket job writes it: one action, one bucket, no listing.
 *
 * `s3:GetObject` and nothing else. Not `s3:*`, not `s3:GetObject` plus
 * `s3:PutObject` "for later", and not `s3:ListBucket` — a credential that can
 * list is a credential that can enumerate every recording a deployment holds,
 * and nothing in the product ever asks the store a question: it is handed a
 * reference by a row it has already checked the reader against.
 *
 * `deployment.test.ts` holds the compose file's own copy against this one, so
 * the two cannot drift into proving different things.
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

/** How long the image is given to arrive, and then the container to answer. */
const START_MILLISECONDS = 300_000;
const READY_MILLISECONDS = 60_000;

export type RunningObjectStorage = {
  readonly available: true;
  /** What the control plane is configured with: the read-only half. */
  readonly store: BlobStore;
  /** The write half, for putting a recording there in the first place. */
  readonly writeStore: BlobStore;
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
 * One MinIO of this file's own, with the bucket made and the read-only user
 * created — the same three `mc admin` steps the deployment's bucket job runs.
 *
 * Every way this can fail answers `available: false` with a sentence rather
 * than throwing. A contributor with no docker was promised the suite costs them
 * nothing, and a red line here would be this arrangement breaking that promise
 * rather than the code breaking anything. A run that sets
 * `EGMA_REQUIRE_OBJECT_STORAGE` has said the opposite — see
 * `absentObjectStorage` above — and gets the red line it asked for.
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
  if (!(await answering(`${endpoint}/minio/health/live`, READY_MILLISECONDS))) {
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
      ].join(" && "),
    ],
    READY_MILLISECONDS,
  );
  if (!provisioned.ok) {
    stop();
    return absentObjectStorage(
      "the object store started but its bucket and read-only user could " +
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
 * A recording, as a browser meets one: a dual-channel PCM WAV, the person
 * calling on the left and the agent under test on the right, at the narrow band
 * a telephone carries.
 *
 * Synthesised rather than captured, because what these suites ask of it is that
 * a real browser can load it, report a duration and seek inside it — for which
 * a second of real audio is exactly as good as a real call and about four
 * hundred times smaller. What a recording *contains* is proved where it is
 * written, at the simulator's contract seam, which reads it back and transcribes
 * each channel.
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
