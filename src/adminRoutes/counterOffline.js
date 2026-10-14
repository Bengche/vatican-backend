import express from "express";
import db, { withTransaction } from "../database/pg.js";
import { brand } from "../config/brand.js";
import { requireCounter } from "../middleware/auth.js";
import { requireDeviceKind } from "./devices.js";
import { parsePassengers } from "../routes/bookings.js";
import { LEASE_MINUTES } from "../services/counterLease.js";
import { trustedTime } from "../utils/clock.js";
import { HttpError, handle } from "../utils/httpError.js";
import { toInternationalPhone } from "../utils/format.js";

const router = express.Router();
router.use("/admin/counter", requireCounter, requireDeviceKind("counter"));

const HOLD_MINUTES = brand.boarding.seatHoldMinutes;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SALES = 100;
const MAX_TRIPS = 20;
const isAdminDevice = (req) => ["agency_admin", "super_admin"].includes(req.user.role);

/**
 * GET /api/admin/counter/bundle
 * Everything a sales device needs to sell with no network: its terminal's departures with the seats
 * already taken, the seat layouts of the buses, and the routes it may add an extra bus to.
 */
router.get(
  "/admin/counter/bundle",
  handle(async (req, res) => {
    const parkId = req.device.park_id;

    const trips = await db.query(
      `SELECT t.id, t.client_id, t.route_id, t.bus_id, t.travel_date, t.departure_time, t.price_fcfa, t.status,
              b.bus_number, p1.city AS origin_city, p2.city AS destination_city
         FROM trips t
         JOIN routes r ON r.id = t.route_id
         JOIN buses b ON b.id = t.bus_id
         JOIN agencies_parks p1 ON p1.id = r.origin_park_id
         JOIN agencies_parks p2 ON p2.id = r.destination_park_id
        WHERE r.origin_park_id = $1 AND t.status = 'open'
          AND t.travel_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
        ORDER BY t.travel_date, t.departure_time`,
      [parkId],
    );
    const tripIds = trips.rows.map((t) => t.id);

    const taken = tripIds.length
      ? await db.query(
          `SELECT bk.trip_id, array_agg(DISTINCT bs.seat_id) AS seat_ids
             FROM booking_seats bs
             JOIN bookings bk ON bk.id = bs.booking_id
            WHERE bk.trip_id = ANY($1::bigint[])
              AND (bk.status = 'confirmed'
                   OR (bk.status = 'pending' AND bk.created_at >= NOW() - make_interval(mins => $2)))
            GROUP BY bk.trip_id`,
          [tripIds, HOLD_MINUTES],
        )
      : { rows: [] };
    const takenByTrip = new Map(taken.rows.map((r) => [String(r.trip_id), r.seat_ids.map(String)]));

    const buses = await db.query(
      `SELECT id, bus_number, bus_type, total_seats
         FROM buses
        WHERE is_active = true AND (park_id = $1 OR id = ANY($2::bigint[]))
        ORDER BY bus_number`,
      [parkId, trips.rows.map((t) => t.bus_id)],
    );
    const seats = buses.rows.length
      ? await db.query(
          `SELECT id, bus_id, seat_label, row_num, col_num, is_aisle, is_window
             FROM bus_seats WHERE bus_id = ANY($1::bigint[]) ORDER BY bus_id, row_num, col_num`,
          [buses.rows.map((b) => b.id)],
        )
      : { rows: [] };
    const seatsByBus = new Map();
    for (const s of seats.rows) {
      const list = seatsByBus.get(String(s.bus_id)) ?? [];
      list.push({
        id: String(s.id),
        seatLabel: s.seat_label,
        rowNum: s.row_num,
        colNum: s.col_num,
        isAisle: s.is_aisle,
        isWindow: s.is_window,
      });
      seatsByBus.set(String(s.bus_id), list);
    }

    const routes = await db.query(
      `SELECT r.id, r.destination_park_id, p2.city AS destination_city, p2.park_name AS destination_park,
              COALESCE((SELECT price_fcfa FROM trips WHERE route_id = r.id ORDER BY travel_date DESC, id DESC LIMIT 1),
                       r.base_price_classic) AS fare
         FROM routes r JOIN agencies_parks p2 ON p2.id = r.destination_park_id
        WHERE r.origin_park_id = $1 AND p2.is_active IS NOT FALSE
        ORDER BY p2.city`,
      [parkId],
    );

    const park = await db.query(
      "SELECT id, city, park_name FROM agencies_parks WHERE id = $1",
      [parkId],
    );
    const today = (await db.query("SELECT CURRENT_DATE::text AS today")).rows[0].today;

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      serverTime: new Date().toISOString(),
      today,
      refPrefix: brand.refPrefix,
      device: { id: req.device.id, code: req.device.code, keyId: `c${req.device.code}` },
      park: park.rows[0] ?? null,
      trips: trips.rows.map((t) => ({
        id: String(t.id),
        clientId: t.client_id,
        routeId: String(t.route_id),
        busId: String(t.bus_id),
        busNumber: t.bus_number,
        travelDate: t.travel_date,
        departureTime: t.departure_time,
        fare: Number(t.price_fcfa),
        originCity: t.origin_city,
        destinationCity: t.destination_city,
        taken: takenByTrip.get(String(t.id)) ?? [],
      })),
      buses: buses.rows.map((b) => ({
        id: String(b.id),
        busNumber: b.bus_number,
        busType: b.bus_type,
        totalSeats: b.total_seats,
        seats: seatsByBus.get(String(b.id)) ?? [],
      })),
      routes: routes.rows.map((r) => ({
        id: String(r.id),
        destinationCity: r.destination_city,
        destinationPark: r.destination_park,
        fare: Number(r.fare ?? 0),
      })),
    });
  }, "We could not prepare the counter data right now."),
);

