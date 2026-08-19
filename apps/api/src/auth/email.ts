import { createTransport } from "nodemailer";

/**
 * Email never blocks.
 *
 * A bare self-host has no SMTP credentials and asking for them before anything
 * works is where the pleasant part of a local install ends. So there is one
 * interface and two transports, and **the one that delivers nothing is the
 * default**: it records that delivery was skipped, but never logs the recipient
 * or the signed link in the message. Signup completes,
 * verification is simply not required, and an invitation link is shown to the
 * person who created it rather than posted to somebody who will never see it.
 *
 * Configuring SMTP is one environment variable and is never a prerequisite.
 * Langfuse is the counter-example worth naming: theirs requires SMTP before
 * anybody can be invited, and self-hosters file it as a bug. The pleasant part
 * of a local install is solo, and the second person is exactly where it breaks.
 *
 * Whether verification is required is read off the sender rather than off a
 * separate setting, so the two can never disagree — there is no configuration
 * in which egma waits for a message it never sent, and none in which mail is
 * configured and egma still hands out links instead of sending them.
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
 * The default. Its callback records that delivery was skipped; the server's
 * callback deliberately ignores the email because it contains personal data
 * and a signed link. Tests can use a capturing callback to inspect the email
 * transport without putting that content in a production log.
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

export type SmtpSettings = {
  /** One connection string: `smtp://user:password@host:587`, or `smtps://…`. */
  readonly url: string;
  /** What the messages are from. */
  readonly from: string;
};

/**
 * The other transport, and the only thing that changes when a self-hoster
 * configures one: `delivers` becomes true, and every flow that was handing a
 * link back starts posting it instead. There is no second setting to keep in
 * step, because there is no second setting.
 *
 * The connection is opened lazily by the library on the first message, so
 * configuring an SMTP server that is not there yet does not stop egma booting —
 * a mail server being down is not a reason a control plane should be down.
 */
export function smtpEmailSender(settings: SmtpSettings): EmailSender {
  const transport = createTransport(settings.url, { from: settings.from });

  return {
    delivers: true,
    async send(email) {
      await transport.sendMail({
        to: email.to,
        subject: email.subject,
        text: email.body,
      });
    },
  };
}
