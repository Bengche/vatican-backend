import express from "express";
import db, { withTransaction } from "../database/pg.js";
import { brand } from "../config/brand.js";
import { requireAdmin } from "../middleware/auth.js";
import { HttpError, handle } from "../utils/httpError.js";

const router = express.Router();
router.use("/admin/issues", requireAdmin);

const isId = (value) => /^\d{1,18}$/.test(String(value));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/issues
 * Everything that needs a manager after devices worked offline: seats sold twice, sales the server
 * could not accept, Mobile Money payments nobody has checked, and boardings that did not add up.
 */
router.get(
  "/admin/issues",
  handle(async (req, res) => {
    const sales = await db.query(
      `SELECT os.id, os.result, os.detail, os.booking_ref, os.booking_id, os.late_entry,
              os.sold_at, os.received_at, d.label AS device_label, u.full_name AS agent,
              b.trip_id, b.total_amount_fcfa, b.status AS booking_status,
              t.travel_date, t.departure_time, t.bus_id,
              p1.city AS origin_city, p2.city AS destination_city,
              COALESCE((SELECT json_agg(json_build_object('seat_id', bs.seat_id, 'seat_label', bseats.seat_label, 'name', bs.passenger_name) ORDER BY bs.id)
                          FROM booking_seats bs JOIN bus_seats bseats ON bseats.id = bs.seat_id
                         WHERE bs.booking_id = b.id), '[]'::json) AS passengers
         FROM offline_sales os
         LEFT JOIN devices d ON d.id = os.device_id
         LEFT JOIN users u ON u.id = os.user_id
         LEFT JOIN bookings b ON b.id = os.booking_id
         LEFT JOIN trips t ON t.id = b.trip_id
         LEFT JOIN routes r ON r.id = t.route_id
         LEFT JOIN agencies_parks p1 ON p1.id = r.origin_park_id
         LEFT JOIN agencies_parks p2 ON p2.id = r.destination_park_id
        WHERE os.result IN ('flagged', 'rejected') AND os.live = FALSE AND os.resolved_at IS NULL
        ORDER BY os.received_at DESC
        LIMIT 100`,
    );

    const payments = await db.query(
      `SELECT b.id, b.booking_ref, b.payment_ref, b.total_amount_fcfa, b.created_at, b.status,
              u.full_name AS agent, p1.city AS origin_city, p2.city AS destination_city, t.travel_date
         FROM bookings b
         JOIN trips t ON t.id = b.trip_id
         JOIN routes r ON r.id = t.route_id
         JOIN agencies_parks p1 ON p1.id = r.origin_park_id
         JOIN agencies_parks p2 ON p2.id = r.destination_park_id
         LEFT JOIN users u ON u.id = b.user_id
        WHERE b.payment_unverified = TRUE AND b.status = 'confirmed'
        ORDER BY b.created_at DESC
        LIMIT 100`,
    );

    const gate = await db.query(
      `SELECT ge.id, ge.result, ge.detail, ge.scanned_at, b.booking_ref, d.label AS device_label, u.full_name AS agent
         FROM gate_events ge
         LEFT JOIN bookings b ON b.id = ge.booking_id
         LEFT JOIN devices d ON d.id = ge.device_id
         LEFT JOIN users u ON u.id = ge.user_id
        WHERE ge.result IN ('duplicate', 'rejected') AND ge.resolved_at IS NULL
        ORDER BY ge.received_at DESC
        LIMIT 100`,
    );

    res.json({
      success: true,
      sales: sales.rows,
      payments: payments.rows,
      gate: gate.rows,
      total: sales.rows.length + payments.rows.length + gate.rows.length,
    });
  }),
);

