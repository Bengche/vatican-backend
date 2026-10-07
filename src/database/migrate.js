import db from "./pg.js";

const MIGRATIONS = [
  `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS passenger_email VARCHAR(255)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_trip_status ON bookings (trip_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_booking_seats_lookup ON booking_seats (booking_id, seat_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_user_created ON bookings (user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_qr_hash ON bookings (qr_code_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_ref ON bookings (booking_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_pending ON bookings (created_at) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_trips_route_date ON trips (route_id, travel_date)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments (booking_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments (transaction_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))`,
];

export async function runMigrations() {
  for (const statement of MIGRATIONS) {
    try {
      await db.query(statement);
    } catch (err) {
      console.warn("[Postgres] Migration step skipped:", err.message);
    }
  }
  console.log("[Postgres] Schema checks complete.");
}
