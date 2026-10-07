import { env } from "../config/env.js";
import { sendAlertEmail } from "./emailService.js";

const lastSent = new Map();
const THROTTLE_MS = 10 * 60 * 1000;

/** Logs a critical event and emails the operator (throttled so a failing loop cannot flood the inbox). */
export async function alertAdmin(subject, details = "") {
  console.error(`[ALERT] ${subject}${details ? ` | ${details}` : ""}`);
  if (!env.alertEmail) return;

  const now = Date.now();
  if (now - (lastSent.get(subject) || 0) < THROTTLE_MS) return;
  lastSent.set(subject, now);

  try {
    await sendAlertEmail(subject, details);
  } catch (error) {
    console.error("[ALERT] Could not send alert email:", error.message);
  }
}