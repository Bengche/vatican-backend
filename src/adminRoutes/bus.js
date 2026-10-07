import express from "express";
import db from "../database/pg.js";
import { brand } from "../config/brand.js";
import { HttpError, handle } from "../utils/httpError.js";

const router = express.Router();

/** GET /api/parks - active terminals shown in search forms and on the home page */
router.get(
  "/parks",
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, park_name AS name, city, region, address_description AS address
         FROM agencies_parks
        WHERE is_active IS NOT FALSE
        ORDER BY city ASC, park_name ASC`,
    );
    res.json({ success: true, parks: rows });
  }, "We could not load the terminals right now."),
);

/** GET /api/buses/:busId/layout?tripId=12 - seat map with live availability for a trip */
router.get(
  "/buses/:busId/layout",
  handle(async (req, res) => {
    const { busId } = req.params;
    const { tripId } = req.query;

    if (!/^\d+$/.test(busId)) throw new HttpError(400, "Invalid bus.");
    if (tripId !== undefined && !/^\d+$/.test(String(tripId)))
      throw new HttpError(400, "Invalid trip.");

    const { rows } = await db.query(
      `SELECT
         bs.id,
         bs.bus_id AS "busId",
         bs.seat_label AS "seatLabel",
         bs.row_num AS "rowNum",
         bs.col_num AS "colNum",
         bs.is_aisle AS "isAisle",
         bs.is_window AS "isWindow",
         (bs.is_aisle = false AND booked.seat_id IS NOT NULL) AS "isBooked",
         COALESCE(booked.is_counter_booking, false) AS "isCounterBooking",
         booked.passenger_gender AS "passengerGender",
         booked.passenger_age AS "passengerAge",
         booked.discussion_preference AS "discussionPreference"
       FROM bus_seats bs
       LEFT JOIN (
         SELECT DISTINCT ON (bk.seat_id)
           bk.seat_id, bk.is_counter_booking, bk.passenger_gender, bk.passenger_age, bk.discussion_preference
         FROM booking_seats bk
         JOIN bookings b ON bk.booking_id = b.id
         WHERE ($2::bigint IS NOT NULL AND b.trip_id = $2::bigint)
           AND (b.status = 'confirmed'
                OR (b.status = 'pending' AND b.created_at >= NOW() - make_interval(mins => $3)))
         ORDER BY bk.seat_id, b.created_at DESC
       ) booked ON bs.id = booked.seat_id
       WHERE bs.bus_id = $1
       ORDER BY bs.row_num ASC, bs.col_num ASC`,
      [busId, tripId ?? null, brand.boarding.seatHoldMinutes],
    );

    res.json({ success: true, seats: rows });
  }, "We could not load the seat map right now."),
);

export default router;
