import nodemailer from "nodemailer";

let transport: nodemailer.Transporter | null = null;

/** Nodemailer over SendGrid's SMTP relay — deliberately not the SendGrid
 * SDK directly. Switching providers later (Postmark, SES, etc.) is a
 * transport config change here, not a rewrite of every call site. */
function getTransport(): nodemailer.Transporter {
  if (transport) return transport;
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) throw new Error("SENDGRID_API_KEY is missing — add it to the env.");
  transport = nodemailer.createTransport({
    host: "smtp.sendgrid.net",
    port: 587,
    auth: { user: "apikey", pass: apiKey },
  });
  return transport;
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Base64 content, not a file path/URL — the send happens inside a Cloud
  // Tasks-triggered request that may run on a different instance than
  // whatever generated the attachment, so it travels in the task payload
  // rather than being re-read from disk/GCS at send time.
  attachments?: Array<{ filename: string; contentBase64: string }>;
}

/** Low-level send — called directly by the /api/tasks/send-email handler,
 * never by request handlers themselves (see lib/tasks.ts for why). */
export async function sendEmail(payload: EmailPayload): Promise<void> {
  const from = process.env.EMAIL_FROM || `wearthistea <no-reply@example.com>`;
  await getTransport().sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    attachments: payload.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, "base64"),
    })),
  });
}

// ── Templates ────────────────────────────────────────────────────────────
// Wired to a trigger today: order confirmation (webhook, on
// payment.captured), shipped (admin/approve, on a successful Printrove
// order with a tracking number), refund processed (admin/refund), and
// magic-link (POST /api/auth/magic-link). Payment-failed/marketing still
// don't have a caller — marketing needs a per-user opt-in flow, and
// Razorpay's payment.failed event isn't handled by the webhook yet.

function wrap(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="font-family:sans-serif;color:#1a1a1a;max-width:480px;margin:0 auto;padding:24px 16px;">
<h2 style="margin:0 0 16px;">${title}</h2>
${bodyHtml}
<p style="margin-top:32px;font-size:12px;color:#888;">wearthistea</p>
</body></html>`;
}

export function orderConfirmationEmail(opts: {
  recipientName: string;
  designTitle: string;
  variantSize: string | null;
  variantColor: string | null;
  quantity: number;
  totalRupees: number;
  invoiceNumber: string | null;
}): Omit<EmailPayload, "to" | "attachments"> {
  const variant = [opts.variantColor, opts.variantSize].filter(Boolean).join(" · ");
  const html = wrap(
    "Payment received!",
    `<p>Hi ${opts.recipientName},</p>
<p>We've got your payment for <strong>${opts.designTitle}</strong>${variant ? ` (${variant})` : ""} × ${opts.quantity}.</p>
<p>Total: <strong>Rs. ${opts.totalRupees.toFixed(2)}</strong></p>
${opts.invoiceNumber ? `<p>Invoice: ${opts.invoiceNumber} (attached)</p>` : ""}
<p>We'll email you again once it ships.</p>`
  );
  const text = `Hi ${opts.recipientName},\n\nWe've got your payment for ${opts.designTitle}${variant ? ` (${variant})` : ""} x ${opts.quantity}.\nTotal: Rs. ${opts.totalRupees.toFixed(2)}\n${opts.invoiceNumber ? `Invoice: ${opts.invoiceNumber} (attached)\n` : ""}\nWe'll email you again once it ships.`;
  return { subject: `Payment received — ${opts.designTitle}`, html, text };
}

export function shippedEmail(opts: {
  recipientName: string;
  designTitle: string;
  trackingNumber: string;
}): Omit<EmailPayload, "to" | "attachments"> {
  const html = wrap(
    "Your order has shipped!",
    `<p>Hi ${opts.recipientName},</p>
<p><strong>${opts.designTitle}</strong> is on its way.</p>
<p>Tracking number: <strong>${opts.trackingNumber}</strong></p>`
  );
  const text = `Hi ${opts.recipientName},\n\n${opts.designTitle} is on its way.\nTracking number: ${opts.trackingNumber}`;
  return { subject: `Shipped — ${opts.designTitle}`, html, text };
}

export function magicLinkEmail(opts: {
  link: string;
}): Omit<EmailPayload, "to" | "attachments"> {
  const html = wrap(
    "Sign in to wearthistea",
    `<p>Tap the button below to sign in — this link works once and expires soon.</p>
<p><a href="${opts.link}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:4px;">Sign in</a></p>
<p style="margin-top:24px;font-size:12px;color:#888;">If you didn't request this, you can ignore this email.</p>`
  );
  const text = `Sign in to wearthistea:\n${opts.link}\n\nThis link works once and expires soon. If you didn't request this, you can ignore this email.`;
  return { subject: "Sign in to wearthistea", html, text };
}

export function refundProcessedEmail(opts: {
  recipientName: string;
  designTitle: string;
  amountRupees: number;
  reason?: string;
}): Omit<EmailPayload, "to" | "attachments"> {
  const html = wrap(
    "Refund processed",
    `<p>Hi ${opts.recipientName},</p>
<p>We've refunded <strong>Rs. ${opts.amountRupees.toFixed(2)}</strong> for <strong>${opts.designTitle}</strong>.</p>
${opts.reason ? `<p>Reason: ${opts.reason}</p>` : ""}
<p>It should reflect on your original payment method within a few business days.</p>`
  );
  const text = `Hi ${opts.recipientName},\n\nWe've refunded Rs. ${opts.amountRupees.toFixed(2)} for ${opts.designTitle}.\n${opts.reason ? `Reason: ${opts.reason}\n` : ""}\nIt should reflect on your original payment method within a few business days.`;
  return { subject: `Refund processed — ${opts.designTitle}`, html, text };
}
