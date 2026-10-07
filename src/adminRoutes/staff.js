import express from "express";
import db from "../database/pg.js";
import { requireAdmin, requireStaff } from "../middleware/auth.js";
import { renderManifestPdf } from "../services/manifestPdf.js";
import { getBookingRecord } from "../services/receiptService.js";
import { HttpError, handle } from "../utils/httpError.js";
import { brand } from "../config/brand.js";

const router = express.Router();
router.use("/admin/gate", requireStaff);

const isId = (value) => /^\d{1,18}$/.test(String(value));

const TRIP_SELECT = `
  SELECT t.id, t.travel_date, t.departure_time, t.travel_shift, t.status,
         buses.bus_number, buses.total_seats,
         p1.city AS origin_city, p1.park_name AS origin_park,
         p2.city AS destination_city, p2.park_name AS destination_park,
         (SELECT COUNT(*) FROM booking_seats bs JOIN bookings b ON bs.booking_id = b.id
           WHERE b.trip_id = t.id AND b.status = 'confirmed') AS booked_seats,
         (SELECT COUNT(*) FROM booking_seats bs JOIN bookings b ON bs.booking_id = b.id
           WHERE b.trip_id = t.id AND b.status = 'confirmed' AND b.is_checked_in) AS boarded_seats
    FROM trips t
    JOIN routes r ON t.route_id = r.id
    JOIN buses ON t.bus_id = buses.id
    JOIN agencies_parks p1 ON r.origin_park_id = p1.id
    JOIN agencies_parks p2 ON r.destination_park_id = p2.id`;

async function loadManifest(tripId) {
  const tripRes = await db.query(`${TRIP_SELECT} WHERE t.id = $1`, [tripId]);
  const trip = tripRes.rows[0];
  if (!trip) throw new HttpError(404, "Departure not found.");

  const { rows } = await db.query(
    `SELECT bseats.seat_label, bs.passenger_name, bs.id_card_number, bs.passenger_age, bs.passenger_gender,
            b.id AS booking_id, b.booking_ref, b.passenger_phone, b.payment_method, b.is_checked_in, b.checked_in_at
       FROM booking_seats bs
       JOIN bookings b ON b.id = bs.booking_id
       JOIN bus_seats bseats ON bseats.id = bs.seat_id
      WHERE b.trip_id = $1 AND b.status = 'confirmed'
      ORDER BY bseats.row_num, bseats.col_num`,
    [tripId],
  );
  return { trip, passengers: rows };
}

/** GET /api/admin/gate/trips - departures from yesterday to the next two weeks */
router.get(
  "/admin/gate/trips",
  handle(async (req, res) => {
    const { rows } = await db.query(
      `${TRIP_SELECT}
        WHERE t.status IN ('open', 'departed') AND t.travel_date BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + 14
        ORDER BY t.travel_date, t.departure_time`,
    );
    res.json({ success: true, trips: rows });
  }),
);

/** GET /api/admin/gate/lookup?q= - find a booking by reference, QR link or QR hash */
router.get(
  "/admin/gate/lookup",
  handle(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) throw new HttpError(400, "Enter a booking reference or scan a ticket.");

    const hash = (q.match(/[a-f0-9]{64}/i) || [])[0]?.toLowerCase();
    const { rows } = await db.query(
      `SELECT id FROM bookings WHERE ($1::text IS NOT NULL AND qr_code_hash = $1) OR UPPER(booking_ref) = UPPER($2) LIMIT 1`,
      [hash ?? null, q.slice(0, 40)],
    );
    if (!rows[0]) throw new HttpError(404, "No ticket matches that reference.");

    const record = await getBookingRecord(rows[0].id);
    const today = await db.query(`SELECT CURRENT_DATE::text AS today`);
    res.json({ success: true, booking: record, today: today.rows[0].today });
  }),
);

/** POST /api/admin/gate/check-in/:id - mark a booking as boarded */
router.post(
  "/admin/gate/check-in/:id",
  handle(async (req, res) => {
    if (!isId(req.params.id)) throw new HttpError(400, "Invalid booking.");
    const record = await getBookingRecord(req.params.id);
    if (!record) throw new HttpError(404, "Ticket not found.");

    if (record.booking_status !== "confirmed") throw new HttpError(409, `This ticket is ${record.booking_status} and cannot board.`);

    const today = (await db.query(`SELECT CURRENT_DATE::text AS today`)).rows[0].today;
    if (record.travel_date !== today && !(req.body?.override === true && req.user.role !== "gateman" && req.user.role !== "counter_agent")) {
      throw new HttpError(409, `This ticket is for ${record.travel_date}, not today.`);
    }

    const { rows } = await db.query(
      `UPDATE bookings SET is_checked_in = TRUE, checked_in_at = NOW(), checked_in_by = $2
        WHERE id = $1 AND status = 'confirmed' AND is_checked_in = FALSE RETURNING checked_in_at`,
      [record.booking_id, req.user.id],
    );
    if (!rows[0]) throw new HttpError(409, "This ticket has already boarded.");

    res.json({ success: true, message: "Passenger marked as boarded.", boardedAt: rows[0].checked_in_at });
  }),
);

/** POST /api/admin/gate/undo/:id - administrators can reverse a mistaken check-in */
router.post(
  "/admin/gate/undo/:id",
  requireAdmin,
  handle(async (req, res) => {
    if (!isId(req.params.id)) throw new HttpError(400, "Invalid booking.");
    await db.query(`UPDATE bookings SET is_checked_in = FALSE, checked_in_at = NULL, checked_in_by = NULL WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  }),
);

/** GET /api/admin/gate/manifest/:tripId */
router.get(
  "/admin/gate/manifest/:tripId",
  handle(async (req, res) => {
    if (!isId(req.params.tripId)) throw new HttpError(400, "Invalid departure.");
    res.json({ success: true, ...(await loadManifest(req.params.tripId)) });
  }),
);

/** GET /api/admin/gate/manifest/:tripId/pdf */
router.get(
  "/admin/gate/manifest/:tripId/pdf",
  handle(async (req, res) => {
    if (!isId(req.params.tripId)) throw new HttpError(400, "Invalid departure.");
    const { trip, passengers } = await loadManifest(req.params.tripId);
    const pdf = await renderManifestPdf(trip, passengers);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${brand.refPrefix}-Manifest-${trip.travel_date}-${trip.id}.pdf"`,
      "Content-Length": pdf.length,
      "Cache-Control": "no-store",
    });
    res.send(pdf);
  }),
);

export default router;