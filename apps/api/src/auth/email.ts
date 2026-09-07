import { createTransport } from "nodemailer";

/**
 * SMTP is optional. Without it, the server records skipped delivery without
 * logging recipients or signed links. Signup does not require verification,
 * and invitation links are returned to their creator. Flows use delivers
 * to choose behavior; it indicates configuration, not delivery success.
 */

export type Email = {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
};

export type EmailSender = {
  /**
   * Whether a delivery transport is configured, not whether a message arrived.
   * False lets flows avoid waiting for email that will not be sent.
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
 * Create an SMTP sender. The connection opens on the first send, so an
 * unreachable server does not prevent initialization.
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
