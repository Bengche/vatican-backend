import { brand } from "../config/brand.js";
import { env } from "../config/env.js";
import { getBookingRecord } from "./receiptService.js";
import { buildReceiptEmail, buildBroadcastEmail } from "./emailTemplates.js";
import { renderTicketPdf } from "./ticketPdf.js";

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

/**
 * Sends one message through SendGrid. Throws on failure so the queue can retry.
 * Returns the provider message id, or null when no API key is configured.
 */
async function sendEmail({ to, subject, html, attachments = [], category }) {
  if (!env.sendgridApiKey) {
    console.warn("[Email] SENDGRID_API_KEY is not set; message not sent.");
    return null;
  }

  const payload = {
    personalizations: [{ to: [{ email: to.email, ...(to.name ? { name: to.name } : {}) }] }],
    from: { email: brand.sender.email, name: brand.sender.name },
    reply_to: { email: brand.support.email, name: brand.name },
    subject,
    content: [{ type: "text/html", value: html }],
    ...(attachments.length > 0 && {
      attachments: attachments.map((file) => ({
        content: file.content,
        filename: file.filename,
        type: file.type,
        disposition: "attachment",
      })),
    }),
    ...(category && { categories: [category] }),
    // Link rewriting would hide the real ticket address and hurt deliverability.
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    },
  };

  const response = await fetch(SENDGRID_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.sendgridApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const reason = data.errors?.map((e) => e.message).join("; ");
    throw new Error(reason || `Email provider responded with status ${response.status}`);
  }

  return response.headers.get("x-message-id") || "accepted";
}

/**
 * Sends the e-ticket + receipt (with PDF attachment) for a confirmed booking.
 * Throws on failure so the queue can retry.
 */
export async function sendBookingReceiptEmail({ bookingId }) {
  const record = await getBookingRecord(bookingId);

  if (!record || record.booking_status !== "confirmed") return null;

  if (!record.recipientEmail) {
    console.log(`[Email] No recipient for booking ${record.booking_ref}; skipped.`);
    return null;
  }

  const pdf = await renderTicketPdf(record);

  const messageId = await sendEmail({
    to: { email: record.recipientEmail, name: record.contactName },
    subject: `Your e-ticket ${record.booking_ref}: ${record.origin_city} to ${record.destination_city}`,
    html: buildReceiptEmail(record),
    attachments: [
      {
        filename: `${brand.name.replace(/\s+/g, "")}-Ticket-${record.booking_ref}.pdf`,
        content: pdf.toString("base64"),
        type: "application/pdf",
      },
    ],
    category: "ticket-receipt",
  });

  if (messageId) console.log(`[Email] Receipt sent for ${record.booking_ref}.`);
  return messageId;
}

/** Sends a trip update notice to a single passenger. */
export async function sendBroadcastEmail({ toEmail, toName, subject, messageBody, trip, qrCodeHash }) {
  return sendEmail({
    to: { email: toEmail, name: toName },
    subject: `${brand.name}: ${subject}`,
    html: buildBroadcastEmail({ toName, subject, messageBody, trip, qrCodeHash, recipient: toEmail }),
    category: "trip-update",
  });
}