/** GET /api/admin/issues/count - small number for the navigation badge */
router.get(
  "/admin/issues/count",
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM offline_sales WHERE result IN ('flagged', 'rejected') AND live = FALSE AND resolved_at IS NULL)
       + (SELECT COUNT(*) FROM bookings WHERE payment_unverified = TRUE AND status = 'confirmed')
       + (SELECT COUNT(*) FROM gate_events WHERE result IN ('duplicate', 'rejected') AND resolved_at IS NULL) AS total`,
    );
    res.json({ success: true, total: Number(rows[0].total) });
  }),
);

const note = (value) => String(value ?? "").trim().slice(0, 300) || null;

/** POST /api/admin/issues/sales/:id/resolve */
router.post(
  "/admin/issues/sales/:id/resolve",
  handle(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "Invalid item.");
    const { rowCount } = await db.query(
      `UPDATE offline_sales SET resolved_at = NOW(), resolved_by = $2, resolution = $3
        WHERE id = $1 AND resolved_at IS NULL`,
      [req.params.id, req.user.id, note(req.body?.note)],
    );
    if (!rowCount) throw new HttpError(404, "Item not found or already resolved.");
    res.json({ success: true });
  }),
);

/** POST /api/admin/issues/gate/:id/resolve */
router.post(
  "/admin/issues/gate/:id/resolve",
  handle(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "Invalid item.");
    const { rowCount } = await db.query(
      `UPDATE gate_events SET resolved_at = NOW(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL`,
      [req.params.id, req.user.id],
    );
    if (!rowCount) throw new HttpError(404, "Item not found or already resolved.");
    res.json({ success: true });
  }),
);

/** POST /api/admin/issues/payments/:bookingId/verify - the Mobile Money transaction was checked */
router.post(
  "/admin/issues/payments/:bookingId/verify",
  handle(async (req, res) => {
    if (!isId(req.params.bookingId)) throw new HttpError(400, "Invalid booking.");
    const { rowCount } = await db.query(
      `UPDATE bookings SET payment_unverified = FALSE WHERE id = $1 AND payment_unverified = TRUE`,
      [req.params.bookingId],
    );
    if (!rowCount) throw new HttpError(404, "Payment not found or already verified.");
    res.json({ success: true });
  }),
);

/**
 * POST /api/admin/issues/move-seat  { bookingId, fromSeatId, toSeatId }
 * Moves one passenger to a free seat on the same bus, used to settle a seat that was sold twice.
 */
router.post(
  "/admin/issues/move-seat",
  handle(async (req, res) => {
    const { bookingId, fromSeatId, toSeatId } = req.body ?? {};
    if (![bookingId, fromSeatId, toSeatId].every(isId)) throw new HttpError(400, "Choose the passenger and the new seat.");

    await withTransaction(async (client) => {
      const booking = await client.query(
        `SELECT b.id, b.trip_id, b.status, t.bus_id FROM bookings b JOIN trips t ON t.id = b.trip_id WHERE b.id = $1`,
        [bookingId],
      );
      const row = booking.rows[0];
      if (!row) throw new HttpError(404, "Booking not found.");
      if (row.status !== "confirmed") throw new HttpError(409, "Only confirmed bookings can be moved.");
      await client.query("SELECT 1 FROM trips WHERE id = $1 FOR UPDATE", [row.trip_id]);

      const held = await client.query(
        "SELECT 1 FROM booking_seats WHERE booking_id = $1 AND seat_id = $2",
        [bookingId, fromSeatId],
      );
      if (!held.rows[0]) throw new HttpError(404, "That passenger is not on this booking.");

      const target = await client.query(
        "SELECT id FROM bus_seats WHERE id = $1 AND bus_id = $2 AND is_aisle = false",
        [toSeatId, row.bus_id],
      );
      if (!target.rows[0]) throw new HttpError(400, "That seat does not exist on this bus.");

      const taken = await client.query(
        `SELECT 1 FROM booking_seats bs JOIN bookings b ON b.id = bs.booking_id
          WHERE b.trip_id = $1 AND bs.seat_id = $2 AND bs.booking_id <> $3
            AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.created_at >= NOW() - make_interval(mins => $4)))`,
        [row.trip_id, toSeatId, bookingId, brand.boarding.seatHoldMinutes],
      );
      if (taken.rows[0]) throw new HttpError(409, "That seat is already taken. Choose another.");

      await client.query(
        "UPDATE booking_seats SET seat_id = $3 WHERE booking_id = $1 AND seat_id = $2",
        [bookingId, fromSeatId, toSeatId],
      );
    });

    res.json({ success: true });
  }, "We could not move this passenger."),
);

export default router;
