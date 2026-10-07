import express from "express";
import QRCode from "qrcode";
import db from "../database/pg.js";
import { brand } from "../config/brand.js";
import { verifyUrl } from "../services/emailTemplates.js";
import { handle } from "../utils/httpError.js";

const router = express.Router();
const HASH_PATTERN = /^[a-f0-9]{64}$/;

/** GET /api/verify/ticket/:hash - scanned from the QR code on a boarding pass */
router.get(
  "/verify/ticket/:hash",
  handle(async (req, res) => {
    const { hash } = req.params;

    if (!HASH_PATTERN.test(hash)) {
      return res.status(404).json({ success: false, valid: false, message: "This ticket could not be found." });
    }

    const { rows } = await db.query(
      `SELECT
         b.booking_ref,
         b.status AS booking_status,
         b.created_at AS booked_at,
         b.total_amount_fcfa,
         p1.city AS origin_city,
         p1.park_name AS origin,
         p2.city AS destination_city,
         p2.park_name AS destination,
         t.travel_date,
         t.departure_time,
         t.travel_shift,
         buses.bus_number,
         buses.bus_type,
         COALESCE(
           (SELECT json_agg(json_build_object(
              'seat_label', bseats.seat_label,
              'passenger_name', bs.passenger_name,
              'id_card_number', bs.id_card_number,
              'passenger_age', bs.passenger_age,
              'passenger_gender', bs.passenger_gender
            ) ORDER BY bs.id)
            FROM booking_seats bs
            JOIN bus_seats bseats ON bs.seat_id = bseats.id
            WHERE bs.booking_id = b.id),
           '[]'::json
         ) AS passengers
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       JOIN buses ON t.bus_id = buses.id
       JOIN agencies_parks p1 ON r.origin_park_id = p1.id
       JOIN agencies_parks p2 ON r.destination_park_id = p2.id
       WHERE b.qr_code_hash = $1
       LIMIT 1`,
      [hash],
    );

    const ticket = rows[0];
    if (!ticket) {
      return res.status(404).json({ success: false, valid: false, message: "This ticket could not be found." });
    }

    const valid = ticket.booking_status === "confirmed";
    return res.json({
      success: true,
      valid,
      message: valid ? undefined : "This ticket has not been paid for or has been cancelled.",
      ticket: {
        ...ticket,
        agency_name: brand.name,
        route_code: `${ticket.origin_city} - ${ticket.destination_city}`.toUpperCase(),
      },
    });
  }, "We could not verify this ticket right now."),
);

/** GET /api/verify/qr/:hash.png - QR image used inside emails (mail clients block data URIs) */
router.get(
  "/verify/qr/:hash.png",
  handle(async (req, res) => {
    const { hash } = req.params;
    if (!HASH_PATTERN.test(hash)) return res.status(404).end();

    const exists = await db.query("SELECT 1 FROM bookings WHERE qr_code_hash = $1", [hash]);
    if (exists.rows.length === 0) return res.status(404).end();

    const png = await QRCode.toBuffer(verifyUrl(hash), {
      margin: 1,
      width: 360,
      color: { dark: brand.colors.primary, light: "#ffffff" },
    });
    res.set({ "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" });
    res.send(png);
  }),
);

export default router;
