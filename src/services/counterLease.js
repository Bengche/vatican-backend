import db from "../database/pg.js";

// A counter that stops reporting in mid-shift owns every seat until it syncs again.
// The pause ends by itself after this long, so a phone switched off overnight cannot block sales for days.
const MAX_PAUSE_HOURS = 14;
export const LEASE_MINUTES = 3;

/**
 * True while the terminal counter for this departure is selling offline: it was in the middle of a shift
 * (a lease was open) and has stopped reporting. Online booking waits so the same seat is never sold twice.
 */
export async function counterHoldsTrip(tripId, runner = db) {
  const { rows } = await runner.query(
    `SELECT EXISTS (
       SELECT 1
         FROM trips t
         JOIN routes r ON r.id = t.route_id
         JOIN devices d ON d.park_id = r.origin_park_id
        WHERE t.id = $1
          AND d.kind = 'counter' AND d.revoked_at IS NULL
          AND d.selling_since IS NOT NULL
          AND d.lease_until < NOW()
          AND d.lease_until > NOW() - make_interval(hours => $2)
     ) AS held`,
    [tripId, MAX_PAUSE_HOURS],
  );
  return rows[0].held;
}
