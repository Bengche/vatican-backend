const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_AGE_MS = 30 * 86_400_000;

/** The time something really happened on a device, ignoring clocks that are obviously wrong. */
export function trustedTime(raw) {
  const parsed = new Date(raw);
  const now = Date.now();
  const ms = parsed.getTime();
  return Number.isFinite(ms) &&
    ms <= now + MAX_FUTURE_SKEW_MS &&
    ms >= now - MAX_AGE_MS
    ? parsed
    : new Date(now);
}
