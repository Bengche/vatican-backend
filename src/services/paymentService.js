import db, { withTransaction } from "../database/pg.js";
import { brand } from "../config/brand.js";
import { env } from "../config/env.js";
import { collectPayment, getTransaction, sendPayout } from "./campay.js";
import { releaseSeatLocks } from "./seatLockService.js";
import { queueTicketReceiptEmail } from "./queueService.js";
import { getBookingRecord } from "./receiptService.js";
import { toInternationalPhone } from "../utils/format.js";

const HOLD_MINUTES = brand.boarding.seatHoldMinutes;

// Normalises gateway statuses to the values allowed by payments_status_check.
function mapGatewayStatus(status) {
  const value = String(status || "").toUpperCase();
  if (value === "SUCCESSFUL" || value === "SUCCESS") return "SUCCESS";
  if (value === "FAILED" || value === "CANCELLED") return "FAILED";
  return "pending";
}

/** Seats (of the given booking) that are already taken by another live booking. */
async function findSeatConflicts(client, bookingId, tripId) {
  const { rows } = await client.query(
    `SELECT mine.seat_id
       FROM booking_seats mine
       JOIN booking_seats other ON other.seat_id = mine.seat_id AND other.booking_id <> mine.booking_id
       JOIN bookings ob ON ob.id = other.booking_id
      WHERE mine.booking_id = $1
        AND ob.trip_id = $2
        AND (ob.status = 'confirmed'
             OR (ob.status = 'pending' AND ob.created_at >= NOW() - make_interval(mins => $3)))
      LIMIT 1`,
    [bookingId, tripId, HOLD_MINUTES],
  );
  return rows;
}

async function runPayouts(record) {
  const seatCount = record.seats.length || 1;
  const { terminalFeePerSeat, serviceFeePerSeat } = brand.pricing;
  const agencyAmount =
    Number(record.unit_price) * seatCount + terminalFeePerSeat * seatCount;
  const platformAmount = serviceFeePerSeat * seatCount;
  const label = `${record.booking_ref} (${seatCount} seat${seatCount > 1 ? "s" : ""})`;

  const payouts = [
    {
      name: "agency",
      phone: record.agency_momo,
      amount: agencyAmount,
      ref: `AGENCY-${record.booking_id}`,
    },
    {
      name: "platform",
      phone: env.platformPayoutNumber,
      amount: platformAmount,
      ref: `PLATFORM-${record.booking_id}`,
    },
  ];

  for (const payout of payouts) {
    const phone = toInternationalPhone(payout.phone);
    if (!phone || payout.amount <= 0) {
      console.warn(
        `[Payout] ${payout.name} payout skipped for ${label}: no valid number configured.`,
      );
      continue;
    }
    try {
      const result = await sendPayout({
        amount: payout.amount,
        phone,
        description: `Ticket revenue ${label}`,
        externalReference: payout.ref,
      });
      console.log(
        `[Payout] ${payout.name} ${payout.amount} XAF for ${label}. Ref ${result.reference}`,
      );
    } catch (error) {
      console.error(
        `[Payout] ${payout.name} payout FAILED for ${label}:`,
        error.details || error.message,
      );
    }
  }
}

async function afterConfirmation(bookingId) {
  const record = await getBookingRecord(bookingId);
  if (!record) return;

  await releaseSeatLocks(
    record.trip_id,
    record.seats.map((s) => s.seat_id),
  ).catch(() => {});
  await runPayouts(record).catch((err) =>
    console.error("[Payout] Unexpected error:", err.message),
  );

  try {
    await queueTicketReceiptEmail(bookingId);
  } catch (err) {
    console.error(
      `[Email] Could not dispatch ticket for ${record.booking_ref}:`,
      err.message,
    );
  }
}