/**
 * POST /api/admin/counter/heartbeat  { selling: boolean }
 * A counter that is selling checks in every few seconds. If it goes quiet mid-shift, online booking for its
 * terminal pauses (see counterLease) until it syncs again, so the counter owns every seat while offline.
 */
router.post(
  "/admin/counter/heartbeat",
  handle(async (req, res) => {
    if (req.body?.selling === false) {
      await db.query("UPDATE devices SET selling_since = NULL, lease_until = NULL WHERE id = $1", [req.device.id]);
    } else {
      await db.query(
        `UPDATE devices
            SET selling_since = COALESCE(selling_since, NOW()),
                lease_until = NOW() + make_interval(mins => $2)
          WHERE id = $1`,
        [req.device.id, LEASE_MINUTES],
      );
    }
    res.set("Cache-Control", "no-store");
    res.json({ success: true, serverTime: new Date().toISOString() });
  }),
);

const reject = (id, detail, extra = {}) => ({ id, result: "rejected", detail, ...extra });

/** Creates (or finds) a departure added at the counter while offline. */
async function applyTrip(client, input, req) {
  const clientId = String(input?.clientId ?? "").toLowerCase();
  if (!UUID_PATTERN.test(clientId)) return { clientId: input?.clientId ?? null, result: "rejected", detail: "Malformed departure." };
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [clientId]);

  const existing = await client.query("SELECT id FROM trips WHERE client_id = $1", [clientId]);
  if (existing.rows[0]) return { clientId, id: String(existing.rows[0].id), result: "applied" };

  const date = String(input.travelDate ?? "");
  const time = String(input.departureTime ?? "").slice(0, 5);
  const fare = Number.parseInt(input.fare, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    return { clientId, result: "rejected", detail: "Invalid date or time." };
  if (!Number.isInteger(fare) || fare < 500 || fare > 500000)
    return { clientId, result: "rejected", detail: "Invalid fare." };

  const route = await client.query("SELECT id, origin_park_id FROM routes WHERE id = $1", [String(input.routeId)]);
  if (!route.rows[0]) return { clientId, result: "rejected", detail: "Route not found." };
  if (!isAdminDevice(req) && String(route.rows[0].origin_park_id) !== String(req.device.park_id))
    return { clientId, result: "rejected", detail: "This counter can only add departures from its own terminal." };

  const bus = await client.query("SELECT is_active FROM buses WHERE id = $1", [String(input.busId)]);
  if (!bus.rows[0]?.is_active) return { clientId, result: "rejected", detail: "Bus not found or not operational." };

  // The same bus at the same time already exists (published online): use that one.
  const duplicate = await client.query(
    `SELECT id FROM trips WHERE bus_id = $1 AND travel_date = $2 AND departure_time = $3 AND status = 'open' LIMIT 1`,
    [String(input.busId), date, time],
  );
  if (duplicate.rows[0]) return { clientId, id: String(duplicate.rows[0].id), result: "applied", detail: "Matched an existing departure." };

  const shift = Number(time.slice(0, 2)) >= 12 ? "evening" : "morning";
  const inserted = await client.query(
    `INSERT INTO trips (route_id, bus_id, travel_date, departure_time, travel_shift, price_fcfa, status, client_id, created_by_device)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8) RETURNING id`,
    [route.rows[0].id, String(input.busId), date, time, shift, fare, clientId, req.device.id],
  );
  return { clientId, id: String(inserted.rows[0].id), result: "applied" };
}

