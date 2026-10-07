import redis, { isRedisAvailable } from "./redis.js";
import { brand } from "../config/brand.js";

const LOCK_TTL_SECONDS = brand.boarding.seatHoldMinutes * 60;
const lockKey = (tripId, seatId) => `lock:trip:${tripId}:seat:${seatId}`;

/**
 * Atomically places a temporary hold on seats. The database check in the booking
 * transaction remains the final authority, so this degrades gracefully without Redis.
 */
export async function acquireSeatLocks(tripId, seatIds, holder) {
  if (!redis || !isRedisAvailable) return { success: true, lockedSeats: [] };

  const acquired = [];

  try {
    for (const seatId of seatIds) {
      const key = lockKey(tripId, seatId);
      const result = await redis.set(key, holder, "EX", LOCK_TTL_SECONDS, "NX");

      if (result === "OK") {
        acquired.push(key);
        continue;
      }

      // Same holder retrying: refresh instead of failing.
      if ((await redis.get(key)) === holder) {
        await redis.expire(key, LOCK_TTL_SECONDS);
        acquired.push(key);
        continue;
      }

      if (acquired.length > 0) await redis.del(...acquired);
      return { success: false, conflictingSeat: seatId };
    }
    return { success: true, lockedSeats: acquired };
  } catch (err) {
    console.warn("[SeatLock] Redis unavailable, using database check only:", err.message);
    return { success: true, lockedSeats: [] };
  }
}

export async function releaseSeatLocks(tripId, seatIds) {
  if (!redis || !isRedisAvailable || !seatIds?.length) return;

  try {
    await redis.del(...seatIds.map((seatId) => lockKey(tripId, seatId)));
  } catch {
    // Locks expire on their own.
  }
}