async function handleFailedPayment(payment) {
  await db.query(
    `UPDATE payments SET status = 'FAILED' WHERE id = $1 AND status = 'pending'`,
    [payment.id],
  );

  const other = await db.query(
    `SELECT 1 FROM payments WHERE booking_id = $1 AND id <> $2 AND status IN ('pending', 'SUCCESS') LIMIT 1`,
    [payment.booking_id, payment.id],
  );
  if (other.rows.length > 0) return { outcome: "FAILED" };

  const cancelled = await db.query(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING trip_id`,
    [payment.booking_id],
  );
  if (cancelled.rows[0]) {
    const seats = await db.query(
      `SELECT seat_id FROM booking_seats WHERE booking_id = $1`,
      [payment.booking_id],
    );
    await releaseSeatLocks(
      cancelled.rows[0].trip_id,
      seats.rows.map((s) => s.seat_id),
    );
  }
  return { outcome: "FAILED" };
}

/**
 * Idempotent: asks the gateway for the real status of a payment and applies it.
 * Safe to call from the webhook, the status poll and the background reconciler.
 */
export async function settlePayment(reference) {
  const found = await db.query(
    `SELECT id, booking_id, amount_fcfa, status FROM payments WHERE transaction_ref = $1 LIMIT 1`,
    [reference],
  );
  const payment = found.rows[0];
  if (!payment) return { outcome: "unknown" };
  if (payment.status !== "pending") return { outcome: payment.status };

  const remote = await getTransaction(reference);
  const status = mapGatewayStatus(remote.status);

  if (status === "pending") return { outcome: "pending" };
  if (status === "FAILED") return handleFailedPayment(payment);

  if (
    remote.amount !== undefined &&
    Number(remote.amount) < Number(payment.amount_fcfa)
  ) {
    console.error(
      `[Payments] Amount mismatch on ${reference}: received ${remote.amount}, expected ${payment.amount_fcfa}.`,
    );
    return { outcome: "amount_mismatch" };
  }

  const result = await withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT status FROM payments WHERE id = $1 FOR UPDATE`,
      [payment.id],
    );
    if (locked.rows[0].status === "SUCCESS") return { alreadySettled: true };

    await client.query(`UPDATE payments SET status = 'SUCCESS' WHERE id = $1`, [
      payment.id,
    ]);

    const bookingRes = await client.query(
      `SELECT id, trip_id, status FROM bookings WHERE id = $1`,
      [payment.booking_id],
    );
    const booking = bookingRes.rows[0];
    if (!booking) return { alreadySettled: true };

    await client.query(`SELECT id FROM trips WHERE id = $1 FOR UPDATE`, [
      booking.trip_id,
    ]);

    if (booking.status === "confirmed") return { alreadySettled: true };

    // Payment arrived after the hold expired: only confirm if the seats are still free.
    if (booking.status === "cancelled") {
      const conflicts = await findSeatConflicts(
        client,
        booking.id,
        booking.trip_id,
      );
      if (conflicts.length > 0) return { refundRequired: true };
    }

    await client.query(
      `UPDATE bookings SET status = 'confirmed' WHERE id = $1`,
      [booking.id],
    );
    return { confirmed: true, bookingId: booking.id };
  });

  if (result.refundRequired) {
    console.error(
      `[Payments] REFUND REQUIRED: payment ${reference} succeeded but seats were released to another passenger (booking ${payment.booking_id}).`,
    );
    return { outcome: "refund_required" };
  }

  if (result.confirmed) await afterConfirmation(result.bookingId);
  return { outcome: "SUCCESS" };
}

/** Starts a Mobile Money collection for a pending booking and records the attempt. */
export async function startCollection({ bookingId, phone, description }) {
  const formattedPhone = toInternationalPhone(phone);
  if (!formattedPhone) {
    const error = new Error(
      "Enter a valid 9-digit Mobile Money number starting with 6.",
    );
    error.status = 400;
    throw error;
  }

  const { rows } = await db.query(
    `SELECT b.id, b.total_amount_fcfa, b.status, b.created_at, ap.momo_number
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       JOIN agencies_parks ap ON r.origin_park_id = ap.id
      WHERE b.id = $1`,
    [bookingId],
  );
  const booking = rows[0];

  if (!booking || booking.status !== "pending") {
    const error = new Error(
      "This reservation is no longer active. Please select your seats again.",
    );
    error.status = 409;
    throw error;
  }

  const collection = await collectPayment({
    amount: booking.total_amount_fcfa,
    phone: formattedPhone,
    description: description || `Bus ticket ${bookingId}`,
    externalReference: booking.id,
  });

  await db.query(
    `INSERT INTO payments (booking_id, payer_phone, merchant_momo_number, payment_gateway, transaction_ref, amount_fcfa, status)
     VALUES ($1, $2, $3, 'campay', $4, $5, 'pending')`,
    [
      booking.id,
      formattedPhone,
      booking.momo_number,
      collection.reference,
      booking.total_amount_fcfa,
    ],
  );

  return {
    reference: collection.reference,
    ussdCode: collection.ussd_code || null,
    operator: collection.operator || null,
  };
}

/** Cancels reservations whose hold has expired and releases their seats. */
export async function expireStaleBookings() {
  const { rows } = await db.query(
    `UPDATE bookings SET status = 'cancelled'
      WHERE status = 'pending' AND created_at < NOW() - make_interval(mins => $1)
      RETURNING id, trip_id`,
    [HOLD_MINUTES],
  );

  for (const booking of rows) {
    const seats = await db.query(
      `SELECT seat_id FROM booking_seats WHERE booking_id = $1`,
      [booking.id],
    );
    await releaseSeatLocks(
      booking.trip_id,
      seats.rows.map((s) => s.seat_id),
    );
  }
  return rows.length;
}

/** Background safety net for webhooks that never arrive. */
export async function reconcilePendingPayments() {
  const { rows } = await db.query(
    `SELECT transaction_ref FROM payments
      WHERE status = 'pending' AND transaction_ref IS NOT NULL
        AND created_at > NOW() - INTERVAL '2 hours'
        AND created_at < NOW() - INTERVAL '20 seconds'
      ORDER BY id DESC LIMIT 50`,
  );

  for (const { transaction_ref: reference } of rows) {
    try {
      await settlePayment(reference);
    } catch (err) {
      console.warn(
        `[Payments] Reconcile failed for ${reference}:`,
        err.message,
      );
    }
  }
}
