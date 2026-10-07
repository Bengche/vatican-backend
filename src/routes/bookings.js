import express from "express";
import crypto from "crypto";
import db, { withTransaction } from "../database/pg.js";
import { brand } from "../config/brand.js";
import { authenticateToken, isAdminRole } from "../middleware/auth.js";
import {
  acquireSeatLocks,
  releaseSeatLocks,
} from "../services/seatLockService.js";
import { quoteFare } from "../services/pricing.js";
import {
  getBookingRecord,
  listConfirmedBookingsForUser,
} from "../services/receiptService.js";
import { renderTicketPdf } from "../services/ticketPdf.js";
import { HttpError, handle } from "../utils/httpError.js";
import { isValidEmail } from "../utils/format.js";

const router = express.Router();

const HOLD_MINUTES = brand.boarding.seatHoldMinutes;
const MAX_SEATS_PER_BOOKING = 8;
const GENDERS = ["male", "female", "other"];
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const randomCode = (length) =>
  Array.from(
    crypto.randomBytes(length),
    (byte) => REF_ALPHABET[byte % REF_ALPHABET.length],
  ).join("");

export async function generateBookingRef(runner, prefix = brand.refPrefix) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ref = `${prefix}-${randomCode(6)}`;
    const exists = await runner.query(
      "SELECT 1 FROM bookings WHERE booking_ref = $1",
      [ref],
    );
    if (exists.rows.length === 0) return ref;
  }
  throw new Error("Could not allocate a unique booking reference.");
}

export const generateQrHash = () => crypto.randomBytes(32).toString("hex");

/** Validates the per-seat passenger list shared by online and counter bookings. */
export function parsePassengers(rawPassengers, { requireAge = true } = {}) {
  if (!Array.isArray(rawPassengers) || rawPassengers.length === 0) {
    throw new HttpError(400, "Please select at least one seat.");
  }
  if (rawPassengers.length > MAX_SEATS_PER_BOOKING) {
    throw new HttpError(
      400,
      `A single booking is limited to ${MAX_SEATS_PER_BOOKING} seats.`,
    );
  }

  const seen = new Set();

  return rawPassengers.map((raw, index) => {
    const position =
      rawPassengers.length > 1 ? ` for passenger ${index + 1}` : "";
    const seatId = Number.parseInt(raw?.seatId, 10);
    const name = String(raw?.name ?? "")
      .trim()
      .replace(/\s+/g, " ");
    const idCardNumber = String(raw?.idCardNumber ?? "")
      .trim()
      .toUpperCase();
    const age = Number.parseInt(raw?.age, 10);
    const gender = String(raw?.gender ?? "").toLowerCase();

    if (!Number.isInteger(seatId) || seatId <= 0 || seen.has(seatId)) {
      throw new HttpError(
        400,
        "The seat selection is invalid. Please select your seats again.",
      );
    }
    seen.add(seatId);

    if (name.length < 3 || name.length > 120) {
      throw new HttpError(
        400,
        `Enter the full name as shown on the ID${position}.`,
      );
    }
    if (idCardNumber.length < 5 || idCardNumber.length > 30) {
      throw new HttpError(400, `Enter a valid ID document number${position}.`);
    }
    if (requireAge && (!Number.isInteger(age) || age < 1 || age > 119)) {
      throw new HttpError(400, `Enter a valid age${position}.`);
    }
    if (!GENDERS.includes(gender)) {
      throw new HttpError(400, `Select a gender${position}.`);
    }

    return {
      seatId,
      name,
      idCardNumber,
      age: Number.isInteger(age) ? age : null,
      gender,
    };
  });
}

const parseId = (value) => {
  if (!/^\d{1,18}$/.test(String(value)))
    throw new HttpError(400, "Invalid identifier.");
  return String(value);
};

/** GET /api/users/my-bookings */
router.get(
  "/users/my-bookings",
  authenticateToken,
  handle(async (req, res) => {
    const bookings = await listConfirmedBookingsForUser(req.user.id);
    res.json({ success: true, bookings });
  }, "We could not load your bookings right now."),
);

async function loadAuthorizedRecord(req) {
  const record = await getBookingRecord(parseId(req.params.id));
  if (
    !record ||
    (String(record.user_id) !== String(req.user.id) &&
      !isAdminRole(req.user.role))
  ) {
    throw new HttpError(404, "Booking not found.");
  }
  return record;
}

/** GET /api/bookings/:id */
router.get(
  "/bookings/:id",
  authenticateToken,
  handle(async (req, res) => {
    res.json({ success: true, booking: await loadAuthorizedRecord(req) });
  }),
);

/** GET /api/bookings/:id/ticket.pdf */
router.get(
  "/bookings/:id/ticket.pdf",
  authenticateToken,
  handle(async (req, res) => {
    const record = await loadAuthorizedRecord(req);
    if (record.booking_status !== "confirmed") {
      throw new HttpError(
        409,
        "A ticket is only available for confirmed bookings.",
      );
    }
    const pdf = await renderTicketPdf(record);
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${brand.refPrefix}-Ticket-${record.booking_ref}.pdf"`,
      "Cache-Control": "private, no-store",
    });
    res.send(pdf);
  }, "We could not generate the ticket right now."),
);

