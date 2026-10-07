import db, { withTransaction } from "../database/pg.js";
import { brand } from "../config/brand.js";
import { HttpError } from "../utils/httpError.js";
import { createPayout, sendPayoutById } from "./payoutService.js";
import { getBookingRecord } from "./receiptService.js";
import { sendCancellationEmail } from "./emailService.js";
import { alertAdmin } from "./alerts.js";

const MS_PER_HOUR = 3_600_000;

/** Refund suggested by the published policy. Only the base fare is refundable; fees are not. */
export function suggestRefund(record, now = new Date()) {
  const departure = new Date(`${record.travel_date}T${String(record.departure_time).slice(0, 8)}+01:00`);
  const hours = (departure.getTime() - now.getTime()) / MS_PER_HOUR;
  const { fullRefundHours, partialRefundHours, partialPercent } = brand.refundPolicy;

  const percent = hours >= fullRefundHours ? 100 : hours >= partialRefundHours ? partialPercent : 0;
  const refundable = record.payment_method === "cash_counter" ? Number(record.total_amount_fcfa) : Number(record.breakdown.baseFare);

  return {
    hoursToDeparture: Math.round(hours * 10) / 10,
    percent,
    amount: Math.floor((refundable * percent) / 100),
    maxAmount: Number(record.total_amount_fcfa),
  };
}

/** Cancels a confirmed booking, frees its seats and records (and sends) the refund. */
export async function cancelBooking({ bookingId, adminId, reason, refundAmount }) {
  const cleanReason = String(reason || "").trim().slice(0, 300);
  if (cleanReason.length < 3) throw new HttpError(400, "Enter the reason for the cancellation.");

  const record = await getBookingRecord(bookingId);
  if (!record) throw new HttpError(404, "Booking not found.");
  if (record.booking_status !== "confirmed") throw new HttpError(409, "Only confirmed bookings can be cancelled.");

  const amount = Number.parseInt(refundAmount, 10);
  if (!Number.isInteger(amount) || amount < 0 || amount > Number(record.total_amount_fcfa)) {
    throw new HttpError(400, "The refund cannot be negative or exceed the amount paid.");
  }

  const isCash = record.payment_method === "cash_counter";

  const outcome = await withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $2
        WHERE id = $1 AND status = 'confirmed' RETURNING id`,
      [bookingId, cleanReason],
    );
    if (!updated.rows[0]) throw new HttpError(409, "This booking was already cancelled.");

    if (amount === 0) return null;

    let phone = null;
    if (!isCash) {
      const payment = await client.query(
        `SELECT payer_phone FROM payments WHERE booking_id = $1 AND status = 'SUCCESS' ORDER BY id DESC LIMIT 1`,
        [bookingId],
      );
      phone = payment.rows[0]?.payer_phone || null;
    }

    return createPayout(
      {
        bookingId,
        kind: "refund",
        phone,
        amount,
        reason: cleanReason,
        createdBy: adminId,
        // Cash is handed back at the counter; Mobile Money goes out through the gateway.
        status: isCash ? "sent" : "pending",
      },
      client,
    );
  });

  let refund = outcome;
  if (outcome && !isCash) refund = (await sendPayoutById(outcome.id)) || outcome;

  sendCancellationEmail({ bookingId, refund: refund && { amount, status: refund.status, method: isCash ? "cash" : "momo", phone: refund.phone }, reason: cleanReason }).catch((err) =>
    console.error("[Email] Cancellation notice failed:", err.message),
  );

  return { refund: refund && { id: refund.id, amount, status: refund.status } };
}

/** A payment arrived after the seats were released to someone else: return the money in full. */
export async function refundUnmatchedPayment(payment) {
  const { rows } = await db.query(`SELECT payer_phone FROM payments WHERE id = $1`, [payment.id]);

  const payout = await createPayout({
    bookingId: payment.booking_id,
    kind: "refund",
    phone: rows[0]?.payer_phone || null,
    amount: payment.amount_fcfa,
    reason: "Seats were no longer available when the payment arrived",
  });

  await alertAdmin(
    "Payment received for released seats: automatic refund started",
    `Booking ${payment.booking_id}, ${payment.amount_fcfa} XAF, payout #${payout.id}`,
  );

  const sent = await sendPayoutById(payout.id);

  sendCancellationEmail({
    bookingId: payment.booking_id,
    refund: { amount: payment.amount_fcfa, status: sent?.status || "pending", method: "momo", phone: payout.phone },
    reason: "The seats were no longer available when your payment arrived, so the full amount is being returned.",
  }).catch((err) => console.error("[Email] Refund notice failed:", err.message));

  return payout;
}