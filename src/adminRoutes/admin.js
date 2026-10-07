import express from "express";
import db, { withTransaction } from "../database/pg.js";
import { brand } from "../config/brand.js";
import { requireAdmin, requireCounter } from "../middleware/auth.js";
import { cancelBooking } from "../services/refundService.js";
import { buildLayout, insertCells } from "../services/seatLayout.js";
import {
  generateBookingRef,
  generateQrHash,
  parsePassengers,
} from "../routes/bookings.js";
import { queueBroadcastEmail } from "../services/queueService.js";
import { HttpError, handle } from "../utils/httpError.js";
import { toInternationalPhone, isValidEmail } from "../utils/format.js";

const router = express.Router();
// Counter staff may list departures and issue cash tickets; everything else here is administrator-only.
const COUNTER_ROUTES = new Set([
  "GET /api/admin/trips",
  "POST /api/admin/counter-booking",
]);
router.use("/admin", (req, res, next) =>
  (COUNTER_ROUTES.has(`${req.method} ${req.baseUrl}${req.path}`)
    ? requireCounter
    : requireAdmin)(req, res, next),
);

const HOLD_MINUTES = brand.boarding.seatHoldMinutes;
const isId = (value) => /^\d{1,18}$/.test(String(value));
const needId = (value, message = "Invalid identifier.") => {
  if (!isId(value)) throw new HttpError(400, message);
  return String(value);
};

/* ------------------------------------------------------------------ */
/* Departures                                                          */
/* ------------------------------------------------------------------ */

