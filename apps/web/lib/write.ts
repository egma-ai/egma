/**
 * One write to egma, and the three answers a screen has to tell apart.
 *
 * **It exists because the three were being told apart three times.** Every form
 * on a product page does the same four things — post, read a refusal off the
 * body, fall back to its own sentence when the body carried none, and treat a
 * thrown request as the platform being out of reach — and each copy is a chance
 * to drop the third. A refusal shown as "egma could not be reached" when egma
 * answered perfectly well and said why is the failure this shape prevents: the
 * developer goes looking at their network and the sentence naming the field
 * they got wrong is on the floor.
 *
 * **What it does not do is hold the busy flag.** Whether a button is disabled
 * while a request is in flight is the form's own business, and a helper that
 * reached into a caller's state to set it would be harder to read than the two
 * lines it replaced.
 */

export type Write = {
  readonly url: string;
  readonly method: "POST" | "PATCH" | "DELETE";
  /** Sent as JSON. Absent for a verb with nothing to say, like a delete. */
  readonly body?: unknown;
  /** What to show when egma never answered at all. */
  readonly unreachable: string;
};

/**
 * `null` where the write landed, and otherwise the sentence to put in front of
 * somebody — egma's own words wherever egma sent any.
 */
export async function wrote(write: Write): Promise<string | null> {
  try {
    const answer = await fetch(write.url, {
      method: write.method,
      ...(write.body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(write.body),
          }),
    });

    if (answer.ok) return null;

    // The refusal, relayed word for word: these sentences are written to be
    // read by the person who has to fix the thing, and a screen paraphrasing
    // one would be a second, worse copy of the contract.
    const said = (await answer.json().catch(() => ({}))) as {
      message?: string;
    };
    return said.message ?? write.unreachable;
  } catch {
    return write.unreachable;
  }
}
