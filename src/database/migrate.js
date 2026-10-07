import db, { withTransaction } from "./pg.js";
import { upgradeBusLayouts } from "../services/seatLayout.js";

const MIGRATIONS = [
  `ALTER TABLE bus_seats ADD COLUMN IF NOT EXISTS is_window BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS passenger_email VARCHAR(255)`,
  `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP`,
  `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_reason TEXT`,
  `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_by BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`,
  `DO $$ BEGIN
     ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
     ALTER TABLE users ADD CONSTRAINT users_role_check
       CHECK (role::text = ANY (ARRAY['passenger','agency_admin','gateman','super_admin','counter_agent']::text[]));
   END $$`,
  `CREATE TABLE IF NOT EXISTS password_resets (
     id BIGSERIAL PRIMARY KEY,
     user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token_hash CHAR(64) NOT NULL UNIQUE,
     expires_at TIMESTAMP NOT NULL,
     used_at TIMESTAMP,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS payouts (
     id BIGSERIAL PRIMARY KEY,
     booking_id BIGINT REFERENCES bookings(id) ON DELETE SET NULL,
     kind VARCHAR(20) NOT NULL CHECK (kind IN ('agency', 'platform', 'refund')),
     amount_fcfa INTEGER NOT NULL,
     phone VARCHAR(20),
     status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
     gateway_ref VARCHAR(100),
     error TEXT,
     reason TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     created_by BIGINT,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS cash_handovers (
     id BIGSERIAL PRIMARY KEY,
     agent_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     report_date DATE NOT NULL,
     expected_fcfa INTEGER NOT NULL,
     counted_fcfa INTEGER NOT NULL,
     note TEXT,
     recorded_by BIGINT,
     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
     UNIQUE (agent_id, report_date)
   )`,
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
  `CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts (status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_payouts_booking ON payouts (booking_id)`,
];

export async function runMigrations() {
  for (const statement of MIGRATIONS) {
    try {
      await db.query(statement);
    } catch (err) {
      console.warn("[Postgres] Migration step skipped:", err.message);
    }
  }
  try {
    await upgradeBusLayouts(db, withTransaction);
  } catch (err) {
    console.warn("[Layout] Seat layout upgrade skipped:", err.message);
  }
  console.log("[Postgres] Schema checks complete.");
}
