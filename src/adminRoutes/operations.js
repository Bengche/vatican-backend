import express from "express";
import bcrypt from "bcrypt";
import db from "../database/pg.js";
import { requireAdmin, requireCounter } from "../middleware/auth.js";
import { cancelBooking, suggestRefund } from "../services/refundService.js";
import { sendPayoutById } from "../services/payoutService.js";
import { getBookingRecord } from "../services/receiptService.js";
import { HttpError, handle } from "../utils/httpError.js";
import { isValidEmail, toNationalPhone } from "../utils/format.js";

const router = express.Router();

const isId = (value) => /^\d{1,18}$/.test(String(value));
const needId = (value, message = "Invalid identifier.") => {
  if (!isId(value)) throw new HttpError(400, message);
  return String(value);
};
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));

/* ------------------------------------------------------------------ */
/* Bookings: search, details, cancellation                             */
/* ------------------------------------------------------------------ */

/** GET /api/admin/bookings?q=&status= */
router.get(
  "/admin/bookings",
  requireAdmin,
  handle(async (req, res) => {
    const q = String(req.query.q ?? "")
      .trim()
      .slice(0, 60);
    const status = ["confirmed", "pending", "cancelled"].includes(
      req.query.status,
    )
      ? req.query.status
      : null;
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;

    const { rows } = await db.query(
      `SELECT b.id, b.booking_ref, b.status, COALESCE(b.payment_method, 'momo') AS payment_method,
              b.total_amount_fcfa, b.created_at, b.is_checked_in,
              t.travel_date, t.departure_time, p1.city AS origin_city, p2.city AS destination_city,
              (SELECT string_agg(bs.passenger_name, ', ' ORDER BY bs.id) FROM booking_seats bs WHERE bs.booking_id = b.id) AS passengers
         FROM bookings b
         JOIN trips t ON b.trip_id = t.id
         JOIN routes r ON t.route_id = r.id
         JOIN agencies_parks p1 ON r.origin_park_id = p1.id
         JOIN agencies_parks p2 ON r.destination_park_id = p2.id
        WHERE ($1 = '' OR b.booking_ref ILIKE $2 OR b.passenger_phone ILIKE $2 OR b.passenger_name ILIKE $2
               OR EXISTS (SELECT 1 FROM booking_seats bs WHERE bs.booking_id = b.id AND (bs.passenger_name ILIKE $2 OR bs.id_card_number ILIKE $2)))
          AND ($3::text IS NULL OR b.status = $3)
        ORDER BY b.created_at DESC
        LIMIT 50`,
      [q, like, status],
    );
    res.json({ success: true, bookings: rows });
  }),
);

/** GET /api/admin/bookings/:id */
router.get(
  "/admin/bookings/:id",
  requireAdmin,
  handle(async (req, res) => {
    const id = needId(req.params.id, "Invalid booking.");
    const record = await getBookingRecord(id);
    if (!record) throw new HttpError(404, "Booking not found.");

    const payouts = await db.query(
      `SELECT id, kind, amount_fcfa, status, error, reason, created_at FROM payouts WHERE booking_id = $1 ORDER BY id`,
      [id],
    );
    res.json({
      success: true,
      booking: record,
      refundSuggestion:
        record.booking_status === "confirmed" ? suggestRefund(record) : null,
      payouts: payouts.rows,
    });
  }),
);

/** POST /api/admin/bookings/:id/cancel  { reason, refundAmount } */
router.post(
  "/admin/bookings/:id/cancel",
  requireAdmin,
  handle(async (req, res) => {
    const result = await cancelBooking({
      bookingId: needId(req.params.id, "Invalid booking."),
      adminId: req.user.id,
      reason: req.body?.reason,
      refundAmount: req.body?.refundAmount ?? 0,
    });
    res.json({
      success: true,
      message: "Booking cancelled and seats released.",
      ...result,
    });
  }, "We could not cancel this booking."),
);

