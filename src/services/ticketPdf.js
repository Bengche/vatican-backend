import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { brand } from "../config/brand.js";
import { verifyUrl } from "./emailTemplates.js";
import {
  formatDate,
  formatTime,
  formatXAF,
  formatDateTime,
  shiftLabel,
} from "../utils/format.js";

const C = brand.colors;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

function drawWatermark(doc) {
  doc.save();
  doc.rotate(-35, { origin: [PAGE_W / 2, PAGE_H / 2] });
  doc.fillColor(C.primary).fillOpacity(0.045);
  doc.font("Helvetica-Bold").fontSize(58);
  const name = brand.name.toUpperCase();
  [-230, -90, 50, 190].forEach((offset) => {
    doc.text(name, 0, PAGE_H / 2 + offset, {
      width: PAGE_W,
      align: "center",
      lineBreak: false,
    });
  });
  doc
    .fontSize(20)
    .fillOpacity(0.06)
    .text("OFFICIAL E-TICKET", 0, PAGE_H / 2 + 120, {
      width: PAGE_W,
      align: "center",
      lineBreak: false,
      characterSpacing: 8,
    });
  doc.restore();
  doc.fillOpacity(1);
}

const label = (doc, text, x, y, opts = {}) =>
  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor(C.muted)
    .text(text.toUpperCase(), x, y, {
      characterSpacing: 0.8,
      lineBreak: false,
      ...opts,
    });

function fit(doc, text, maxWidth) {
  let value = String(text ?? "");
  while (value.length > 1 && doc.widthOfString(value) > maxWidth)
    value = value.slice(0, -1);
  return value === String(text ?? "") ? value : `${value.trimEnd()}...`;
}

/**
 * Renders the official A4 e-ticket and receipt for a booking record
 * (shape produced by receiptService) and resolves with the PDF bytes.
 */