/** POST /api/bookings/:id/cancel - releases an unpaid reservation */
router.post(
  "/bookings/:id/cancel",
  authenticateToken,
  handle(async (req, res) => {
    const bookingId = parseId(req.params.id);
    const result = await db.query(
      `UPDATE bookings SET status = 'cancelled'
        WHERE id = $1 AND user_id = $2 AND status = 'pending'
        RETURNING trip_id`,
      [bookingId, req.user.id],
    );

    if (result.rows[0]) {
      const seats = await db.query(
        "SELECT seat_id FROM booking_seats WHERE booking_id = $1",
        [bookingId],
      );
      await releaseSeatLocks(
        result.rows[0].trip_id,
        seats.rows.map((s) => s.seat_id),
      );
    }
    res.json({ success: true });
  }),
);

/**
 * POST /api/bookings
 * Reserves seats for a short hold. The trip row lock serialises concurrent buyers so a seat
 * can never be sold twice, with or without Redis.
 */
router.post(
  "/bookings",
  authenticateToken,
  handle(async (req, res) => {
    const tripId = parseId(req.body?.tripId);
    const passengers = parsePassengers(req.body?.passengers);
    const seatIds = passengers.map((p) => p.seatId);
    const userId = req.user.id;

    const lock = await acquireSeatLocks(tripId, seatIds, `user:${userId}`);
    if (!lock.success) {
      throw new HttpError(
        409,
        "One of the selected seats was just taken by another passenger. Please choose different seats.",
      );
    }

    try {
      const created = await withTransaction(async (client) => {
        const tripRes = await client.query(
          `SELECT t.id, t.bus_id, t.price_fcfa, t.status,
                  EXTRACT(EPOCH FROM ((t.travel_date + t.departure_time) - (NOW() AT TIME ZONE $2))) / 60 AS minutes_to_departure
             FROM trips t WHERE t.id = $1 FOR UPDATE`,
          [tripId, brand.timezone],
        );
        const trip = tripRes.rows[0];

        if (!trip || trip.status !== "open") {
          throw new HttpError(404, "This departure is no longer available.");
        }
        if (
          Number(trip.minutes_to_departure) <
          brand.boarding.onlineSalesCutoffMinutes
        ) {
          throw new HttpError(
            409,
            "Online sales for this departure have closed. Please visit the terminal counter.",
          );
        }

        const validSeats = await client.query(
          `SELECT id FROM bus_seats WHERE bus_id = $1 AND id = ANY($2::bigint[]) AND is_aisle = false`,
          [trip.bus_id, seatIds],
        );
        if (validSeats.rows.length !== seatIds.length) {
          throw new HttpError(
            400,
            "The selected seats do not belong to this bus.",
          );
        }

        // A passenger changing their mind should not be blocked by their own earlier hold.
        await client.query(
          `UPDATE bookings SET status = 'cancelled'
            WHERE user_id = $1 AND trip_id = $2 AND status = 'pending'
              AND id IN (SELECT booking_id FROM booking_seats WHERE seat_id = ANY($3::bigint[]))`,
          [userId, tripId, seatIds],
        );

        const conflict = await client.query(
          `SELECT bs.seat_id
             FROM booking_seats bs
             JOIN bookings b ON bs.booking_id = b.id
            WHERE b.trip_id = $1 AND bs.seat_id = ANY($2::bigint[])
              AND (b.status = 'confirmed'
                   OR (b.status = 'pending' AND b.created_at >= NOW() - make_interval(mins => $3)))
            LIMIT 1`,
          [tripId, seatIds, HOLD_MINUTES],
        );
        if (conflict.rows.length > 0) {
          throw new HttpError(
            409,
            "One or more selected seats are no longer available. Please choose different seats.",
          );
        }

        const profile = await client.query(
          "SELECT email, discussion_preference FROM users WHERE id = $1",
          [userId],
        );
        const contactEmail = isValidEmail(req.body?.contactEmail)
          ? req.body.contactEmail.trim().toLowerCase()
          : profile.rows[0]?.email || null;
        const preference =
          profile.rows[0]?.discussion_preference || "no_preference";

        const quote = quoteFare(trip.price_fcfa, passengers.length);
        const bookingRef = await generateBookingRef(client);
        const lead = passengers[0];

        const bookingRes = await client.query(
          `INSERT INTO bookings
             (user_id, trip_id, booking_ref, qr_code_hash, total_amount_fcfa, status, payment_method,
              passenger_name, passenger_phone, id_card_number, passenger_email)
           VALUES ($1, $2, $3, $4, $5, 'pending', 'momo', $6, $7, $8, $9)
           RETURNING id, booking_ref, total_amount_fcfa, status, created_at`,
          [
            userId,
            tripId,
            bookingRef,
            generateQrHash(),
            quote.totalAmount,
            lead.name,
            String(req.body?.payerPhone ?? "")
              .replace(/\D/g, "")
              .slice(-12) || null,
            lead.idCardNumber,
            contactEmail,
          ],
        );
        const booking = bookingRes.rows[0];

        for (const passenger of passengers) {
          await client.query(
            `INSERT INTO booking_seats
               (booking_id, seat_id, passenger_name, passenger_age, passenger_gender, discussion_preference, id_card_number)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              booking.id,
              passenger.seatId,
              passenger.name,
              passenger.age,
              passenger.gender,
              preference,
              passenger.idCardNumber,
            ],
          );
        }

        return { booking, quote };
      });

      res.status(201).json({
        success: true,
        message: `Seats held for ${HOLD_MINUTES} minutes. Complete payment to confirm your booking.`,
        booking: { ...created.booking, holdSeconds: HOLD_MINUTES * 60 },
        quote: created.quote,
      });
    } catch (error) {
      await releaseSeatLocks(tripId, seatIds);
      throw error;
    }
  }, "We could not reserve your seats. Please try again."),
);

export default router;
