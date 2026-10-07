import express from "express";
import db from "../database/pg.js";
import { brand } from "../config/brand.js";
import { quoteFare } from "../services/pricing.js";
import { HttpError, handle } from "../utils/httpError.js";

const router = express.Router();

const HOLD_MINUTES = brand.boarding.seatHoldMinutes;
const CUTOFF_MINUTES = brand.boarding.onlineSalesCutoffMinutes;

// Reusable fragments: departures still on sale, and seats currently taken or held.
const ON_SALE = `
  t.status = 'open'
  AND b.is_active = true
  AND (t.travel_date + t.departure_time) > (NOW() AT TIME ZONE $TZ) + make_interval(mins => $CUT)`;

const BOOKED_SEATS = `
  (SELECT COUNT(*) FROM booking_seats bs
     JOIN bookings bk ON bs.booking_id = bk.id
    WHERE bk.trip_id = t.id
      AND (bk.status = 'confirmed'
           OR (bk.status = 'pending' AND bk.created_at >= NOW() - make_interval(mins => $HOLD))))`;

const sql = (template, tz, cut, hold) =>
  template
    .replaceAll("$TZ", `$${tz}`)
    .replaceAll("$CUT", `$${cut}`)
    .replaceAll("$HOLD", `$${hold}`);

const TRIP_COLUMNS = `
  t.id,
  t.travel_date AS "travelDate",
  t.departure_time AS "departureTime",
  t.travel_shift AS "travelShift",
  t.price_fcfa AS "price",
  t.price_fcfa AS "farePrice",
  t.status,
  b.id AS "busId",
  b.bus_number AS "busNumber",
  b.bus_type AS "busType",
  b.total_seats AS "capacity",
  p1.id AS "fromParkId",
  p2.id AS "toParkId",
  p1.city AS "fromCity",
  p2.city AS "toCity",
  p1.park_name AS "fromParkName",
  p2.park_name AS "toParkName"`;

const TRIP_JOINS = `
  FROM trips t
  JOIN routes r ON t.route_id = r.id
  JOIN buses b ON t.bus_id = b.id
  JOIN agencies_parks p1 ON r.origin_park_id = p1.id
  JOIN agencies_parks p2 ON r.destination_park_id = p2.id`;

const withAvailability = (row) => ({
  ...row,
  availableSeats: Math.max(0, Number(row.capacity) - Number(row.bookedSeats)),
});

/** GET /api/trips/search?fromPark=1&toPark=2&travelDate=2026-10-21 */
router.get(
  "/trips/search",
  handle(async (req, res) => {
    const { fromPark, toPark, travelDate } = req.query;

    if (
      !/^\d+$/.test(String(fromPark)) ||
      !/^\d+$/.test(String(toPark)) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(travelDate))
    ) {
      throw new HttpError(
        400,
        "Select a departure, a destination and a travel date.",
      );
    }

    const { rows } = await db.query(
      `SELECT ${TRIP_COLUMNS}, ${sql(BOOKED_SEATS, 4, 5, 6)} AS "bookedSeats"
       ${TRIP_JOINS}
       WHERE r.origin_park_id = $1 AND r.destination_park_id = $2 AND t.travel_date = $3
         AND ${sql(ON_SALE, 4, 5, 6)}
       ORDER BY t.departure_time ASC`,
      [
        fromPark,
        toPark,
        travelDate,
        brand.timezone,
        CUTOFF_MINUTES,
        HOLD_MINUTES,
      ],
    );

    res.json({ success: true, trips: rows.map(withAvailability) });
  }, "We could not search departures right now."),
);

/** GET /api/trips/upcoming - next departures shown on the home page */
router.get(
  "/trips/upcoming",
  handle(async (req, res) => {
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 8, 1),
      20,
    );

    const { rows } = await db.query(
      `SELECT ${TRIP_COLUMNS}, ${sql(BOOKED_SEATS, 1, 2, 3)} AS "bookedSeats"
       ${TRIP_JOINS}
       WHERE ${sql(ON_SALE, 1, 2, 3)}
       ORDER BY t.travel_date ASC, t.departure_time ASC
       LIMIT $4`,
      [brand.timezone, CUTOFF_MINUTES, HOLD_MINUTES, limit],
    );

    res.json({ success: true, trips: rows.map(withAvailability) });
  }),
);

/** GET /api/trips/:id/quote?seats=2 - authoritative fare breakdown */
router.get(
  "/trips/:id/quote",
  handle(async (req, res) => {
    const seats = Number.parseInt(req.query.seats, 10);
    if (
      !/^\d+$/.test(req.params.id) ||
      !Number.isInteger(seats) ||
      seats < 1 ||
      seats > 8
    ) {
      throw new HttpError(400, "Invalid quote request.");
    }

    const { rows } = await db.query(
      "SELECT price_fcfa FROM trips WHERE id = $1",
      [req.params.id],
    );
    if (!rows[0])
      throw new HttpError(404, "This departure is no longer available.");

    res.json({ success: true, quote: quoteFare(rows[0].price_fcfa, seats) });
  }),
);

export default router;
