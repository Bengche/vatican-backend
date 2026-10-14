import express from "express";
import db, { withTransaction } from "../database/pg.js";
import { requireStaff } from "../middleware/auth.js";
import { requireDevice } from "./devices.js";
import { listPublicKeys } from "../services/ticketSigning.js";
import { trustedTime } from "../utils/clock.js";
import { HttpError, handle } from "../utils/httpError.js";

const router = express.Router();
router.use("/admin/gate/offline", requireStaff, requireDevice);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_BATCH = 200;

/** GET /api/admin/gate/offline/ping - tiny check that tells a device it is still allowed to work */
router.get(
  "/admin/gate/offline/ping",
  handle(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ success: true, serverTime: new Date().toISOString() });
  }),
);

/**
 * GET /api/admin/gate/offline/bundle?days=3
 * Everything a scanner needs to work with no network: the public signing keys, the departures
 * around today and the tickets booked on them. Personal data is limited to names and seats.
 */
router.get(
  "/admin/gate/offline/bundle",
  handle(async (req, res) => {
    const days = Math.min(14, Math.max(1, Number.parseInt(req.query.days, 10) || 3));

    const trips = await db.query(
      `SELECT t.id, t.client_id, t.travel_date, t.departure_time, buses.bus_number,
              p1.city AS origin_city, p2.city AS destination_city
         FROM trips t
         JOIN routes r ON t.route_id = r.id
         JOIN buses ON t.bus_id = buses.id
         JOIN agencies_parks p1 ON r.origin_park_id = p1.id
         JOIN agencies_parks p2 ON r.destination_park_id = p2.id
        WHERE t.status IN ('open', 'departed')
          AND t.travel_date BETWEEN CURRENT_DATE - 1 AND CURRENT_DATE + $1::int
        ORDER BY t.travel_date, t.departure_time`,
      [days],
    );
    const tripIds = trips.rows.map((t) => t.id);

    const bookings = tripIds.length
      ? await db.query(
          `SELECT b.id, b.qr_code_hash AS hash, b.booking_ref AS ref, b.trip_id, b.status,
                  b.paper_ref, b.qr_trip_id AS qr_trip,
                  b.is_checked_in AS boarded, b.checked_in_at AS boarded_at,
                  COALESCE(
                    json_agg(json_build_object('seat', bseats.seat_label, 'name', bs.passenger_name, 'id', bs.id_card_number)
                             ORDER BY bseats.row_num, bseats.col_num)
                      FILTER (WHERE bs.id IS NOT NULL),
                    '[]'::json
                  ) AS passengers
             FROM bookings b
             LEFT JOIN booking_seats bs ON bs.booking_id = b.id
             LEFT JOIN bus_seats bseats ON bseats.id = bs.seat_id
            WHERE b.trip_id = ANY($1::bigint[]) AND b.status IN ('confirmed', 'cancelled')
            GROUP BY b.id`,
          [tripIds],
        )
      : { rows: [] };

    const today = (await db.query("SELECT CURRENT_DATE::text AS today")).rows[0].today;

    // Counter tills sign the tickets they print while offline, so scanners need their public keys too.
    const deviceKeys = await db.query(
      `SELECT code, public_key, revoked_at FROM devices
        WHERE kind = 'counter' AND code IS NOT NULL AND public_key IS NOT NULL`,
    );
    const keys = [
      ...(await listPublicKeys()),
      ...deviceKeys.rows.map((d) => ({
        keyId: `c${d.code}`,
        publicKey: d.public_key,
        retired: false,
        revoked: Boolean(d.revoked_at),
      })),
    ];

    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      serverTime: new Date().toISOString(),
      today,
      keys,
      trips: trips.rows,
      bookings: bookings.rows,
    });
  }, "We could not prepare the offline data right now."),
);


async function applyBoarding(client, event, req) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [event.id]);

  const previous = await client.query(
    "SELECT result, detail, booking_id FROM gate_events WHERE id = $1",
    [event.id],
  );
  if (previous.rows[0]) {
    const { result, detail, booking_id } = previous.rows[0];
    return { id: event.id, result, detail, bookingId: booking_id };
  }

  const scannedAt = trustedTime(event.scannedAt);
  const booking = await client.query(
    `SELECT id, status, is_checked_in, checked_in_at FROM bookings WHERE qr_code_hash = $1 FOR UPDATE`,
    [event.hash],
  );
  const row = booking.rows[0];

  // A ticket sold on a counter that has not synced yet: keep the boarding on the device and try again later.
  if (!row && Date.now() - scannedAt.getTime() < 3 * 86_400_000) {
    return { id: event.id, result: "pending", detail: "Ticket not known to the server yet.", bookingId: null };
  }
  let result;
  let detail = null;
  if (!row) {
    result = "rejected";
    detail = "Ticket not found.";
  } else if (row.status !== "confirmed") {
    result = "rejected";
    detail = `Ticket was ${row.status} when this passenger boarded.`;
  } else if (row.is_checked_in) {
    result = "duplicate";
    detail = `Already boarded at ${row.checked_in_at?.toISOString?.() ?? row.checked_in_at}.`;
  } else {
    await client.query(
      `UPDATE bookings SET is_checked_in = TRUE, checked_in_at = $2::timestamptz, checked_in_by = $3
        WHERE id = $1`,
      [row.id, scannedAt.toISOString(), req.user.id],
    );
    result = "applied";
  }

  const bookingId = row ? row.id : null;
  await client.query(
    `INSERT INTO gate_events (id, booking_id, device_id, user_id, scanned_at, result, detail)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7)`,
    [event.id, bookingId, req.device.id, req.user.id, scannedAt.toISOString(), result, detail],
  );
  return { id: event.id, result, detail, bookingId };
}

/**
 * POST /api/admin/gate/offline/sync  { boardings: [{ id, hash, scannedAt }] }
 * Each boarding carries an id made on the device, so a retry after a dropped connection is harmless.
 */
router.post(
  "/admin/gate/offline/sync",
  handle(async (req, res) => {
    const boardings = req.body?.boardings;
    if (!Array.isArray(boardings)) throw new HttpError(400, "Nothing to sync.");
    if (boardings.length > MAX_BATCH) {
      throw new HttpError(413, `Send at most ${MAX_BATCH} boardings at a time.`);
    }

    const results = [];
    for (const item of boardings) {
      const valid =
        item && UUID_PATTERN.test(String(item.id)) && HASH_PATTERN.test(String(item.hash));
      if (!valid) {
        results.push({ id: item?.id ?? null, result: "invalid", detail: "Malformed entry." });
        continue;
      }
      const event = {
        id: String(item.id).toLowerCase(),
        hash: String(item.hash).toLowerCase(),
        scannedAt: item.scannedAt,
      };
      results.push(await withTransaction((client) => applyBoarding(client, event, req)));
    }

    await db.query("UPDATE devices SET last_sync_at = NOW() WHERE id = $1", [req.device.id]);
    res.json({ success: true, serverTime: new Date().toISOString(), results });
  }, "We could not save these boardings right now. They are still safe on your device."),
);

export default router;