/** Records one sale made at the counter. A sale the passenger already holds a ticket for is never lost. */
async function applySale(client, input, req, live) {
  const id = String(input?.id ?? "").toLowerCase();
  if (!UUID_PATTERN.test(id)) return reject(input?.id ?? null, "Malformed sale.");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);

  const previous = await client.query(
    "SELECT result, detail, booking_id, booking_ref FROM offline_sales WHERE id = $1",
    [id],
  );
  if (previous.rows[0]) {
    const p = previous.rows[0];
    return { id, result: p.result, detail: p.detail, bookingId: p.booking_id ? String(p.booking_id) : null, bookingRef: p.booking_ref };
  }

  const soldAt = trustedTime(input.soldAt);
  const late = input.lateEntry === true;
  const claimed = Number.parseInt(input.amount, 10);
  const save = async (result, detail, booking = null) => {
    await client.query(
      `INSERT INTO offline_sales (id, device_id, user_id, booking_id, booking_ref, late_entry, result, detail, claimed_amount_fcfa, sold_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)`,
      [id, req.device.id, req.user.id, booking?.id ?? null, booking?.ref ?? String(input.ref ?? "").slice(0, 40), late, result, detail, Number.isInteger(claimed) ? claimed : null, soldAt.toISOString()],
    );
    return { id, result, detail, bookingId: booking ? String(booking.id) : null, bookingRef: booking?.ref ?? null };
  };

  const ref = String(input.ref ?? "");
  const refPattern = new RegExp(`^${brand.refPrefix}-0${req.device.code}[A-HJ-NP-Z2-9]{4}$`);
  if (!refPattern.test(ref)) return save("rejected", "The ticket reference does not belong to this device.");
  const hash = String(input.hash ?? "");
  if (!HASH_PATTERN.test(hash)) return save("rejected", "Malformed ticket code.");

  let passengers;
  try {
    passengers = parsePassengers(input.passengers);
  } catch (error) {
    if (error instanceof HttpError) return save("rejected", error.message);
    throw error;
  }
  const seatIds = passengers.map((p) => p.seatId);

  const tripClientId = input.tripClientId ? String(input.tripClientId).toLowerCase() : null;
  const tripQuery = tripClientId
    ? client.query(
        `SELECT t.id, t.bus_id, t.price_fcfa, t.status, r.origin_park_id,
                EXTRACT(EPOCH FROM ((t.travel_date + t.departure_time) - (NOW() AT TIME ZONE $2))) / 60 AS minutes_to_departure
           FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.client_id = $1 FOR UPDATE OF t`,
        [tripClientId, brand.timezone],
      )
    : client.query(
        `SELECT t.id, t.bus_id, t.price_fcfa, t.status, r.origin_park_id,
                EXTRACT(EPOCH FROM ((t.travel_date + t.departure_time) - (NOW() AT TIME ZONE $2))) / 60 AS minutes_to_departure
           FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = $1 FOR UPDATE OF t`,
        [/^\d{1,18}$/.test(String(input.tripId)) ? String(input.tripId) : "0", brand.timezone],
      );
  const trip = (await tripQuery).rows[0];
  if (!trip) return save("rejected", "The departure was not found.");
  if (!isAdminDevice(req) && String(trip.origin_park_id) !== String(req.device.park_id))
    return save("rejected", "This counter cannot sell for that terminal.");
  if (trip.status === "cancelled") return save("rejected", "The departure was cancelled.");
  if (live && (trip.status !== "open" || Number(trip.minutes_to_departure) < 0))
    return save("rejected", "This bus has already departed.");

  const validSeats = await client.query(
    "SELECT id, seat_label FROM bus_seats WHERE bus_id = $1 AND id = ANY($2::bigint[]) AND is_aisle = false",
    [trip.bus_id, seatIds],
  );
  if (validSeats.rows.length !== seatIds.length) return save("rejected", "The seats do not belong to this bus.");

  const conflict = await client.query(
    `SELECT bs.seat_id, bk.booking_ref
       FROM booking_seats bs JOIN bookings bk ON bk.id = bs.booking_id
      WHERE bk.trip_id = $1 AND bs.seat_id = ANY($2::bigint[])
        AND (bk.status = 'confirmed' OR (bk.status = 'pending' AND bk.created_at >= NOW() - make_interval(mins => $3)))`,
    [trip.id, seatIds, HOLD_MINUTES],
  );
  const labelOf = new Map(validSeats.rows.map((s) => [String(s.id), s.seat_label]));
  let flag = null;
  if (conflict.rows.length > 0) {
    const seats = [...new Set(conflict.rows.map((c) => labelOf.get(String(c.seat_id))))].join(", ");
    if (live) return save("rejected", `Seat ${seats} was just taken. Choose another seat.`);
    flag = `Seat ${seats} was also sold to ${[...new Set(conflict.rows.map((c) => c.booking_ref))].join(", ")}. Move one passenger.`;
  }

  const total = Number(trip.price_fcfa) * passengers.length;
  if (Number.isInteger(claimed) && claimed !== total) {
    flag = `${flag ? `${flag} ` : ""}The ticket showed ${claimed} XAF but the fare is now ${total} XAF.`;
  }

  const momo = input.payment?.method === "momo";
  const paymentRef = momo ? String(input.payment?.ref ?? "").trim().slice(0, 60) || null : null;
  if (momo && !paymentRef) flag = `${flag ? `${flag} ` : ""}Mobile Money transaction number missing.`;

  let phone = null;
  try {
    phone = input.phone ? toInternationalPhone(input.phone) : null;
  } catch {
    phone = null;
  }
  const paperRef = late ? String(input.paperRef ?? "").trim().slice(0, 40) || null : null;
  const qrTripId = String(input.qrTripId ?? "").slice(0, 40) || null;
  const lead = passengers[0];

  await client.query("SAVEPOINT booking_insert");
  let booking;
  try {
    const created = await client.query(
      `INSERT INTO bookings
         (user_id, trip_id, booking_ref, qr_code_hash, total_amount_fcfa, status, payment_method,
          passenger_name, passenger_phone, id_card_number, counter_payment, payment_ref, payment_unverified,
          paper_ref, qr_trip_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'confirmed', 'cash_counter', $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)
       RETURNING id, booking_ref AS ref`,
      [req.user.id, trip.id, ref, hash, total, lead.name, phone, lead.idCardNumber, momo ? "momo_manual" : "cash", paymentRef, momo, paperRef, qrTripId, soldAt.toISOString()],
    );
    booking = created.rows[0];
  } catch (error) {
    if (error.code !== "23505") throw error;
    await client.query("ROLLBACK TO SAVEPOINT booking_insert");
    return save("rejected", "This ticket reference or code is already in use.");
  }

  for (const passenger of passengers) {
    await client.query(
      `INSERT INTO booking_seats
         (booking_id, seat_id, passenger_name, passenger_age, passenger_gender, discussion_preference, id_card_number, is_counter_booking)
       VALUES ($1, $2, $3, $4, $5, 'no_preference', $6, true)`,
      [booking.id, passenger.seatId, passenger.name, passenger.age, passenger.gender, passenger.idCardNumber],
    );
  }

  return save(flag ? "flagged" : "applied", flag, booking);
}

