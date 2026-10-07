import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import db from "../database/pg.js";
import { env } from "../config/env.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { handle } from "../utils/httpError.js";
import { toNationalPhone } from "../utils/format.js";

const router = express.Router();

// Used to keep response time similar when the account does not exist.
const DUMMY_HASH = bcrypt.hashSync("timing-placeholder", 10);

router.post(
  "/login",
  loginLimiter,
  handle(async (req, res) => {
    const identifier = String(req.body?.identifier ?? "").trim();
    const password = String(req.body?.password ?? "");

    if (!identifier || !password) {
      return res.status(400).json({ success: false, message: "Enter your phone number or email and your password." });
    }

    const phone = identifier.includes("@") ? null : toNationalPhone(identifier);

    const { rows } = await db.query(
      `SELECT id, full_name, email, phone_number, password_hash, role
         FROM users
        WHERE LOWER(email) = LOWER($1) OR phone_number = $2
        LIMIT 1`,
      [identifier, phone || identifier],
    );
    const user = rows[0];

    const valid = await bcrypt.compare(password, user?.password_hash || DUMMY_HASH);
    if (!user || !valid) {
      return res.status(401).json({ success: false, message: "Incorrect phone number, email or password." });
    }

    const token = jwt.sign(
      { id: user.id, phone_number: user.phone_number, email: user.email, role: user.role },
      env.jwtSecret,
      { expiresIn: "30d" },
    );

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.full_name,
        email: user.email,
        phone_number: user.phone_number,
        role: user.role,
      },
    });
  }, "We could not sign you in right now. Please try again."),
);

export default router;
