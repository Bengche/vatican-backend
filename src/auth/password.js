import crypto from "crypto";
import express from "express";
import bcrypt from "bcrypt";
import db, { withTransaction } from "../database/pg.js";
import { env } from "../config/env.js";
import { forgotPasswordLimiter, resetPasswordLimiter } from "../middleware/rateLimit.js";
import { sendPasswordChangedEmail, sendPasswordResetEmail } from "../services/emailService.js";
import { HttpError, handle } from "../utils/httpError.js";
import { toNationalPhone } from "../utils/format.js";

const router = express.Router();
const RESET_MINUTES = 60;
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

/** POST /api/forgot-password - always answers the same way so accounts cannot be probed */
router.post(
  "/forgot-password",
  forgotPasswordLimiter,
  handle(async (req, res) => {
    const identifier = String(req.body?.identifier ?? "").trim();
    if (!identifier) throw new HttpError(400, "Enter the email address or phone number of your account.");

    const phone = identifier.includes("@") ? null : toNationalPhone(identifier);
    const { rows } = await db.query(
      `SELECT id, full_name, email, is_active FROM users WHERE LOWER(email) = LOWER($1) OR phone_number = $2 LIMIT 1`,
      [identifier, phone || identifier],
    );
    const user = rows[0];

    if (user?.email && user.is_active !== false) {
      const token = crypto.randomBytes(32).toString("hex");

      await withTransaction(async (client) => {
        await client.query(`UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
        await client.query(
          `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + make_interval(mins => $3))`,
          [user.id, sha256(token), RESET_MINUTES],
        );
      });

      // Not awaited: response time must not reveal whether the account exists.
      sendPasswordResetEmail({
        to: user.email,
        name: user.full_name,
        url: `${env.frontendUrl}/reset-password?token=${token}`,
        minutes: RESET_MINUTES,
      }).catch((err) => console.error("[Email] Password reset failed:", err.message));
    }

    res.json({ success: true, message: "If an account matches, a reset link has been sent to its email address." });
  }),
);

/** POST /api/reset-password */
router.post(
  "/reset-password",
  resetPasswordLimiter,
  handle(async (req, res) => {
    const token = String(req.body?.token ?? "");
    const password = String(req.body?.password ?? "");

    if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(400, "This reset link is not valid. Please request a new one.");
    if (password.length < 8 || password.length > 72) throw new HttpError(400, "Your password must be between 8 and 72 characters.");

    const hash = await bcrypt.hash(password, 10);

    const user = await withTransaction(async (client) => {
      const found = await client.query(
        `SELECT pr.id, pr.user_id, u.full_name, u.email
           FROM password_resets pr JOIN users u ON u.id = pr.user_id
          WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW()
          FOR UPDATE OF pr`,
        [sha256(token)],
      );
      const reset = found.rows[0];
      if (!reset) throw new HttpError(400, "This reset link has expired or was already used. Please request a new one.");

      await client.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [reset.user_id, hash]);
      await client.query(`UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [reset.user_id]);
      return reset;
    });

    if (user.email) {
      sendPasswordChangedEmail({ to: user.email, name: user.full_name }).catch((err) => console.error("[Email] Password notice failed:", err.message));
    }

    res.json({ success: true, message: "Your password has been changed. You can now sign in." });
  }),
);

export default router;