/**
 * POST /api/admin/counter/sync  { trips: [...], sales: [...], live?: boolean }
 * Departures added offline are created first, then each sale is recorded. Every item carries an id made on
 * the device, so a retry after a dropped connection never creates a second ticket. With `live` set the clerk
 * is waiting at the screen, so a seat clash is refused instead of being recorded for a manager to resolve.
 */
router.post(
  "/admin/counter/sync",
  handle(async (req, res) => {
    const tripsIn = req.body?.trips ?? [];
    const salesIn = req.body?.sales ?? [];
    if (!Array.isArray(tripsIn) || !Array.isArray(salesIn)) throw new HttpError(400, "Nothing to sync.");
    if (tripsIn.length > MAX_TRIPS || salesIn.length > MAX_SALES) throw new HttpError(413, "Too many items in one request.");
    const live = req.body?.live === true;

    const trips = [];
    for (const item of tripsIn) trips.push(await withTransaction((client) => applyTrip(client, item, req)));
    const sales = [];
    for (const item of salesIn) sales.push(await withTransaction((client) => applySale(client, item, req, live)));

    await db.query(
      `UPDATE devices SET last_sync_at = NOW(),
              lease_until = CASE WHEN selling_since IS NOT NULL THEN NOW() + make_interval(mins => $2) ELSE lease_until END
        WHERE id = $1`,
      [req.device.id, LEASE_MINUTES],
    );
    res.json({ success: true, serverTime: new Date().toISOString(), trips, sales });
  }, "We could not save these sales right now. They are still safe on your device."),
);

export default router;
