import express from "express";
import bcrypt from "bcrypt";
import db from "../database/pg.js";
import { registerLimiter } from "../middleware/rateLimit.js";
import { HttpError, handle } from "../utils/httpError.js";
import { isValidEmail, toNationalPhone } from "../utils/format.js";

const router = express.Router();
const SALT_ROUNDS = 10;
const GENDERS = ["male", "female", "other"];
const PREFERENCES = ["no_preference", "quiet", "chatty"];

router.post(
  "/register",
  registerLimiter,
  handle(async (req, res) => {
    const fullName = String(req.body?.fullName ?? "").trim().replace(/\s+/g, " ");
    const phone = toNationalPhone(req.body?.phoneNumber);
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const age = Number.parseInt(req.body?.age, 10);
    const gender = String(req.body?.gender ?? "").toLowerCase();
    const preference = PREFERENCES.includes(req.body?.discussionPreference) ? req.body.discussionPreference : "no_preference";
    const password = String(req.body?.password ?? "");

    if (fullName.length < 3 || fullName.length > 120) throw new HttpError(400, "Enter your full name.");
    if (!phone) throw new HttpError(400, "Enter a valid 9-digit phone number starting with 6.");
    if (!isValidEmail(email)) throw new HttpError(400, "Enter a valid email address.");
    if (!Number.isInteger(age) || age < 12 || age > 119) throw new HttpError(400, "Enter a valid age.");
    if (!GENDERS.includes(gender)) throw new HttpError(400, "Select a gender.");
    if (password.length < 8 || password.length > 72) throw new HttpError(400, "Your password must be between 8 and 72 characters.");

    const duplicate = await db.query(
      "SELECT phone_number, email FROM users WHERE phone_number = $1 OR LOWER(email) = $2 LIMIT 1",
      [phone, email],
    );
    if (duplicate.rows[0]) {
      throw new HttpError(
        409,
        duplicate.rows[0].phone_number === phone
          ? "An account with this phone number already exists. Please sign in."
          : "An account with this email address already exists. Please sign in.",
      );
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    try {
      await db.query(
        `INSERT INTO users (full_name, phone_number, email, password_hash, age, gender, discussion_preference)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [fullName, phone, email, passwordHash, age, gender, preference],
      );
    } catch (error) {
      if (error.code === "23505") throw new HttpError(409, "An account with these details already exists. Please sign in.");
      throw error;
    }

    res.status(201).json({ success: true, message: "Your account has been created." });
  }, "We could not create your account right now. Please try again."),
);

export default router;
