import db from "../database/pg.js";
import { sendPayout } from "./campay.js";
import { alertAdmin } from "./alerts.js";
import { toInternationalPhone } from "../utils/format.js";

const LABELS = { agency: "Ticket revenue", platform: "Platform fee", refund: "Ticket refund" };

export async function createPayout({ bookingId = null, kind, phone = null, amount, reason = null, createdBy = null, status = "pending" }, runner = db) {
  const { rows } = await runner.query(
    `INSERT INTO payouts (booking_id, kind, phone, amount_fcfa, reason, created_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [bookingId, kind, phone, Math.round(amount), reason, createdBy, status],
  );
  return rows[0];
}

/**
 * Sends a pending or failed payout through the gateway. The status change to 'processing'
 * is atomic, so concurrent retries can never pay the same row twice.
 */
export async function sendPayoutById(id) {
  const claimed = await db.query(
    `UPDATE payouts SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
      WHERE id = $1
        AND (status IN ('pending', 'failed') OR (status = 'processing' AND updated_at < NOW() - INTERVAL '15 minutes'))
      RETURNING *`,
    [id],
  );
  const payout = claimed.rows[0];
  if (!payout) return null;

  const fail = async (message) => {
    await db.query(`UPDATE payouts SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1`, [id, message.slice(0, 500)]);
    await alertAdmin(`Payout failed (${payout.kind}, ${payout.amount_fcfa} XAF)`, `Payout #${id}: ${message}`);
    return { ...payout, status: "failed", error: message };
  };

  const phone = toInternationalPhone(payout.phone);
  if (!phone || payout.amount_fcfa <= 0) return fail("No valid Mobile Money number is configured for this payout.");

  try {
    const result = await sendPayout({
      amount: payout.amount_fcfa,
      phone,
      description: `${LABELS[payout.kind] || "Payout"} #${payout.booking_id ?? id}`,
      externalReference: `PAYOUT-${payout.id}`,
    });
    await db.query(`UPDATE payouts SET status = 'sent', gateway_ref = $2, error = NULL, updated_at = NOW() WHERE id = $1`, [id, result.reference || null]);
    return { ...payout, status: "sent", gateway_ref: result.reference };
  } catch (error) {
    return fail(error.details?.message || error.message || "Gateway error");
  }
}