/** GET /api/admin/trips - upcoming departures with occupancy */
router.get(
  "/admin/trips",
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT
         t.id, t.bus_id, t.travel_date, t.departure_time, t.travel_shift, t.price_fcfa, t.status,
         buses.bus_number, buses.total_seats,
         p1.city AS origin_city, p1.park_name AS origin_park,
         p2.city AS destination_city, p2.park_name AS destination_park,
         (SELECT COUNT(*) FROM booking_seats bs JOIN bookings b ON bs.booking_id = b.id
           WHERE b.trip_id = t.id AND b.status = 'confirmed') AS booked_seats
       FROM trips t
       JOIN routes r ON t.route_id = r.id
       JOIN buses ON t.bus_id = buses.id
       JOIN agencies_parks p1 ON r.origin_park_id = p1.id
       JOIN agencies_parks p2 ON r.destination_park_id = p2.id
       WHERE t.travel_date >= (NOW() AT TIME ZONE $1)::date
       ORDER BY t.travel_date ASC, t.departure_time ASC`,
      [brand.timezone],
    );
    res.json({ success: true, trips: rows });
  }),
);

/** POST /api/admin/schedules - publish a departure */
router.post(
  "/admin/schedules",
  handle(async (req, res) => {
    const originParkId = needId(
      req.body?.originParkId,
      "Select a departure terminal.",
    );
    const destinationParkId = needId(
      req.body?.destinationParkId,
      "Select a destination terminal.",
    );
    const busId = needId(req.body?.busId, "Select a bus.");
    const departureDate = String(req.body?.departureDate ?? "");
    const departureTime = String(req.body?.departureTime ?? "");
    const fare = Number.parseInt(req.body?.farePrice, 10);

    if (originParkId === destinationParkId) {
      throw new HttpError(
        400,
        "The departure and destination terminals must be different.",
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate))
      throw new HttpError(400, "Select a valid travel date.");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(departureTime))
      throw new HttpError(400, "Select a valid departure time.");
    if (!Number.isInteger(fare) || fare < 500 || fare > 500000)
      throw new HttpError(400, "Enter a valid fare in XAF.");

    // The DB only accepts 'morning' or 'evening'; derive it from the departure time.
    const shift =
      Number(departureTime.slice(0, 2)) >= 12 ? "evening" : "morning";

    const trip = await withTransaction(async (client) => {
      const today = await client.query(
        "SELECT ($1::date >= (NOW() AT TIME ZONE $2)::date) AS ok",
        [departureDate, brand.timezone],
      );
      if (!today.rows[0].ok)
        throw new HttpError(400, "The travel date cannot be in the past.");

      const bus = await client.query(
        "SELECT is_active FROM buses WHERE id = $1",
        [busId],
      );
      if (!bus.rows[0]) throw new HttpError(404, "Bus not found.");
      if (!bus.rows[0].is_active)
        throw new HttpError(
          409,
          "This bus is not operational and cannot be scheduled.",
        );

      const existing = await client.query(
        "SELECT id FROM routes WHERE origin_park_id = $1 AND destination_park_id = $2 LIMIT 1",
        [originParkId, destinationParkId],
      );
      let routeId = existing.rows[0]?.id;
      if (!routeId) {
        const created = await client.query(
          "INSERT INTO routes (origin_park_id, destination_park_id) VALUES ($1, $2) RETURNING id",
          [originParkId, destinationParkId],
        );
        routeId = created.rows[0].id;
      }

      const duplicate = await client.query(
        `SELECT 1 FROM trips WHERE bus_id = $1 AND travel_date = $2 AND departure_time = $3 AND status = 'open'`,
        [busId, departureDate, departureTime],
      );
      if (duplicate.rows.length > 0)
        throw new HttpError(
          409,
          "This bus already has a departure at that date and time.",
        );

      const inserted = await client.query(
        `INSERT INTO trips (route_id, bus_id, travel_date, departure_time, travel_shift, price_fcfa, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'open') RETURNING id`,
        [routeId, busId, departureDate, departureTime, shift, fare],
      );
      return inserted.rows[0];
    }).catch((error) => {
      if (error.code === "23503")
        throw new HttpError(
          400,
          "The selected terminal or bus does not exist.",
        );
      throw error;
    });

    res
      .status(201)
      .json({ success: true, message: "Departure published.", trip });
  }, "We could not publish this departure."),
);

/** PATCH /api/admin/trips/:id/cancel - withdraw a departure; `refundAll` first cancels and fully refunds every paid booking */
router.patch(
  "/admin/trips/:id/cancel",
  handle(async (req, res) => {
    const tripId = needId(req.params.id);

    let refunded = 0;
    if (req.body?.refundAll === true) {
      const { rows: paid } = await db.query(
        "SELECT id, total_amount_fcfa FROM bookings WHERE trip_id = $1 AND status = 'confirmed' ORDER BY id",
        [tripId],
      );
      let failed = 0;
      for (const booking of paid) {
        try {
          await cancelBooking({
            bookingId: booking.id,
            adminId: req.user.id,
            reason: "Departure cancelled by the operator",
            refundAmount: booking.total_amount_fcfa,
          });
          refunded += 1;
        } catch (error) {
          failed += 1;
          console.error(`[Trip cancel] Booking ${booking.id}:`, error.message);
        }
      }
      if (failed > 0) {
        throw new HttpError(
          409,
          `${refunded} booking(s) were cancelled but ${failed} could not be. Open Bookings to finish them, then withdraw the departure again.`,
        );
      }
    }

    await withTransaction(async (client) => {
      await client.query("SELECT id FROM trips WHERE id = $1 FOR UPDATE", [
        tripId,
      ]);
      const paid = await client.query(
        "SELECT 1 FROM bookings WHERE trip_id = $1 AND status = 'confirmed' LIMIT 1",
        [tripId],
      );
      if (paid.rows.length > 0) {
        throw new HttpError(
          409,
          "This departure has confirmed passengers. Cancel and refund them first.",
        );
      }
      await client.query(
        "UPDATE bookings SET status = 'cancelled' WHERE trip_id = $1 AND status = 'pending'",
        [tripId],
      );
      const result = await client.query(
        "UPDATE trips SET status = 'cancelled' WHERE id = $1 AND status = 'open' RETURNING id",
        [tripId],
      );
      if (!result.rows[0])
        throw new HttpError(404, "Departure not found or already closed.");
    });

    res.json({
      success: true,
      message: refunded
        ? `Departure withdrawn. ${refunded} booking(s) refunded in full.`
        : "Departure withdrawn.",
    });
  }),
);

/* ------------------------------------------------------------------ */
/* Counter (walk-in cash) sales                                        */
/* ------------------------------------------------------------------ */

router.post(
  "/admin/counter-booking",
  handle(async (req, res) => {
    const tripId = needId(req.body?.tripId, "Select a departure.");
    const passengers = parsePassengers(req.body?.passengers);
    const seatIds = passengers.map((p) => p.seatId);
    const phone = toInternationalPhone(req.body?.passengerPhone);

    const booking = await withTransaction(async (client) => {
      const tripRes = await client.query(
        `SELECT t.id, t.bus_id, t.price_fcfa, t.status,
                EXTRACT(EPOCH FROM ((t.travel_date + t.departure_time) - (NOW() AT TIME ZONE $2))) / 60 AS minutes_to_departure
           FROM trips t WHERE t.id = $1 FOR UPDATE`,
        [tripId, brand.timezone],
      );
      const trip = tripRes.rows[0];
      if (!trip || trip.status !== "open")
        throw new HttpError(404, "This departure is not available.");
      if (Number(trip.minutes_to_departure) < 0)
        throw new HttpError(409, "This bus has already departed.");

      const validSeats = await client.query(
        "SELECT id FROM bus_seats WHERE bus_id = $1 AND id = ANY($2::bigint[]) AND is_aisle = false",
        [trip.bus_id, seatIds],
      );
      if (validSeats.rows.length !== seatIds.length)
        throw new HttpError(
          400,
          "The selected seats do not belong to this bus.",
        );

      const conflict = await client.query(
        `SELECT 1 FROM booking_seats bs JOIN bookings b ON bs.booking_id = b.id
          WHERE b.trip_id = $1 AND bs.seat_id = ANY($2::bigint[])
            AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.created_at >= NOW() - make_interval(mins => $3)))
          LIMIT 1`,
        [tripId, seatIds, HOLD_MINUTES],
      );
      if (conflict.rows.length > 0)
        throw new HttpError(
          409,
          "One or more selected seats are already reserved or paid for.",
        );

      const total = Number(trip.price_fcfa) * passengers.length;
      const lead = passengers[0];
      const created = await client.query(
        `INSERT INTO bookings
           (user_id, trip_id, booking_ref, qr_code_hash, total_amount_fcfa, status, payment_method,
            passenger_name, passenger_phone, id_card_number)
         VALUES ($1, $2, $3, $4, $5, 'confirmed', 'cash_counter', $6, $7, $8)
         RETURNING id, booking_ref, total_amount_fcfa, status`,
        [
          req.user.id,
          tripId,
          await generateBookingRef(client),
          generateQrHash(),
          total,
          lead.name,
          phone,
          lead.idCardNumber,
        ],
      );

      for (const passenger of passengers) {
        await client.query(
          `INSERT INTO booking_seats
             (booking_id, seat_id, passenger_name, passenger_age, passenger_gender, discussion_preference, id_card_number, is_counter_booking)
           VALUES ($1, $2, $3, $4, $5, 'no_preference', $6, true)`,
          [
            created.rows[0].id,
            passenger.seatId,
            passenger.name,
            passenger.age,
            passenger.gender,
            passenger.idCardNumber,
          ],
        );
      }
      return created.rows[0];
    });

    res.status(201).json({
      success: true,
      message: "Ticket issued and seats confirmed.",
      booking,
    });
  }, "We could not issue this ticket."),
);

/* ------------------------------------------------------------------ */
/* Analytics                                                           */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/analytics",
  handle(async (req, res) => {
    const { period = "today", startDate, endDate } = req.query;

    let timeFilter =
      "b.created_at >= (NOW() AT TIME ZONE 'Africa/Douala')::date";
    let params = [];

    if (period === "week") {
      timeFilter = "b.created_at >= NOW() - INTERVAL '7 days'";
    } else if (period === "month") {
      timeFilter = "b.created_at >= NOW() - INTERVAL '30 days'";
    } else if (period === "custom") {
      const valid = /^\d{4}-\d{2}-\d{2}$/;
      if (!valid.test(String(startDate)) || !valid.test(String(endDate))) {
        throw new HttpError(400, "Select a valid date range.");
      }
      timeFilter =
        "b.created_at >= $1::date AND b.created_at < ($2::date + INTERVAL '1 day')";
      params = [startDate, endDate];
    }

    const seatCount =
      "(SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = b.id)";

    // What the agency actually receives: fare plus its terminal fee online, the cash collected at the counter.
    const agencyShare = `CASE WHEN COALESCE(b.payment_method, 'momo') = 'cash_counter' THEN b.total_amount_fcfa
        ELSE (t.price_fcfa + ${Number(brand.pricing.terminalFeePerSeat)}) * ${seatCount} END`;
    const [stats, agencies, underbooked] = await Promise.all([
      db.query(
        `SELECT
           COALESCE(SUM(${seatCount}), 0) AS total_tickets,
           COALESCE(SUM(${agencyShare}), 0) AS total_revenue,
           COALESCE(SUM(CASE WHEN b.payment_method = 'cash_counter' THEN b.total_amount_fcfa ELSE 0 END), 0) AS counter_revenue,
           COALESCE(SUM(CASE WHEN COALESCE(b.payment_method, 'momo') <> 'cash_counter' THEN ${agencyShare} ELSE 0 END), 0) AS momo_revenue
         FROM bookings b
         JOIN trips t ON t.id = b.trip_id
         WHERE b.status = 'confirmed' AND ${timeFilter}`,
        params,
      ),
      db.query(
        `SELECT ap.id AS agency_id, ap.park_name AS agency_name, ap.city,
                COALESCE(SUM(${seatCount}), 0) AS tickets_sold,
                COALESCE(SUM(${agencyShare}), 0) AS revenue_fcfa
           FROM agencies_parks ap
           LEFT JOIN routes r ON r.origin_park_id = ap.id
           LEFT JOIN trips t ON t.route_id = r.id
           LEFT JOIN bookings b ON b.trip_id = t.id AND b.status = 'confirmed' AND ${timeFilter}
          GROUP BY ap.id, ap.park_name, ap.city
          ORDER BY revenue_fcfa DESC, ap.park_name ASC`,
        params,
      ),
      db.query(
        `SELECT t.id AS trip_id, t.travel_date, t.departure_time,
                buses.id AS bus_id, buses.bus_number, buses.total_seats,
                p1.park_name AS origin, p2.park_name AS destination,
                COUNT(bs.id) AS booked_seats,
                ROUND((COUNT(bs.id)::decimal / NULLIF(buses.total_seats, 0)) * 100, 1) AS occupancy_rate
           FROM trips t
           JOIN buses ON t.bus_id = buses.id
           JOIN routes r ON t.route_id = r.id
           JOIN agencies_parks p1 ON r.origin_park_id = p1.id
           JOIN agencies_parks p2 ON r.destination_park_id = p2.id
           LEFT JOIN bookings b ON b.trip_id = t.id AND b.status = 'confirmed'
           LEFT JOIN booking_seats bs ON bs.booking_id = b.id
          WHERE t.status = 'open' AND t.travel_date >= (NOW() AT TIME ZONE 'Africa/Douala')::date
          GROUP BY t.id, buses.id, p1.park_name, p2.park_name
         HAVING (COUNT(bs.id)::decimal / NULLIF(buses.total_seats, 0)) < 0.40
          ORDER BY t.travel_date ASC, t.departure_time ASC`,
      ),
    ]);

    res.json({
      success: true,
      stats: stats.rows[0],
      agencies: agencies.rows,
      underbooked: underbooked.rows,
    });
  }, "We could not load the metrics right now."),
);

/* ------------------------------------------------------------------ */
/* Passenger broadcast                                                 */
/* ------------------------------------------------------------------ */

router.post(
  "/admin/broadcast",
  handle(async (req, res) => {
    const tripId = needId(req.body?.tripId, "Select a departure.");
    const subject = String(req.body?.subject ?? "").trim();
    const messageBody = String(req.body?.messageBody ?? "").trim();

    if (subject.length < 3 || subject.length > 150)
      throw new HttpError(400, "Enter a subject of up to 150 characters.");
    if (messageBody.length < 5 || messageBody.length > 2000)
      throw new HttpError(400, "Enter a message of up to 2000 characters.");

    const tripRes = await db.query(
      `SELECT t.travel_date, t.departure_time, t.travel_shift, buses.bus_number, buses.bus_type,
              p1.city AS origin_city, p1.park_name AS origin_park,
              p2.city AS destination_city, p2.park_name AS destination_park
         FROM trips t
         JOIN routes r ON t.route_id = r.id
         JOIN buses ON t.bus_id = buses.id
         JOIN agencies_parks p1 ON r.origin_park_id = p1.id
         JOIN agencies_parks p2 ON r.destination_park_id = p2.id
        WHERE t.id = $1`,
      [tripId],
    );
    const row = tripRes.rows[0];
    if (!row) throw new HttpError(404, "Departure not found.");

    const trip = {
      originCity: row.origin_city,
      originPark: row.origin_park,
      destinationCity: row.destination_city,
      destinationPark: row.destination_park,
      travelDate: row.travel_date,
      departureTime: row.departure_time,
      travelShift: row.travel_shift,
      busNumber: row.bus_number,
      busType: row.bus_type,
    };

    const recipients = await db.query(
      `SELECT DISTINCT ON (LOWER(COALESCE(b.passenger_email, u.email)))
              COALESCE(b.passenger_email, u.email) AS email,
              COALESCE(u.full_name, b.passenger_name) AS name,
              b.qr_code_hash
         FROM bookings b
         LEFT JOIN users u ON u.id = b.user_id
        WHERE b.trip_id = $1 AND b.status = 'confirmed' AND COALESCE(b.payment_method, 'momo') <> 'cash_counter'
          AND COALESCE(b.passenger_email, u.email) IS NOT NULL`,
      [tripId],
    );

    const valid = recipients.rows.filter((r) => isValidEmail(r.email));
    if (valid.length === 0) {
      throw new HttpError(
        404,
        "No passenger email addresses were found for this departure.",
      );
    }

    const results = await Promise.allSettled(
      valid.map((r) =>
        queueBroadcastEmail({
          toEmail: r.email,
          toName: r.name,
          subject,
          messageBody,
          trip,
          qrCodeHash: r.qr_code_hash,
        }),
      ),
    );
    const sent = results.filter((r) => r.status === "fulfilled").length;

    res.json({
      success: true,
      message: `Notice sent to ${sent} passenger${sent === 1 ? "" : "s"}${sent < valid.length ? `; ${valid.length - sent} could not be queued` : ""}.`,
    });
  }, "We could not send the notice."),
);

/* ------------------------------------------------------------------ */
/* Fleet                                                               */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/buses",
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, bus_number, park_id, total_seats, bus_type, is_active FROM buses ORDER BY bus_number ASC`,
    );
    res.json({ success: true, buses: rows });
  }),
);

