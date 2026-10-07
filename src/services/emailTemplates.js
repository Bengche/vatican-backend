import { brand } from "../config/brand.js";
import { env } from "../config/env.js";
import {
  escapeHtml as esc,
  formatDate,
  formatTime,
  formatXAF,
  formatDateTime,
  shiftLabel,
} from "../utils/format.js";

const c = brand.colors;
const FONT =
  "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif";

export const qrImageUrl = (hash) =>
  env.apiPublicUrl ? `${env.apiPublicUrl}/api/verify/qr/${hash}.png` : null;

export const verifyUrl = (hash) => `${env.frontendUrl}/verify/${hash}`;

function button(href, label, { filled = true } = {}) {
  const background = filled ? c.primary : "#ffffff";
  const color = filled ? "#ffffff" : c.primary;
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:4px;">
    <tr>
      <td align="center" bgcolor="${background}" style="border-radius:10px;border:1px solid ${c.primary};">
        <a href="${esc(href)}" target="_blank" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:14px;font-weight:700;color:${color};text-decoration:none;border-radius:10px;">${esc(label)}</a>
      </td>
    </tr>
  </table>`;
}

function field(label, value, { mono = false, color = c.text } = {}) {
  return `
  <div style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${c.muted};margin-bottom:4px;">${esc(label)}</div>
  <div style="font-family:${mono ? "'Consolas','Courier New',monospace" : FONT};font-size:15px;font-weight:700;color:${color};line-height:1.35;">${value}</div>`;
}

function layout({ preheader, label, content, recipient }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
  <title>${esc(brand.name)}</title>
  <style>
    @media only screen and (max-width: 620px) {
      .container { width: 100% !important; border-radius: 0 !important; }
      .px { padding-left: 20px !important; padding-right: 20px !important; }
      .stack { display: block !important; width: 100% !important; box-sizing: border-box; }
      .stack-gap { padding-bottom: 16px !important; }
      .city { font-size: 22px !important; }
      .hide-sm { display: none !important; }
      .qr { width: 160px !important; height: 160px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${c.surface};-webkit-text-size-adjust:100%;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${c.surface};">${esc(preheader)}${"&zwnj;&nbsp;".repeat(40)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${c.surface}">
    <tr>
      <td align="center" style="padding:28px 12px;">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid ${c.line};">

          <tr>
            <td bgcolor="${c.primary}" class="px" style="background:${c.primary};padding:22px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td width="46" valign="middle"><img src="${esc(env.frontendUrl)}/logo-mark.png" width="46" height="42" alt="${esc(brand.monogram)}" style="display:block;border:0;"></td>
                        <td style="padding-left:14px;font-family:${FONT};">
                          <div style="font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#ffffff;">${esc(brand.name)}</div>
                          <div style="margin-top:6px;font-size:9.5px;font-weight:600;color:#9fb0cc;letter-spacing:0.28em;text-transform:uppercase;">${esc(brand.descriptor)}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                  <td align="right" valign="middle" class="hide-sm" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${c.accent};">${esc(label)}</td>
                </tr>
              </table>
            </td>
          </tr>

          ${content}

          <tr>
            <td class="px" style="background:${c.surface};padding:26px 32px;border-top:1px solid ${c.line};font-family:${FONT};">
              <div style="font-size:13px;font-weight:700;color:${c.text};margin-bottom:6px;">Need assistance?</div>
              <div style="font-size:13px;line-height:1.7;color:${c.muted};">
                Call or WhatsApp <a href="tel:+${esc(brand.support.whatsapp)}" style="color:${c.primary};font-weight:700;text-decoration:none;">${esc(brand.support.phone)}</a><br>
                Email <a href="mailto:${esc(brand.support.email)}" style="color:${c.primary};font-weight:700;text-decoration:none;">${esc(brand.support.email)}</a> &middot; ${esc(brand.support.hours)}
              </div>
              <div style="margin-top:18px;padding-top:16px;border-top:1px solid ${c.line};font-size:11px;line-height:1.7;color:#94a3b8;">
                ${esc(brand.legalName)} &middot; ${esc(brand.headOffice)}<br>
                ${recipient ? `This message was sent to ${esc(recipient)} regarding your journey. ` : ""}&copy; ${new Date().getFullYear()} ${esc(brand.name)}. All rights reserved.
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function tripCard(trip) {
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${c.line};border-radius:14px;background:#ffffff;">
    <tr>
      <td style="padding:22px 22px 8px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td valign="top" width="42%" style="font-family:${FONT};">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${c.muted};">From</div>
              <div class="city" style="font-size:26px;font-weight:800;color:${c.text};line-height:1.15;margin-top:4px;">${esc(trip.originCity)}</div>
              <div style="font-size:12px;color:${c.muted};margin-top:3px;">${esc(trip.originPark)}</div>
            </td>
            <td valign="middle" align="center" width="16%" style="font-family:${FONT};font-size:22px;color:${c.accent};font-weight:800;">&rarr;</td>
            <td valign="top" align="right" width="42%" style="font-family:${FONT};">
              <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${c.muted};">To</div>
              <div class="city" style="font-size:26px;font-weight:800;color:${c.text};line-height:1.15;margin-top:4px;">${esc(trip.destinationCity)}</div>
              <div style="font-size:12px;color:${c.muted};margin-top:3px;">${esc(trip.destinationPark)}</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr>
      <td style="padding:0 22px;"><div style="border-top:1px dashed #cbd5e1;font-size:0;line-height:0;">&nbsp;</div></td>
    </tr>
    <tr>
      <td style="padding:18px 22px 6px 22px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td class="stack stack-gap" valign="top" width="50%" style="padding-bottom:16px;">${field("Date", esc(formatDate(trip.travelDate)))}</td>
            <td class="stack stack-gap" valign="top" width="50%" style="padding-bottom:16px;">${field("Departure", `${esc(formatTime(trip.departureTime))} <span style="font-weight:600;color:${c.muted};font-size:12px;">${esc(shiftLabel(trip.travelShift))}</span>`)}</td>
          </tr>
          <tr>
            <td class="stack stack-gap" valign="top" width="50%" style="padding-bottom:16px;">${field("Bus", `${esc(trip.busNumber)} <span style="font-weight:600;color:${c.muted};font-size:12px;">${esc(trip.busType || "")}</span>`)}</td>
            <td class="stack stack-gap" valign="top" width="50%" style="padding-bottom:16px;">${field("Seat(s)", esc(trip.seatLabels), { color: c.success })}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function securityBand() {
  const label = `Official E-Ticket \u2022 ${brand.name}`.toUpperCase();
  return `
  <div style="margin-top:14px;text-align:center;font-family:${FONT};font-size:10px;font-weight:700;letter-spacing:0.22em;line-height:1.6;color:#cbd5e1;">${esc(label)}</div>`;
}

function summaryRow(label, value, { strong = false } = {}) {
  const size = strong ? "16px" : "14px";
  const weight = strong ? "800" : "600";
  const color = strong ? c.text : c.muted;
  return `
  <tr>
    <td style="padding:8px 0;font-family:${FONT};font-size:${size};color:${color};font-weight:${weight};${strong ? `border-top:1px solid ${c.line};` : ""}">${esc(label)}</td>
    <td align="right" style="padding:8px 0;font-family:${FONT};font-size:${size};color:${strong ? c.success : c.text};font-weight:${strong ? "800" : "700"};${strong ? `border-top:1px solid ${c.line};` : ""}">${value}</td>
  </tr>`;
}

export function buildReceiptEmail(record) {
  const { breakdown } = record;
  const firstName =
    String(record.contactName || "")
      .trim()
      .split(/\s+/)[0] || "Traveller";
  const qrUrl = qrImageUrl(record.qr_code_hash);
  const ticketUrl = verifyUrl(record.qr_code_hash);

  const trip = {
    originCity: record.origin_city,
    originPark: record.origin_park,
    destinationCity: record.destination_city,
    destinationPark: record.destination_park,
    travelDate: record.travel_date,
    departureTime: record.departure_time,
    travelShift: record.travel_shift,
    busNumber: record.bus_number,
    busType: record.bus_type,
    seatLabels: record.seats.map((s) => s.seat_label).join(", "),
  };

  const passengerRows = record.seats
    .map(
      (seat) => `
      <tr>
        <td style="padding:11px 12px;border-top:1px solid ${c.line};font-family:'Consolas','Courier New',monospace;font-size:13px;font-weight:700;color:${c.success};">${esc(seat.seat_label)}</td>
        <td style="padding:11px 12px;border-top:1px solid ${c.line};font-family:${FONT};font-size:13px;font-weight:700;color:${c.text};text-transform:uppercase;">${esc(seat.passenger_name)}</td>
        <td style="padding:11px 12px;border-top:1px solid ${c.line};font-family:'Consolas','Courier New',monospace;font-size:12px;color:${c.muted};">${esc(seat.id_card_number || "At boarding")}</td>
      </tr>`,
    )
    .join("");

  const paymentChannel =
    record.payment_method === "cash_counter"
      ? "Paid at agency counter"
      : "Mobile Money";

  const content = `
  <tr>
    <td class="px" align="center" style="padding:36px 32px 8px 32px;font-family:${FONT};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
        <tr><td width="56" height="56" align="center" valign="middle" bgcolor="#ecfdf5" style="background:#ecfdf5;border-radius:28px;border:1px solid #a7f3d0;font-size:26px;font-weight:800;color:${c.success};font-family:${FONT};">&#10003;</td></tr>
      </table>
      <div style="font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:${c.success};margin-top:18px;">Payment confirmed</div>
      <h1 style="margin:8px 0 10px 0;font-size:26px;line-height:1.25;color:${c.text};font-weight:800;">Your seat is secured, ${esc(firstName)}</h1>
      <p style="margin:0 auto;max-width:440px;font-size:15px;line-height:1.65;color:${c.muted};">Your e-ticket and official receipt are attached to this email as a PDF. Keep it on your phone &ndash; it works without internet.</p>
      <div style="margin-top:20px;display:inline-block;background:${c.accentSoft};border:1px solid #efd9a8;border-radius:10px;padding:10px 18px;">
        <span style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#8a6417;">Booking reference</span>
        <span style="display:block;font-family:'Consolas','Courier New',monospace;font-size:20px;font-weight:800;letter-spacing:0.08em;color:${c.text};margin-top:2px;">${esc(record.booking_ref)}</span>
      </div>
    </td>
  </tr>

  <tr>
    <td class="px" style="padding:26px 32px 4px 32px;">
      ${tripCard(trip)}
      ${securityBand()}
    </td>
  </tr>

  <tr>
    <td class="px" style="padding:22px 32px 4px 32px;">
      <div style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:${c.text};margin-bottom:10px;">Passenger manifest</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${c.line};border-radius:12px;">
        <tr bgcolor="${c.surface}" style="background:${c.surface};">
          <td style="padding:10px 12px;font-family:${FONT};font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${c.muted};">Seat</td>
          <td style="padding:10px 12px;font-family:${FONT};font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${c.muted};">Passenger</td>
          <td style="padding:10px 12px;font-family:${FONT};font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:${c.muted};">ID document</td>
        </tr>
        ${passengerRows}
      </table>
    </td>
  </tr>

  <tr>
    <td class="px" align="center" style="padding:30px 32px 6px 32px;font-family:${FONT};">
      ${
        qrUrl
          ? `<div style="display:inline-block;padding:10px;border:1px solid ${c.line};border-radius:14px;background:#ffffff;"><img class="qr" src="${esc(qrUrl)}" width="180" height="180" alt="Ticket verification QR code" style="display:block;border:0;"></div>`
          : ""
      }
      <div style="font-size:13px;color:${c.muted};margin:12px 0 18px 0;">Present this code at boarding or at any security checkpoint.</div>
      ${button(ticketUrl, "View & verify ticket")}${button(`${env.frontendUrl}/my-bookings`, "My bookings", { filled: false })}
    </td>
  </tr>

  <tr>
    <td class="px" style="padding:26px 32px 4px 32px;">
      <div style="font-family:${FONT};font-size:12px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:${c.text};margin-bottom:6px;">Payment summary</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        ${summaryRow(`Fare (${record.seats.length} seat${record.seats.length > 1 ? "s" : ""})`, esc(formatXAF(breakdown.baseFare)))}
        ${breakdown.fees > 0 ? summaryRow("Service & terminal fees", esc(formatXAF(breakdown.fees))) : ""}
        ${summaryRow("Payment method", esc(paymentChannel))}
        ${record.transaction_ref ? summaryRow("Transaction reference", `<span style="font-family:'Consolas','Courier New',monospace;font-size:12px;">${esc(record.transaction_ref)}</span>`) : ""}
        ${summaryRow("Total paid", esc(formatXAF(record.total_amount_fcfa)), { strong: true })}
      </table>
      <div style="font-family:${FONT};font-size:12px;color:#94a3b8;margin-top:8px;">Issued ${esc(formatDateTime(record.created_at))}</div>
    </td>
  </tr>

  <tr>
    <td class="px" style="padding:22px 32px 34px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.accentSoft};border:1px solid #efd9a8;border-radius:12px;">
        <tr>
          <td style="padding:18px 20px;font-family:${FONT};">
            <div style="font-size:13px;font-weight:800;color:#6b4c10;margin-bottom:8px;">Before you travel</div>
            <div style="font-size:13px;line-height:1.75;color:#5b4413;">
              &bull; Arrive at <strong>${esc(record.origin_park)}</strong> at least ${brand.boarding.arriveMinutesBefore} minutes before departure.<br>
              &bull; Carry the original ID document registered for each passenger.<br>
              &bull; Your name and ID are checked against the manifest at police checkpoints.
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>`;

  return layout({
    preheader: `${record.origin_city} to ${record.destination_city}, ${formatDate(record.travel_date)} at ${formatTime(record.departure_time)}. Reference ${record.booking_ref}.`,
    label: "E-Ticket & Receipt",
    content,
    recipient: record.recipientEmail,
  });
}

export function buildBroadcastEmail({
  toName,
  subject,
  messageBody,
  trip,
  qrCodeHash,
  recipient,
}) {
  const safeMessage = esc(messageBody).replace(/\r?\n/g, "<br>");

  const tripBlock = trip
    ? `
  <tr>
    <td class="px" style="padding:24px 32px 4px 32px;">
      ${tripCard({ ...trip, seatLabels: trip.seatLabels || "As booked" })}
    </td>
  </tr>`
    : "";

  const cta = qrCodeHash
    ? `
  <tr>
    <td class="px" align="center" style="padding:24px 32px 6px 32px;">${button(verifyUrl(qrCodeHash), "View my ticket")}</td>
  </tr>`
    : "";

  const content = `
  <tr>
    <td class="px" style="padding:36px 32px 6px 32px;font-family:${FONT};">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#b45309;">Travel update</div>
      <h1 style="margin:8px 0 12px 0;font-size:24px;line-height:1.3;color:${c.text};font-weight:800;">${esc(subject)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.65;color:${c.muted};">Dear ${esc(toName || "Passenger")},</p>
    </td>
  </tr>
  <tr>
    <td class="px" style="padding:16px 32px 4px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.accentSoft};border-left:4px solid ${c.accent};border-radius:10px;">
        <tr><td style="padding:18px 20px;font-family:${FONT};font-size:15px;line-height:1.7;color:${c.text};">${safeMessage}</td></tr>
      </table>
    </td>
  </tr>
  ${tripBlock}
  ${cta}
  <tr>
    <td class="px" style="padding:22px 32px 34px 32px;font-family:${FONT};font-size:13px;line-height:1.7;color:${c.muted};">
      We apologise for any inconvenience and thank you for travelling with ${esc(brand.name)}.
    </td>
  </tr>`;

  return layout({
    preheader: String(messageBody).replace(/\s+/g, " ").slice(0, 110),
    label: "Travel Update",
    content,
    recipient,
  });
}

function textBlock({ eyebrow, title, intro }) {
  return `
  <tr>
    <td class="px" style="padding:36px 32px 6px 32px;font-family:${FONT};">
      <div style="font-size:11px;font-weight:800;letter-spacing:0.16em;text-transform:uppercase;color:#b45309;">${esc(eyebrow)}</div>
      <h1 style="margin:8px 0 12px 0;font-size:24px;line-height:1.3;color:${c.text};font-weight:800;">${esc(title)}</h1>
      <p style="margin:0;font-size:15px;line-height:1.65;color:${c.muted};">${intro}</p>
    </td>
  </tr>`;
}

export function buildPasswordResetEmail({ name, url, minutes, recipient }) {
  const content = `
  ${textBlock({ eyebrow: "Account security", title: "Reset your password", intro: `Hello ${esc(name || "there")}, we received a request to reset the password for your ${esc(brand.name)} account. The link below is valid for ${minutes} minutes and can be used once.` })}
  <tr><td class="px" align="center" style="padding:24px 32px 6px 32px;">${button(url, "Choose a new password")}</td></tr>
  <tr>
    <td class="px" style="padding:18px 32px 34px 32px;font-family:${FONT};font-size:13px;line-height:1.7;color:${c.muted};">
      If the button does not work, copy this address into your browser:<br>
      <span style="word-break:break-all;color:${c.primary};">${esc(url)}</span><br><br>
      If you did not ask for this, you can ignore this email and your password will stay the same.
    </td>
  </tr>`;
  return layout({ preheader: "Use this link to choose a new password.", label: "Account Security", content, recipient });
}

export function buildPasswordChangedEmail({ name, recipient }) {
  const content = `
  ${textBlock({ eyebrow: "Account security", title: "Your password was changed", intro: `Hello ${esc(name || "there")}, the password for your ${esc(brand.name)} account has just been changed.` })}
  <tr>
    <td class="px" style="padding:18px 32px 34px 32px;font-family:${FONT};font-size:14px;line-height:1.7;color:${c.muted};">
      If this was you, no further action is needed. If it was not, reset your password immediately and contact us on
      <a href="tel:+${esc(brand.support.whatsapp)}" style="color:${c.primary};font-weight:700;text-decoration:none;">${esc(brand.support.phone)}</a>.
    </td>
  </tr>`;
  return layout({ preheader: "Your password was changed.", label: "Account Security", content, recipient });
}

export function buildCancellationEmail({ record, reason, refund, recipient }) {
  const refundLine = !refund
    ? "No refund applies to this cancellation under our refund policy."
    : refund.method === "cash"
      ? `${formatXAF(refund.amount)} is refunded in cash at the terminal counter.`
      : refund.status === "sent"
        ? `${formatXAF(refund.amount)} has been sent back to your Mobile Money number${refund.phone ? ` ending ${String(refund.phone).slice(-3)}` : ""}.`
        : `${formatXAF(refund.amount)} is being returned to your Mobile Money number. We will contact you if there is any delay.`;

  const content = `
  ${textBlock({ eyebrow: "Booking update", title: "Your booking was cancelled", intro: `Booking <strong style="color:${c.text};">${esc(record.booking_ref)}</strong> for ${esc(record.origin_city)} to ${esc(record.destination_city)} on ${esc(formatDate(record.travel_date))} at ${esc(formatTime(record.departure_time))} has been cancelled.` })}
  <tr>
    <td class="px" style="padding:16px 32px 4px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.accentSoft};border-left:4px solid ${c.accent};border-radius:10px;">
        <tr><td style="padding:16px 20px;font-family:${FONT};font-size:14px;line-height:1.7;color:${c.text};">
          <strong>Reason:</strong> ${esc(reason)}<br>
          <strong>Refund:</strong> ${esc(refundLine)}
        </td></tr>
      </table>
    </td>
  </tr>
  <tr>
    <td class="px" style="padding:22px 32px 34px 32px;font-family:${FONT};font-size:13px;line-height:1.7;color:${c.muted};">
      The ticket for this booking is no longer valid. You can book another trip at any time on ${esc(brand.website)}.
    </td>
  </tr>`;
  return layout({ preheader: `Booking ${record.booking_ref} was cancelled.`, label: "Booking Update", content, recipient });
}