/* ------------------------------------------------------------------ */
/* Payouts                                                             */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/payouts/summary",
  requireAdmin,
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'failed') AS failed,
              COUNT(*) FILTER (WHERE status IN ('pending', 'processing') AND created_at < NOW() - INTERVAL '15 minutes') AS stuck
         FROM payouts`,
    );
    res.json({
      success: true,
      failed: Number(rows[0].failed),
      stuck: Number(rows[0].stuck),
    });
  }),
);

router.get(
  "/admin/payouts",
  requireAdmin,
  handle(async (req, res) => {
    const status = [
      "pending",
      "processing",
      "sent",
      "failed",
      "cancelled",
    ].includes(req.query.status)
      ? req.query.status
      : null;
    const { rows } = await db.query(
      `SELECT p.id, p.kind, p.amount_fcfa, p.phone, p.status, p.error, p.reason, p.attempts, p.created_at, p.updated_at, b.booking_ref
         FROM payouts p LEFT JOIN bookings b ON b.id = p.booking_id
        WHERE ($1::text IS NULL OR p.status = $1)
        ORDER BY (p.status = 'failed') DESC, p.id DESC
        LIMIT 100`,
      [status],
    );
    res.json({ success: true, payouts: rows });
  }),
);

router.post(
  "/admin/payouts/:id/retry",
  requireAdmin,
  handle(async (req, res) => {
    const result = await sendPayoutById(
      needId(req.params.id, "Invalid payout."),
    );
    if (!result)
      throw new HttpError(409, "This payout cannot be retried right now.");
    res.json({
      success: true,
      status: result.status,
      message:
        result.status === "sent"
          ? "Payout sent."
          : `Payout failed: ${result.error}`,
    });
  }),
);

router.post(
  "/admin/payouts/:id/dismiss",
  requireAdmin,
  handle(async (req, res) => {
    const note = String(req.body?.note ?? "")
      .trim()
      .slice(0, 300);
    const { rowCount } = await db.query(
      `UPDATE payouts SET status = 'cancelled', error = COALESCE(NULLIF($2, ''), 'Settled manually'), updated_at = NOW()
        WHERE id = $1 AND status = 'failed'`,
      [needId(req.params.id, "Invalid payout."), note],
    );
    if (!rowCount)
      throw new HttpError(409, "Only failed payouts can be marked as settled.");
    res.json({ success: true });
  }),
);

/* ------------------------------------------------------------------ */
/* Staff accounts                                                      */
/* ------------------------------------------------------------------ */

const STAFF_ROLE_LABELS = ["counter_agent", "gateman", "agency_admin"];

router.get(
  "/admin/staff",
  requireAdmin,
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, full_name, phone_number, email, role, is_active, created_at
         FROM users WHERE role <> 'passenger' ORDER BY is_active DESC, role, full_name`,
    );
    res.json({ success: true, staff: rows });
  }),
);