export async function renderTicketPdf(record) {
  const qrBuffer = await QRCode.toBuffer(verifyUrl(record.qr_code_hash), {
    margin: 1,
    width: 360,
    color: { dark: C.primary, light: "#ffffff" },
  });

  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    info: {
      Title: `E-Ticket ${record.booking_ref}`,
      Author: brand.legalName,
      Subject: "Passenger e-ticket and payment receipt",
    },
  });

  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  drawWatermark(doc);

  // Page frame
  doc
    .roundedRect(24, 24, PAGE_W - 48, PAGE_H - 48, 14)
    .lineWidth(1)
    .strokeColor(C.line)
    .stroke();

  // Header band
  doc.roundedRect(24, 24, PAGE_W - 48, 88, 14).fill(C.primary);
  doc.rect(24, 70, PAGE_W - 48, 42).fill(C.primary);
  doc
    .roundedRect(MARGIN, 46, 44, 44, 7)
    .lineWidth(1.2)
    .fillAndStroke(C.primaryDark, C.accent);
  doc
    .font("Times-Bold")
    .fontSize(19)
    .fillColor(C.accent)
    .text(brand.monogram, MARGIN, 60, {
      width: 44,
      align: "center",
      lineBreak: false,
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor("#ffffff")
    .text(brand.name.toUpperCase(), MARGIN + 58, 51, {
      characterSpacing: 2.6,
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(7.5)
    .fillColor("#9fb0cc")
    .text(brand.descriptor.toUpperCase(), MARGIN + 58, 72, {
      characterSpacing: 2.4,
      lineBreak: false,
    });
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(C.accent)
    .text("E-TICKET & RECEIPT", PAGE_W - MARGIN - 200, 52, {
      width: 200,
      align: "right",
      characterSpacing: 1.6,
      lineBreak: false,
    });
  doc.roundedRect(PAGE_W - MARGIN - 82, 70, 82, 20, 10).fill("#10b981");
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor("#ffffff")
    .text("CONFIRMED", PAGE_W - MARGIN - 82, 76.5, {
      width: 82,
      align: "center",
      characterSpacing: 1,
      lineBreak: false,
    });

  // Reference row
  label(doc, "Booking reference", MARGIN, 134);
  doc
    .font("Courier-Bold")
    .fontSize(24)
    .fillColor(C.text)
    .text(record.booking_ref, MARGIN, 148, {
      characterSpacing: 1.5,
      lineBreak: false,
    });
  label(doc, "Issued", PAGE_W - MARGIN - 200, 134, {
    width: 200,
    align: "right",
  });
  doc
    .font("Helvetica-Bold")
    .fontSize(10.5)
    .fillColor(C.text)
    .text(formatDateTime(record.created_at), PAGE_W - MARGIN - 220, 150, {
      width: 220,
      align: "right",
      lineBreak: false,
    });

  // Route card
  const routeY = 196;
  doc
    .roundedRect(MARGIN, routeY, CONTENT_W, 128, 12)
    .lineWidth(1)
    .strokeColor(C.line)
    .stroke();

  label(doc, "From", MARGIN + 20, routeY + 18);
  doc
    .font("Helvetica-Bold")
    .fontSize(25)
    .fillColor(C.text)
    .text(fit(doc, record.origin_city, 190), MARGIN + 20, routeY + 31, {
      lineBreak: false,
    });
  doc
    .font("Helvetica")
    .fontSize(9.5)
    .fillColor(C.muted)
    .text(fit(doc, record.origin_park, 190), MARGIN + 20, routeY + 62, {
      lineBreak: false,
    });

  label(doc, "To", PAGE_W - MARGIN - 210, routeY + 18, {
    width: 190,
    align: "right",
  });
  doc.font("Helvetica-Bold").fontSize(25).fillColor(C.text);
  doc.text(
    fit(doc, record.destination_city, 190),
    PAGE_W - MARGIN - 210,
    routeY + 31,
    { width: 190, align: "right", lineBreak: false },
  );
  doc.font("Helvetica").fontSize(9.5).fillColor(C.muted);
  doc.text(
    fit(doc, record.destination_park, 190),
    PAGE_W - MARGIN - 210,
    routeY + 62,
    { width: 190, align: "right", lineBreak: false },
  );

  // Arrow
  const arrowY = routeY + 46;
  const mid = PAGE_W / 2;
  doc
    .lineWidth(1.6)
    .strokeColor(C.accent)
    .moveTo(mid - 26, arrowY)
    .lineTo(mid + 24, arrowY)
    .stroke();
  doc
    .moveTo(mid + 16, arrowY - 6)
    .lineTo(mid + 26, arrowY)
    .lineTo(mid + 16, arrowY + 6)
    .stroke();

  doc.lineWidth(1).strokeColor("#cbd5e1").dash(3, { space: 3 });
  doc
    .moveTo(MARGIN + 20, routeY + 86)
    .lineTo(PAGE_W - MARGIN - 20, routeY + 86)
    .stroke()
    .undash();

  const seatLabels = record.seats.map((s) => s.seat_label).join(", ");
  const facts = [
    ["Date", formatDate(record.travel_date)],
    [
      "Departure",
      `${formatTime(record.departure_time)}  ${shiftLabel(record.travel_shift)}`,
    ],
    [
      "Coach",
      `${record.bus_number}${record.bus_type ? ` (${record.bus_type})` : ""}`,
    ],
    ["Seat(s)", seatLabels],
  ];
  const colW = (CONTENT_W - 40) / 4;
  facts.forEach(([name, value], index) => {
    const x = MARGIN + 20 + colW * index;
    label(doc, name, x, routeY + 98);
    doc
      .font("Helvetica-Bold")
      .fontSize(10.5)
      .fillColor(index === 3 ? C.success : C.text);
    doc.text(fit(doc, value, colW - 8), x, routeY + 110, { lineBreak: false });
  });

  // Manifest
  let y = routeY + 150;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(C.text)
    .text("PASSENGER MANIFEST", MARGIN, y, {
      characterSpacing: 1.2,
      lineBreak: false,
    });
  y += 18;
  doc.rect(MARGIN, y, CONTENT_W, 24).fill(C.primary);
  const cols = {
    seat: MARGIN + 14,
    name: MARGIN + 74,
    id: MARGIN + 292,
    demo: MARGIN + 410,
  };
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#ffffff");
  doc.text("SEAT", cols.seat, y + 8.5, {
    characterSpacing: 0.8,
    lineBreak: false,
  });
  doc.text("PASSENGER", cols.name, y + 8.5, {
    characterSpacing: 0.8,
    lineBreak: false,
  });
  doc.text("ID DOCUMENT", cols.id, y + 8.5, {
    characterSpacing: 0.8,
    lineBreak: false,
  });
  doc.text("AGE / GENDER", cols.demo, y + 8.5, {
    characterSpacing: 0.8,
    lineBreak: false,
  });
  y += 24;

  const rowH = record.seats.length > 6 ? 24 : 28;
  record.seats.forEach((seat) => {
    doc
      .font("Courier-Bold")
      .fontSize(10.5)
      .fillColor(C.success)
      .text(seat.seat_label, cols.seat, y + rowH / 2 - 5, { lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(10).fillColor(C.text);
    doc.text(
      fit(doc, String(seat.passenger_name || "").toUpperCase(), 205),
      cols.name,
      y + rowH / 2 - 5,
      { lineBreak: false },
    );
    doc.font("Courier").fontSize(9.5).fillColor(C.text);
    doc.text(
      fit(doc, seat.id_card_number || "At boarding", 105),
      cols.id,
      y + rowH / 2 - 4.5,
      { lineBreak: false },
    );
    const gender = seat.passenger_gender
      ? seat.passenger_gender[0].toUpperCase() + seat.passenger_gender.slice(1)
      : "";
    doc.font("Helvetica").fontSize(9).fillColor(C.muted);
    doc.text(
      [seat.passenger_age ? `${seat.passenger_age} yrs` : "", gender]
        .filter(Boolean)
        .join("  /  "),
      cols.demo,
      y + rowH / 2 - 4.5,
      { lineBreak: false },
    );
    y += rowH;
    doc
      .lineWidth(0.6)
      .strokeColor(C.line)
      .moveTo(MARGIN, y)
      .lineTo(PAGE_W - MARGIN, y)
      .stroke();
  });
  doc
    .lineWidth(1)
    .strokeColor(C.line)
    .rect(
      MARGIN,
      y - rowH * record.seats.length - 24,
      CONTENT_W,
      rowH * record.seats.length + 24,
    )
    .stroke();

  // Payment summary (left) and QR (right)
  y += 24;
  const blockY = y;
  doc
    .font("Helvetica-Bold")
    .fontSize(9)
    .fillColor(C.text)
    .text("PAYMENT SUMMARY", MARGIN, blockY, {
      characterSpacing: 1.2,
      lineBreak: false,
    });

  const paymentChannel =
    record.payment_method === "cash_counter"
      ? "Paid at agency counter"
      : "Mobile Money";
  const lines = [
    [
      `Fare (${record.seats.length} seat${record.seats.length > 1 ? "s" : ""})`,
      formatXAF(record.breakdown.baseFare),
    ],
  ];
  if (record.breakdown.fees > 0)
    lines.push(["Service & terminal fees", formatXAF(record.breakdown.fees)]);
  lines.push(["Payment method", paymentChannel]);
  if (record.transaction_ref)
    lines.push(["Transaction ref.", record.transaction_ref]);

  let ly = blockY + 20;
  const leftW = 290;
  lines.forEach(([name, value]) => {
    doc
      .font("Helvetica")
      .fontSize(9.5)
      .fillColor(C.muted)
      .text(name, MARGIN, ly, { lineBreak: false });
    doc
      .font("Helvetica-Bold")
      .fontSize(9.5)
      .fillColor(C.text)
      .text(fit(doc, value, 160), MARGIN + leftW - 160, ly, {
        width: 160,
        align: "right",
        lineBreak: false,
      });
    ly += 20;
  });
  doc
    .lineWidth(0.8)
    .strokeColor(C.line)
    .moveTo(MARGIN, ly + 2)
    .lineTo(MARGIN + leftW, ly + 2)
    .stroke();
  doc
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(C.text)
    .text("TOTAL PAID", MARGIN, ly + 12, { lineBreak: false });
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .fillColor(C.success)
    .text(formatXAF(record.total_amount_fcfa), MARGIN + leftW - 190, ly + 10, {
      width: 190,
      align: "right",
      lineBreak: false,
    });

  const qrSize = 118;
  const qrX = PAGE_W - MARGIN - qrSize - 14;
  doc
    .roundedRect(qrX - 8, blockY - 4, qrSize + 16, qrSize + 38, 10)
    .lineWidth(1)
    .strokeColor(C.line)
    .stroke();
  doc.image(qrBuffer, qrX, blockY + 4, { width: qrSize });
  doc
    .font("Helvetica-Bold")
    .fontSize(7.5)
    .fillColor(C.muted)
    .text("SCAN TO VERIFY", qrX - 8, blockY + qrSize + 16, {
      width: qrSize + 16,
      align: "center",
      characterSpacing: 1,
      lineBreak: false,
    });

  // Notice
  const footY = PAGE_H - 96;
  let noticeY = Math.max(ly + 50, blockY + qrSize + 50);
  if (noticeY + 78 > footY - 8) {
    // Large manifests: continue the notice and footer on a second page.
    doc.addPage();
    drawWatermark(doc);
    doc
      .roundedRect(24, 24, PAGE_W - 48, PAGE_H - 48, 14)
      .lineWidth(1)
      .strokeColor(C.line)
      .stroke();
    noticeY = 60;
  }
  doc
    .roundedRect(MARGIN, noticeY, CONTENT_W, 78, 10)
    .fillAndStroke(C.accentSoft, "#efd9a8");
  doc
    .font("Helvetica-Bold")
    .fontSize(9.5)
    .fillColor("#6b4c10")
    .text("Before you travel", MARGIN + 18, noticeY + 13, { lineBreak: false });
  doc.font("Helvetica").fontSize(8.8).fillColor("#5b4413");
  doc.text(
    `Arrive at ${record.origin_park} at least ${brand.boarding.arriveMinutesBefore} minutes before departure.`,
    MARGIN + 18,
    noticeY + 30,
    { width: CONTENT_W - 36, lineBreak: false },
  );
  doc.text(
    "Carry the original ID document registered for each passenger; names are checked against the manifest.",
    MARGIN + 18,
    noticeY + 44,
    {
      width: CONTENT_W - 36,
      lineBreak: false,
    },
  );
  doc.text(
    "This ticket is valid only for the passenger(s), seat(s) and date shown above.",
    MARGIN + 18,
    noticeY + 58,
    {
      width: CONTENT_W - 36,
      lineBreak: false,
    },
  );

  // Footer
  doc
    .lineWidth(1)
    .strokeColor("#cbd5e1")
    .dash(3, { space: 3 })
    .moveTo(MARGIN, footY)
    .lineTo(PAGE_W - MARGIN, footY)
    .stroke()
    .undash();
  doc
    .font("Helvetica-Bold")
    .fontSize(8)
    .fillColor(C.text)
    .text(brand.legalName, MARGIN, footY + 12, { lineBreak: false });
  doc.font("Helvetica").fontSize(8).fillColor(C.muted);
  doc.text(`${brand.headOffice}`, MARGIN, footY + 24, { lineBreak: false });
  doc.text(
    `${brand.support.phone}  |  ${brand.support.email}`,
    MARGIN,
    footY + 36,
    { lineBreak: false },
  );
  doc.font("Courier").fontSize(7).fillColor("#94a3b8");
  doc.text(
    `Security hash ${record.qr_code_hash.slice(0, 40)}`,
    MARGIN,
    footY + 52,
    { lineBreak: false },
  );
  doc.text(
    verifyUrl(record.qr_code_hash)
      .replace(/^https?:\/\//, "")
      .slice(0, 80),
    MARGIN,
    footY + 62,
    { lineBreak: false },
  );

  doc.end();
  return finished;
}
