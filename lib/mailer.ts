import nodemailer from "nodemailer";

// Tiny SMTP wrapper. Production points SMTP_* at any provider (Resend SMTP,
// Mailgun, AWS SES, Brevo — all work). In dev with no SMTP_HOST configured
// we fall back to logging the email so flows are testable without an inbox.
//
// We never throw inside send() — a failed welcome email shouldn't tank a
// signup. Callers that DO need delivery (password reset) should check the
// boolean return.

interface SendInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

let cachedTransport: nodemailer.Transporter | null | undefined;

function getTransport(): nodemailer.Transporter | null {
  if (cachedTransport !== undefined) return cachedTransport;
  const host = process.env.SMTP_HOST;
  if (!host) {
    cachedTransport = null;
    return null;
  }
  cachedTransport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    // Most providers require explicit TLS on port 465; STARTTLS on 587.
    secure: process.env.SMTP_SECURE === "1",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" }
      : undefined,
  });
  return cachedTransport;
}

export interface MailerSendResult {
  delivered: boolean;
  /** Reason the message wasn't actually delivered, when delivered=false. */
  reason?: "no_smtp_configured" | "send_failed";
  error?: string;
}

export async function sendMail(input: SendInput): Promise<MailerSendResult> {
  const transport = getTransport();
  const from =
    process.env.MAIL_FROM ?? "Matgary <no-reply@matgary.local>";

  if (!transport) {
    // Dev path — show the body in the server console so the operator can
    // copy/paste links during local testing without an SMTP server.
    console.log(
      `\n[mailer] (no SMTP_HOST set, logging instead)\nTo:      ${input.to}\nSubject: ${input.subject}\n${input.text}\n`,
    );
    return { delivered: false, reason: "no_smtp_configured" };
  }

  try {
    await transport.sendMail({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { delivered: true };
  } catch (err) {
    console.error("[mailer] sendMail failed:", err);
    return {
      delivered: false,
      reason: "send_failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
