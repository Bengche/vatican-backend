import { brand } from "../config/brand.js";
import { env } from "../config/env.js";
import { getBookingRecord } from "./receiptService.js";
import { buildReceiptEmail, buildBroadcastEmail } from "./emailTemplates.js";
import { renderTicketPdf } from "./ticketPdf.js";

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

async function sendViaBrevo(payload) {
  if (!env.brevoApiKey) {
    console.warn("[Email] BREVO_API_KEY is not set; message not sent.");
    return null;
  }

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "api-key": env.brevoApiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sender: brand.sender, ...payload }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || `Email provider responded with status ${response.status}`,
    );
  }
  return data;
}

/**
 * Sends the e-ticket + receipt (with PDF attachment) for a confirmed booking.
 * Throws on failure so the queue can retry.
 */
export async function sendBookingReceiptEmail({ bookingId }) {
  const record = await getBookingRecord(bookingId);

  if (!record || record.booking_status !== "confirmed") return null;

  if (!record.recipientEmail) {
    console.log(
      `[Email] No recipient for booking ${record.booking_ref}; skipped.`,
    );
    return null;
  }

  const pdf = await renderTicketPdf(record);

  const data = await sendViaBrevo({
    to: [
      { email: record.recipientEmail, name: record.contactName || undefined },
    ],
    subject: `Your e-ticket ${record.booking_ref}: ${record.origin_city} to ${record.destination_city}`,
    htmlContent: buildReceiptEmail(record),
    attachment: [
      {
        name: `${brand.name.replace(/\s+/g, "")}-Ticket-${record.booking_ref}.pdf`,
        content: pdf.toString("base64"),
      },
    ],
    tags: ["ticket-receipt"],
  });

  if (data) console.log(`[Email] Receipt sent for ${record.booking_ref}.`);
  return data;
}

/** Sends a trip update notice to a single passenger. */
export async function sendBroadcastEmail({
  toEmail,
  toName,
  subject,
  messageBody,
  trip,
  qrCodeHash,
}) {
  return sendViaBrevo({
    to: [{ email: toEmail, name: toName || undefined }],
    subject: `${brand.name}: ${subject}`,
    htmlContent: buildBroadcastEmail({
      toName,
      subject,
      messageBody,
      trip,
      qrCodeHash,
      recipient: toEmail,
    }),
    tags: ["trip-update"],
  });
}
