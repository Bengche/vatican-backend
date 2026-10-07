import express from "express";
import db from "../database/pg.js";
import { authenticateToken, isAdminRole } from "../middleware/auth.js";
import { paymentLimiter, webhookLimiter } from "../middleware/rateLimit.js";
import { settlePayment, startCollection } from "../services/paymentService.js";
import { HttpError, handle } from "../utils/httpError.js";

const router = express.Router();

async function loadOwnedBooking(req, bookingId) {
  if (!/^\d{1,18}$/.test(String(bookingId)))
    throw new HttpError(400, "Invalid booking.");

  const { rows } = await db.query(
    "SELECT id, user_id, booking_ref, status FROM bookings WHERE id = $1",
    [bookingId],
  );
  const booking = rows[0];

  if (
    !booking ||
    (String(booking.user_id) !== String(req.user.id) &&
      !isAdminRole(req.user.role))
  ) {
    throw new HttpError(404, "Booking not found.");
  }
  return booking;
}

const latestPayment = async (bookingId) =>
  (
    await db.query(
      `SELECT status, transaction_ref FROM payments WHERE booking_id = $1 ORDER BY id DESC LIMIT 1`,
      [bookingId],
    )
  ).rows[0];

/** POST /api/payments/request-payment - sends the Mobile Money prompt to the passenger's phone */
router.post(
  "/payments/request-payment",
  authenticateToken,
  paymentLimiter,
  handle(async (req, res) => {
    const booking = await loadOwnedBooking(req, req.body?.bookingId);

    try {
      const collection = await startCollection({
        bookingId: booking.id,
        phone: req.body?.phone,
        description: `Bus ticket ${booking.booking_ref}`,
      });
      res.json({
        success: true,
        message: "Payment request sent to your phone.",
        ...collection,
      });
    } catch (error) {
      if (error.status && error.status < 500)
        throw new HttpError(error.status, error.message);
      console.error(
        "[Payments] Collection failed:",
        error.details || error.message,
      );
      throw new HttpError(
        502,
        "We could not reach your Mobile Money provider. Please try again in a moment.",
      );
    }
  }, "We could not start the payment. Please try again."),
);

/** GET /api/payments/status/:bookingId - polled by the checkout screen */
router.get(
  "/payments/status/:bookingId",
  authenticateToken,
  handle(async (req, res) => {
    let booking = await loadOwnedBooking(req, req.params.bookingId);
    let payment = await latestPayment(booking.id);

    // Do not rely on the webhook alone: ask the gateway while the payment is outstanding.
    if (
      booking.status === "pending" &&
      payment?.status === "pending" &&
      payment.transaction_ref
    ) {
      try {
        await settlePayment(payment.transaction_ref);
        booking = await loadOwnedBooking(req, booking.id);
        payment = await latestPayment(booking.id);
      } catch (error) {
        console.warn("[Payments] Status check deferred:", error.message);
      }
    }

    res.json({
      success: true,
      bookingStatus: booking.status,
      paymentStatus: payment?.status || null,
      bookingRef: booking.booking_ref,
    });
  }, "We could not check the payment status."),
);

/**
 * Gateway callback (GET or POST). The payload is never trusted: only the reference is read and
 * the real outcome is fetched from the gateway before anything is confirmed.
 */
const webhook = async (req, res) => {
  const params = { ...req.query, ...req.body };
  const reference =
    typeof params.reference === "string" ? params.reference.trim() : "";

  if (!reference)
    return res
      .status(400)
      .json({ success: false, message: "Missing reference." });

  try {
    const result = await settlePayment(reference);
    return res.status(200).json({ success: true, outcome: result.outcome });
  } catch (error) {
    console.error("[Payments] Webhook processing failed:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Webhook handler failed." });
  }
};

router.get("/payments/webhook", webhookLimiter, webhook);
router.post("/payments/webhook", webhookLimiter, webhook);

export default router;