router.get(
  "/admin/parks/:parkId/buses",
  handle(async (req, res) => {
    const parkId = needId(req.params.parkId);
    const { rows } = await db.query(
      `SELECT id, bus_number, park_id, total_seats, bus_type, is_active FROM buses WHERE park_id = $1 ORDER BY bus_number ASC`,
      [parkId],
    );
    res.json({ success: true, buses: rows });
  }),
);

router.post(
  "/admin/buses",
  handle(async (req, res) => {
    const parkId = needId(req.body?.parkId, "Select a terminal.");
    const busNumber = String(req.body?.busNumber ?? "")
      .trim()
      .toUpperCase();
    const busType =
      String(req.body?.busType ?? "Classic")
        .trim()
        .slice(0, 40) || "Classic";
    const capacity = Number.parseInt(req.body?.totalSeats, 10);

    if (busNumber.length < 3 || busNumber.length > 20)
      throw new HttpError(400, "Enter the bus registration number.");
    if (!Number.isInteger(capacity) || capacity < 5 || capacity > 100) {
      throw new HttpError(400, "Seat capacity must be between 5 and 100.");
    }

    const cells = buildLayout(capacity);

    try {
      const bus = await withTransaction(async (client) => {
        const created = await client.query(
          `INSERT INTO buses (park_id, bus_number, bus_type, total_seats, is_active)
           VALUES ($1, $2, $3, $4, true) RETURNING id, bus_number, bus_type, total_seats`,
          [parkId, busNumber, busType, capacity],
        );
        await insertCells(client, created.rows[0].id, cells);
        return created.rows[0];
      });
      res.status(201).json({
        success: true,
        message: `Bus ${bus.bus_number} registered with ${capacity} seats.`,
        bus,
      });
    } catch (error) {
      if (error.code === "23505")
        throw new HttpError(
          409,
          "A bus with this registration number already exists.",
        );
      if (error.code === "23503")
        throw new HttpError(400, "The selected terminal does not exist.");
      throw error;
    }
  }, "We could not register this bus."),
);

