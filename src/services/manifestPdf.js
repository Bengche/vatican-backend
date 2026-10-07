import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import { brand } from "../config/brand.js";
import { formatDate, formatTime } from "../utils/format.js";

const C = brand.colors;
const LOGO_PATH = fileURLToPath(new URL("../assets/logo-mark.png", import.meta.url));
const INK = "#0f172a";
const MUTED = "#64748b";
const LINE = "#e2e8f0";

const PAGE_W = 842;
const PAGE_H = 595;
const MARGIN = 36;
const ROW_H = 24;

// Column layout (landscape A4)
const COLUMNS = [
  { key: "no", label: "No.", width: 32 },
  { key: "seat", label: "Seat", width: 44 },
  { key: "name", label: "Passenger name", width: 220 },
  { key: "id", label: "ID document", width: 120 },
  { key: "age", label: "Age", width: 38 },
  { key: "sex", label: "Sex", width: 38 },
  { key: "phone", label: "Phone", width: 110 },
  { key: "ref", label: "Booking", width: 120 },
  { key: "board", label: "Boarded", width: 48 },
];

const clip = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
};

/** Printable passenger list for one departure. `trip` and `passengers` come from the manifest query. */
export function renderManifestPdf(trip, passengers) {
  const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: MARGIN, bufferPages: true, info: { Title: `Manifest ${trip.origin_city} - ${trip.destination_city}`, Author: brand.name } });
  const chunks = [];

  return new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const header = () => {
      doc.rect(0, 0, PAGE_W, 74).fill(C.primary);
      doc.image(LOGO_PATH, MARGIN, 14, { height: 46 });
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(15).text("PASSENGER MANIFEST", MARGIN + 62, 20, { width: 400 });
      doc.font("Helvetica").fontSize(9).fillColor("#cbd5e1").text(brand.legalName, MARGIN + 62, 41, { width: 400 });

      const meta = [
        `${trip.origin_city} to ${trip.destination_city}`,
        `${formatDate(trip.travel_date)}  |  ${formatTime(trip.departure_time)}`,
        `Bus ${trip.bus_number}  |  ${passengers.length} passenger${passengers.length === 1 ? "" : "s"}`,
      ];
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#ffffff");
      meta.forEach((line, i) => doc.text(line, PAGE_W - MARGIN - 300, 14 + i * 16, { width: 300, align: "right" }));
    };

    const tableHead = (y) => {
      doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, ROW_H).fill(C.primary);
      let x = MARGIN;
      doc.font("Helvetica-Bold").fontSize(8.5).fillColor("#ffffff");
      for (const col of COLUMNS) {
        doc.text(col.label.toUpperCase(), x + 6, y + 8, { width: col.width - 8, lineBreak: false });
        x += col.width;
      }
    };

    header();
    let y = 90;
    tableHead(y);
    y += ROW_H;

    passengers.forEach((p, index) => {
      if (y + ROW_H > PAGE_H - 64) {
        doc.addPage({ size: [PAGE_W, PAGE_H], margin: MARGIN });
        header();
        y = 90;
        tableHead(y);
        y += ROW_H;
      }

      if (index % 2 === 1) doc.rect(MARGIN, y, PAGE_W - MARGIN * 2, ROW_H).fill("#f8fafc");
      doc.moveTo(MARGIN, y + ROW_H).lineTo(PAGE_W - MARGIN, y + ROW_H).lineWidth(0.5).strokeColor(LINE).stroke();

      const cells = {
        no: String(index + 1),
        seat: p.seat_label,
        name: clip(p.passenger_name, 34),
        id: clip(p.id_card_number || "-", 18),
        age: p.passenger_age ?? "-",
        sex: p.passenger_gender ? String(p.passenger_gender).charAt(0).toUpperCase() : "-",
        phone: clip(p.passenger_phone || "-", 16),
        ref: p.booking_ref,
        board: "",
      };

      let x = MARGIN;
      doc.font("Helvetica").fontSize(9).fillColor(INK);
      for (const col of COLUMNS) {
        if (col.key === "seat" || col.key === "name") doc.font("Helvetica-Bold");
        else doc.font("Helvetica");
        if (col.key === "board") {
          doc.roundedRect(x + 14, y + 6, 12, 12, 2).lineWidth(0.8).strokeColor(MUTED).stroke();
          if (p.is_checked_in) doc.font("Helvetica-Bold").fontSize(10).fillColor(C.primary).text("X", x + 16.5, y + 7.5, { lineBreak: false });
          doc.fontSize(9).fillColor(INK);
        } else {
          doc.text(String(cells[col.key]), x + 6, y + 8, { width: col.width - 8, lineBreak: false });
        }
        x += col.width;
      }
      y += ROW_H;
    });

    if (passengers.length === 0) {
      doc.font("Helvetica").fontSize(11).fillColor(MUTED).text("No confirmed passengers on this departure.", MARGIN, y + 16);
    }

    // Signature block on the last page
    const sigY = Math.min(y + 30, PAGE_H - 70);
    doc.font("Helvetica").fontSize(9).fillColor(MUTED);
    doc.moveTo(MARGIN, sigY + 22).lineTo(MARGIN + 220, sigY + 22).lineWidth(0.7).strokeColor(MUTED).stroke();
    doc.text("Driver name and signature", MARGIN, sigY + 27, { lineBreak: false });
    doc.moveTo(MARGIN + 280, sigY + 22).lineTo(MARGIN + 500, sigY + 22).stroke();
    doc.text("Boarding agent name and signature", MARGIN + 280, sigY + 27, { lineBreak: false });

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("Helvetica").fontSize(8).fillColor(MUTED);
      doc.text(
        `${brand.name} passenger manifest  |  Generated ${new Date().toLocaleString("en-GB", { timeZone: brand.timezone })}  |  Page ${i + 1} of ${range.count}`,
        MARGIN,
        PAGE_H - 28,
        { width: PAGE_W - MARGIN * 2, align: "center", lineBreak: false },
      );
    }

    doc.end();
  });
}