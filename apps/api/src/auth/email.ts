/**
 * Email never blocks.
 *
 * A bare self-host has no SMTP credentials and asking for them before anything
 * works is where the pleasant part of a local install ends. So there is one
 * interface with one implementation today: the transport below writes the
 * message to the log and reports that nothing was delivered. Signup completes,
 * verification is simply not required, and an invitation link is shown to the
 * person who created it rather than posted to somebody who will never see it.
 *
 * Whether verification is required is read off the sender rather than off a
 * separate setting, so the two can never disagree — there is no configuration
 * in which egma waits for a message it never sent.
 */

export type Email = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};

export type EmailSender = {
  /**
   * Whether a message actually reaches the person it names. False for the log
   * transport, and the reason a flow that would otherwise wait for a click
   * carries on instead.
   */
  readonly delivers: boolean;
  send(email: Email): Promise<void>;
};

/**
 * The default, and today the only one. A self-hoster who has configured no
 * SMTP still sees every message egma would have sent, in the place they are
 * already reading when something goes wrong.
 */
export function loggingEmailSender(
  write: (email: Email) => void,
): EmailSender {
  return {
    delivers: false,
    async send(email) {
      write(email);
    },
  };
}