router.patch(
  "/admin/buses/:busId/status",
  handle(async (req, res) => {
    const busId = needId(req.params.busId);
    if (typeof req.body?.isActive !== "boolean")
      throw new HttpError(400, "Provide the new operational status.");

    const { rows } = await db.query(
      "UPDATE buses SET is_active = $1 WHERE id = $2 RETURNING id, bus_number, is_active",
      [req.body.isActive, busId],
    );
    if (!rows[0]) throw new HttpError(404, "Bus not found.");
    res.json({ success: true, bus: rows[0] });
  }),
);

/* ------------------------------------------------------------------ */
/* Terminals                                                           */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/agencies-parks",
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, city, park_name, address_description, momo_number, is_active FROM agencies_parks ORDER BY city ASC, park_name ASC`,
    );
    res.json({ success: true, agencyParks: rows });
  }),
);

router.put(
  "/admin/agencies-parks/:id/momo",
  handle(async (req, res) => {
    const parkId = needId(req.params.id);
    const momo = toInternationalPhone(req.body?.momoNumber);
    if (!momo)
      throw new HttpError(
        400,
        "Enter a valid 9-digit Cameroon number starting with 6.",
      );

    const { rows } = await db.query(
      "UPDATE agencies_parks SET momo_number = $1 WHERE id = $2 RETURNING id, park_name, momo_number",
      [momo, parkId],
    );
    if (!rows[0]) throw new HttpError(404, "Terminal not found.");
    res.json({
      success: true,
      message: "Payout number updated.",
      agencyPark: rows[0],
    });
  }),
);

export default router;