router.post(
  "/admin/staff",
  requireAdmin,
  handle(async (req, res) => {
    const fullName = String(req.body?.fullName ?? "").trim();
    const phone = toNationalPhone(req.body?.phoneNumber);
    const email =
      String(req.body?.email ?? "")
        .trim()
        .toLowerCase() || null;
    const role = String(req.body?.role ?? "");
    const password = String(req.body?.password ?? "");

    if (fullName.length < 3)
      throw new HttpError(400, "Enter the staff member's full name.");
    if (!phone)
      throw new HttpError(400, "Enter a valid Cameroon phone number.");
    if (email && !isValidEmail(email))
      throw new HttpError(400, "Enter a valid email address.");
    if (!STAFF_ROLE_LABELS.includes(role))
      throw new HttpError(400, "Select a valid role.");
    if (role === "agency_admin" && req.user.role !== "super_admin")
      throw new HttpError(
        403,
        "Only a super administrator can create administrators.",
      );
    if (password.length < 8 || password.length > 72)
      throw new HttpError(
        400,
        "The password must be between 8 and 72 characters.",
      );

    const duplicate = await db.query(
      `SELECT 1 FROM users WHERE phone_number = $1 OR ($2::text IS NOT NULL AND LOWER(email) = $2) LIMIT 1`,
      [phone, email],
    );
    if (duplicate.rows[0])
      throw new HttpError(
        409,
        "An account with this phone number or email already exists.",
      );

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (full_name, phone_number, email, password_hash, role, age, gender)
       VALUES ($1, $2, $3, $4, $5, 30, 'other') RETURNING id, full_name, phone_number, email, role, is_active`,
      [fullName, phone, email, hash, role],
    );
    res.status(201).json({ success: true, staff: rows[0] });
  }, "We could not create this account."),
);

router.patch(
  "/admin/staff/:id",
  requireAdmin,
  handle(async (req, res) => {
    const id = needId(req.params.id, "Invalid account.");
    const target = (
      await db.query(`SELECT id, role FROM users WHERE id = $1`, [id])
    ).rows[0];
    if (!target || target.role === "passenger")
      throw new HttpError(404, "Staff account not found.");
    if (
      ["agency_admin", "super_admin"].includes(target.role) &&
      req.user.role !== "super_admin"
    ) {
      throw new HttpError(
        403,
        "Only a super administrator can change administrator accounts.",
      );
    }

    const updates = [];
    const values = [id];
    if (typeof req.body?.isActive === "boolean") {
      if (String(req.user.id) === id && req.body.isActive === false)
        throw new HttpError(400, "You cannot deactivate your own account.");
      values.push(req.body.isActive);
      updates.push(`is_active = $${values.length}`);
    }
    if (req.body?.password) {
      const password = String(req.body.password);
      if (password.length < 8 || password.length > 72)
        throw new HttpError(
          400,
          "The password must be between 8 and 72 characters.",
        );
      values.push(await bcrypt.hash(password, 10));
      updates.push(`password_hash = $${values.length}`);
    }
    if (req.body?.role) {
      if (!STAFF_ROLE_LABELS.includes(req.body.role))
        throw new HttpError(400, "Select a valid role.");
      if (req.body.role === "agency_admin" && req.user.role !== "super_admin")
        throw new HttpError(
          403,
          "Only a super administrator can create administrators.",
        );
      values.push(req.body.role);
      updates.push(`role = $${values.length}`);
    }
    if (!updates.length) throw new HttpError(400, "Nothing to update.");

    await db.query(
      `UPDATE users SET ${updates.join(", ")} WHERE id = $1`,
      values,
    );
    res.json({ success: true });
  }),
);

/* ------------------------------------------------------------------ */
/* Cash reconciliation                                                 */
/* ------------------------------------------------------------------ */

/** Cash taken and cash refunded per counter user for one day. */
async function cashFigures(date, agentId = null) {
  const sales = await db.query(
    `SELECT b.user_id AS agent_id, COUNT(*) AS bookings,
            COALESCE(SUM(b.total_amount_fcfa), 0) AS sales,
            COALESCE(SUM((SELECT COUNT(*) FROM booking_seats bs WHERE bs.booking_id = b.id)), 0) AS tickets
       FROM bookings b
      WHERE b.payment_method = 'cash_counter' AND b.status IN ('confirmed', 'cancelled')
        AND b.created_at::date = $1::date AND ($2::bigint IS NULL OR b.user_id = $2)
      GROUP BY b.user_id`,
    [date, agentId],
  );
  const refunds = await db.query(
    `SELECT b.user_id AS agent_id, COALESCE(SUM(p.amount_fcfa), 0) AS refunds
       FROM payouts p JOIN bookings b ON b.id = p.booking_id
      WHERE p.kind = 'refund' AND p.phone IS NULL AND p.status = 'sent'
        AND p.created_at::date = $1::date AND ($2::bigint IS NULL OR b.user_id = $2)
      GROUP BY b.user_id`,
    [date, agentId],
  );

  const byAgent = new Map();
  const entry = (id) => {
    const key = String(id);
    if (!byAgent.has(key))
      byAgent.set(key, {
        agentId: key,
        bookings: 0,
        tickets: 0,
        sales: 0,
        refunds: 0,
      });
    return byAgent.get(key);
  };
  for (const row of sales.rows)
    Object.assign(entry(row.agent_id), {
      bookings: Number(row.bookings),
      tickets: Number(row.tickets),
      sales: Number(row.sales),
    });
  for (const row of refunds.rows)
    entry(row.agent_id).refunds = Number(row.refunds);
  return [...byAgent.values()].map((row) => ({
    ...row,
    expected: row.sales - row.refunds,
  }));
}

/** GET /api/admin/cash/report?date= */
router.get(
  "/admin/cash/report",
  requireAdmin,
  handle(async (req, res) => {
    const date = isDate(req.query.date)
      ? req.query.date
      : (await db.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    const figures = await cashFigures(date);

    const handovers = await db.query(
      `SELECT h.agent_id, h.expected_fcfa, h.counted_fcfa, h.note, h.created_at, u.full_name AS recorded_by_name
         FROM cash_handovers h LEFT JOIN users u ON u.id = h.recorded_by WHERE h.report_date = $1::date`,
      [date],
    );
    const handoverByAgent = new Map(
      handovers.rows.map((h) => [String(h.agent_id), h]),
    );

    const ids = [
      ...new Set([...figures.map((f) => f.agentId), ...handoverByAgent.keys()]),
    ];
    const users = ids.length
      ? (
          await db.query(
            `SELECT id, full_name, role FROM users WHERE id = ANY($1::bigint[])`,
            [ids],
          )
        ).rows
      : [];
    const userById = new Map(users.map((u) => [String(u.id), u]));

    const agents = ids.map((id) => {
      const f = figures.find((x) => x.agentId === id) || {
        agentId: id,
        bookings: 0,
        tickets: 0,
        sales: 0,
        refunds: 0,
        expected: 0,
      };
      const h = handoverByAgent.get(id);
      return {
        ...f,
        name: userById.get(id)?.full_name || "Unknown",
        role: userById.get(id)?.role || null,
        handover: h
          ? {
              counted: h.counted_fcfa,
              expectedAtRecording: h.expected_fcfa,
              variance: h.counted_fcfa - f.expected,
              note: h.note,
              recordedAt: h.created_at,
              recordedBy: h.recorded_by_name,
            }
          : null,
      };
    });

    res.json({
      success: true,
      date,
      agents,
      totals: {
        sales: agents.reduce((s, a) => s + a.sales, 0),
        refunds: agents.reduce((s, a) => s + a.refunds, 0),
        expected: agents.reduce((s, a) => s + a.expected, 0),
      },
    });
  }),
);

/** POST /api/admin/cash/handover  { agentId, date, countedAmount, note } */
router.post(
  "/admin/cash/handover",
  requireAdmin,
  handle(async (req, res) => {
    const agentId = needId(req.body?.agentId, "Select a counter agent.");
    const date = isDate(req.body?.date) ? req.body.date : null;
    const counted = Number.parseInt(req.body?.countedAmount, 10);
    if (!date) throw new HttpError(400, "Select a valid date.");
    if (!Number.isInteger(counted) || counted < 0)
      throw new HttpError(400, "Enter the amount of cash counted.");

    const expected = (await cashFigures(date, agentId))[0]?.expected ?? 0;
    await db.query(
      `INSERT INTO cash_handovers (agent_id, report_date, expected_fcfa, counted_fcfa, note, recorded_by)
       VALUES ($1, $2::date, $3, $4, $5, $6)
       ON CONFLICT (agent_id, report_date)
       DO UPDATE SET expected_fcfa = EXCLUDED.expected_fcfa, counted_fcfa = EXCLUDED.counted_fcfa, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by, created_at = NOW()`,
      [
        agentId,
        date,
        expected,
        counted,
        String(req.body?.note ?? "")
          .trim()
          .slice(0, 300) || null,
        req.user.id,
      ],
    );
    res.json({
      success: true,
      expected,
      counted,
      variance: counted - expected,
    });
  }),
);

/** GET /api/admin/cash/mine - a counter agent's own sales today */
router.get(
  "/admin/cash/mine",
  requireCounter,
  handle(async (req, res) => {
    const today = (await db.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    const figures = (await cashFigures(today, req.user.id))[0] || {
      bookings: 0,
      tickets: 0,
      sales: 0,
      refunds: 0,
      expected: 0,
    };
    const tickets = await db.query(
      `SELECT b.id, b.booking_ref, b.status, b.total_amount_fcfa, b.created_at,
              p1.city AS origin_city, p2.city AS destination_city, t.travel_date, t.departure_time
         FROM bookings b
         JOIN trips t ON b.trip_id = t.id
         JOIN routes r ON t.route_id = r.id
         JOIN agencies_parks p1 ON r.origin_park_id = p1.id
         JOIN agencies_parks p2 ON r.destination_park_id = p2.id
        WHERE b.user_id = $1 AND b.payment_method = 'cash_counter' AND b.created_at::date = $2::date
        ORDER BY b.created_at DESC`,
      [req.user.id, today],
    );
    res.json({ success: true, date: today, ...figures, tickets: tickets.rows });
  }),
);

export default router;
