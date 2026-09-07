import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { PENDING_PREFIX, type SealedSegment } from "./segment.ts";

/**
 * Read, list, create, and delete pending ingestion segments through the S3 SDK.
 * Use path-style addressing for stores without per-bucket hostnames.
 *
 * Retries reuse the sealed segment's key and bytes. If-None-Match: * prevents
 * replacement; an existing object succeeds only when its bytes match. Compare
 * bytes, not ETags, whose meaning varies with storage settings. Different bytes
 * under the same segment ID are an internal defect.
 */

/** Where the ingestion bucket is, and the credential confined to it. */
export type IngestionStore = {
  /**
   * The address **this process** reaches the store at, which is the opposite of
   * `BlobStore.publicUrl` next door: nothing signs a link for a browser here,
   * and the API opens the connection itself.
   */
  readonly endpoint: string;
  readonly bucket: string;
  /** What to sign for. MinIO ignores it; S3 refuses one signed for another. */
  readonly region: string;
  /**
   * A credential confined to this bucket's pending prefix. It is never the
   * recordings read credential and never the recordings write credential — one
   * workload must not be able to read, delete or expire the other's objects.
   */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
};

/** One object found by a listing of the pending prefix. */
export type PendingObject = {
  readonly key: string;
  readonly bytes: number;
};

/**
 * One segment identity holding two different sets of bytes.
 *
 * An internal defect, and it is raised rather than answered so that no caller
 * can mistake it for an upload failure and retry into it. The object already in
 * the store is left exactly as it is: whatever is wrong, the first thing that
 * arrived is the evidence that was accepted.
 */
export class SegmentIdentityConflictError extends Error {}

export type PendingObjectStore = {
  /**
   * Put one sealed segment in the bucket, once. Answers `created` where this
   * call made the object and `present` where an identical one was already
   * there, so a caller can tell a first upload from a finished retry without
   * either being a failure.
   */
  create(segment: SealedSegment): Promise<"created" | "present">;
  read(key: string): Promise<Uint8Array>;
  /** Every pending object, following every listing page. */
  list(): Promise<readonly PendingObject[]>;
  delete(key: string): Promise<void>;
  /**
   * Probe bucket reachability with one bounded listing. This checks listing
   * access, not upload permission or guaranteed durability of a future write.
   */
  reachable(): Promise<void>;
};

/** What a store answers when a conditional create found an object already there. */
function isPreconditionFailure(error: unknown): boolean {
  const held = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    held?.name === "PreconditionFailed" ||
    held?.$metadata?.httpStatusCode === 412
  );
}

export function pendingObjectStore(
  store: IngestionStore,
  options: {
    readonly requestTimeoutMilliseconds?: number;
    /**
     * How many keys one listing page carries. The store's own default is
     * a thousand and there is no deployment reason to move it; it is here so
     * that the suite proving every page is followed can force several pages
     * without putting a thousand objects in a bucket.
     */
    readonly listingPageSize?: number;
  } = {},
): PendingObjectStore {
  const client = new S3Client({
    endpoint: store.endpoint,
    region: store.region,
    // See the module doc: the deployment's store has one network name and no
    // per-bucket name, so the bucket goes in the path.
    forcePathStyle: true,
    credentials: {
      accessKeyId: store.accessKeyId,
      secretAccessKey: store.secretAccessKey,
    },
    ...(options.requestTimeoutMilliseconds === undefined
      ? {}
      : {
          requestHandler: {
            requestTimeout: options.requestTimeoutMilliseconds,
            connectionTimeout: options.requestTimeoutMilliseconds,
            // Required, and the bound is inert without it: the client's default
            // is to log a warning and keep waiting, because `requestTimeout`
            // was once a socket-idle setting and turning it into a refusal is
            // opt-in. A bound that only warns is a request held open for as
            // long as the store stays quiet — which is the exact failure the
            // whole acceptance timeout exists to answer.
            throwOnRequestTimeout: true,
          },
        }),
  });

  const read = async (key: string): Promise<Uint8Array> => {
    const found = await client.send(
      new GetObjectCommand({ Bucket: store.bucket, Key: key }),
    );
    if (found.Body === undefined) {
      throw new Error(`the ingestion bucket answered ${key} with no body`);
    }
    return await found.Body.transformToByteArray();
  };

  return {
    async create(segment) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: store.bucket,
            Key: segment.key,
            Body: segment.body,
            // The type says what the bytes are. `Content-Encoding: gzip` would
            // say instead that the bytes are a transfer encoding of something
            // else, and a client that believed it would hand the drainer a
            // decompressed body whose checksum covers nothing it can see.
            ContentType: "application/gzip",
            // The conditional create. Everything this module promises about
            // retries rests on this one header.
            IfNoneMatch: "*",
          }),
        );
        return "created";
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;

        const alreadyThere = await read(segment.key);
        if (Buffer.from(alreadyThere).equals(Buffer.from(segment.body))) {
          return "present";
        }
        throw new SegmentIdentityConflictError(
          `segment ${segment.segmentId} is already in the ingestion bucket ` +
            `holding ${alreadyThere.byteLength} bytes, and this Egma sealed ` +
            `${segment.body.byteLength} different ones under the same ` +
            `identity. A segment identity is minted once and its bytes are ` +
            `fixed when it is sealed, so this is a defect in Egma rather than ` +
            `anything a sender did. The stored object has not been touched.`,
        );
      }
    },

    read,

    async list() {
      const found: PendingObject[] = [];
      // Every page, always. A backlog large enough to need a second page is
      // exactly the backlog that must not be half-drained, and a listing that
      // stopped at the first page would report a clean prefix while a thousand
      // accepted segments sat behind it.
      let continuationToken: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: store.bucket,
            Prefix: PENDING_PREFIX,
            ...(options.listingPageSize === undefined
              ? {}
              : { MaxKeys: options.listingPageSize }),
            ...(continuationToken === undefined
              ? {}
              : { ContinuationToken: continuationToken }),
          }),
        );
        for (const object of page.Contents ?? []) {
          if (object.Key === undefined) continue;
          found.push({ key: object.Key, bytes: object.Size ?? 0 });
        }
        continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);
      return found;
    },

    async reachable() {
      await client.send(
        new ListObjectsV2Command({
          Bucket: store.bucket,
          Prefix: PENDING_PREFIX,
          MaxKeys: 1,
        }),
      );
    },

    async delete(key) {
      // Raised rather than swallowed. A deletion that failed leaves a drained
      // object where the next listing will find it again, and rediscovering a
      // drained segment is harmless — the replay is a no-op against evidence
      // that is already visible. Reporting the failure is what keeps a bucket
      // that stopped accepting deletions from looking like a bucket with
      // nothing in it.
      await client.send(
        new DeleteObjectCommand({ Bucket: store.bucket, Key: key }),
      );
    },
  };
}
