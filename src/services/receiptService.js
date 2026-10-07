import db from "../database/pg.js";

const RECORD_SELECT = `
  SELECT
    b.id AS booking_id,
    b.booking_ref,
    b.qr_code_hash,
    b.total_amount_fcfa,
    b.status AS booking_status,
    COALESCE(b.payment_method, 'momo') AS payment_method,
    b.created_at AS booked_at,
    b.created_at,
    b.user_id,
    b.passenger_phone,
    COALESCE(b.passenger_email, u.email) AS recipient_email,
    COALESCE(u.full_name, b.passenger_name) AS contact_name,
    t.id AS trip_id,
    t.travel_date,
    t.departure_time,
    t.travel_shift,
    t.price_fcfa AS unit_price,
    buses.bus_number,
    buses.bus_type,
    p1.city AS origin_city,
    p1.park_name AS origin_park,
    p1.address_description AS origin_address,
    p1.momo_number AS agency_momo,
    p2.city AS destination_city,
    p2.park_name AS destination_park,
    pay.transaction_ref,
    pay.payment_gateway,
    COALESCE(
      (SELECT json_agg(json_build_object(
          'seat_id', bs.seat_id,
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
    ) AS seats
  FROM bookings b
  JOIN trips t ON b.trip_id = t.id
  JOIN routes r ON t.route_id = r.id
  JOIN buses ON t.bus_id = buses.id
  JOIN agencies_parks p1 ON r.origin_park_id = p1.id
  JOIN agencies_parks p2 ON r.destination_park_id = p2.id
  LEFT JOIN users u ON b.user_id = u.id
  LEFT JOIN LATERAL (
    SELECT transaction_ref, payment_gateway
    FROM payments
    WHERE booking_id = b.id AND status = 'SUCCESS'
    ORDER BY id DESC
    LIMIT 1
  ) pay ON true
`;

function withBreakdown(row) {
  const seatCount = row.seats.length || 1;
  const baseFare = Number(row.unit_price) * seatCount;
  const total = Number(row.total_amount_fcfa);
  return {
    ...row,
    recipientEmail: row.recipient_email,
    contactName: row.contact_name,
    breakdown: {
      baseFare,
      fees: Math.max(0, total - baseFare),
      total,
    },
  };
}

export async function getBookingRecord(bookingId, runner = db) {
  const { rows } = await runner.query(
    `${RECORD_SELECT} WHERE b.id = $1 LIMIT 1`,
    [bookingId],
  );
  return rows[0] ? withBreakdown(rows[0]) : null;
}

export async function listConfirmedBookingsForUser(userId) {
  const { rows } = await db.query(
    `${RECORD_SELECT} WHERE b.user_id = $1 AND b.status = 'confirmed' ORDER BY t.travel_date DESC, t.departure_time DESC, b.id DESC`,
    [userId],
  );
  return rows.map(withBreakdown);
}
