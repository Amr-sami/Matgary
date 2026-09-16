import "dotenv/config";
import nodemailer from "nodemailer";

const to = process.argv[2];
if (!to) {
  console.error("usage: node scripts/test-smtp.mjs <recipient@example.com>");
  process.exit(1);
}

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 465),
  secure: process.env.SMTP_SECURE === "1",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

console.log("verifying SMTP…");
await transport.verify();
console.log("✅ auth OK — sending test message to", to);

const info = await transport.sendMail({
  from: process.env.MAIL_FROM,
  to,
  subject: "TheStoro SMTP test",
  text: "If you can read this, SMTP is working from your Next.js app.",
});
console.log("✅ sent:", info.messageId);
