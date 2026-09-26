const nodemailer = require("nodemailer");

let transporter;

// Lazily initialized, same defensive pattern as config/firebaseAdmin.js — a
// missing/late-added env var doesn't crash the whole server, only requests
// that actually need to send an email will hit this.
//
// Works with ANY standard SMTP provider (Gmail with an App Password, Brevo,
// Mailgun, SendGrid SMTP relay, Zoho, your hosting's own SMTP...). Set these
// on the backend host (Vercel/Railway/Render env vars):
//   SMTP_HOST      e.g. smtp.gmail.com
//   SMTP_PORT      e.g. 587 (or 465 for SSL)
//   SMTP_USER      the SMTP username / login email
//   SMTP_PASS      the SMTP password / app password
//   EMAIL_FROM     optional, e.g. "Nativoya" <no-reply@nativoya.click>
//   FRONTEND_URL   already used for CORS — reused here to build the reset link
function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    const err = new Error("Email isn't configured yet — SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS are missing.");
    err.code = "EMAIL_NOT_CONFIGURED";
    throw err;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: Number(SMTP_PORT) === 465, // true for 465 (SSL), false for 587/others (STARTTLS)
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return transporter;
}

async function sendMail({ to, subject, html }) {
  const t = getTransporter();
  const from = process.env.EMAIL_FROM || `"Nativoya" <${process.env.SMTP_USER}>`;
  await t.sendMail({ from, to, subject, html });
}

module.exports = { sendMail };
