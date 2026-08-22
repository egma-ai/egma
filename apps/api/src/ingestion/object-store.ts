import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

import { PENDING_PREFIX, type SealedSegment } from "./segment.ts";

/**
 * The ingestion bucket, and the four things Egma ever asks it.
 *
 * Create one pending object without ever replacing one, read one back, list the
 * whole pending prefix, and delete one that has been drained. Nothing else: no
 * copy, no multipart, no lifecycle, no bucket administration. The object store
 * is a **spool** in this design and not a second permanent trace archive, and
 * this surface is the whole of what that costs.
 *
 * ## Why this module buys the tree the recordings signer refused to
 *
 * `recordings/signed-link.ts` writes SigV4 out by hand and says exactly where
 * that stops (`:34-37`): *what is deliberately not here is signing anything
 * with a request body, anything with headers beyond `host`, and anything that
 * needs a temporary credential. If egma ever needs one of those, that is the
 * day to buy the tree rather than to grow this file.* This is that day, and by
 * some distance — every call below has a body or a payload hash or a
 * conditional header, and two of them have both. So the signer stays exactly as
 * it is, still hand-written, still proving itself against a real MinIO on every
 * run, and the ingestion path takes the dependency instead of growing a second
 * hand-written signer that nothing outside our own tests would ever check.
 *
 * Path-style addressing, for the reason the signer uses it: a MinIO answering
 * at `http://minio:9000` has one name on the deployment's network and no
 * per-bucket name at all, so `http://egma-ingestion.minio:9000` resolves
 * nothing. AWS serves both styles, so a deployment on real S3 pays nothing.
 *
 * ## Conditional create is the whole idempotency story
 *
 * A segment is sealed once and its identity is written into the local log
 * before the upload starts, so a retry after an ambiguous upload asks to create
 * **the same key with the same bytes**. `If-None-Match: *` turns that into a
 * question the store answers rather than a race this side has to reason about:
 * either this call created the object, or an object is already there.
 *
 * Where one is already there the bytes are read back and compared. Identical
 * bytes are a success — that is the retry finishing the work its own earlier
 * attempt already did. Different bytes under one segment identity are an
 * **internal defect** and never a customer's problem: identities are minted
 * here, and two different sealings claiming one is a fault in Egma. The
 * comparison is over the bytes rather than over the store's ETag because an
 * ETag is the store's own summary, and its rule for making one changes with
 * encryption settings and multipart thresholds. This path only runs on a retry,
 * so it costs one read on a rare turn and answers the exact question.
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
