import crypto from "crypto";
import express from "express";
import db from "../database/pg.js";
import { requireAdmin, requireStaff, isAdminRole, ADMIN_ROLES } from "../middleware/auth.js";
import { HttpError, handle } from "../utils/httpError.js";

const router = express.Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACTIVE_DEVICES_PER_USER = 5;

/**
 * Offline endpoints must come from a registered, non-revoked device that belongs to the signed-in user.
 * Run after requireStaff. A revoked device receives DEVICE_REVOKED so the app can wipe its local data.
 */
export async function requireDevice(req, res, next) {
  try {
    const deviceId = String(req.get("x-device-id") ?? "");
    if (!UUID_PATTERN.test(deviceId)) {
      return res.status(400).json({
        success: false,
        code: "DEVICE_REQUIRED",
        message: "This device is not registered for offline use.",
      });
    }

    const { rows } = await db.query(
      `UPDATE devices SET last_seen_at = NOW()
        WHERE id = $1 AND (user_id = $2 OR $3::boolean)
        RETURNING id, user_id, kind, code, park_id, revoked_at`,
      [deviceId, req.user.id, isAdminRole(req.user.role)],
    );
    const device = rows[0];

    if (!device) {
      return res.status(403).json({
        success: false,
        code: "DEVICE_UNKNOWN",
        message: "This device is not registered for offline use.",
      });
    }
    if (device.revoked_at) {
      return res.status(403).json({
        success: false,
        code: "DEVICE_REVOKED",
        message: "This device has been disabled. Contact your administrator.",
      });
    }

    req.device = device;
    return next();
  } catch (error) {
    console.error("[Devices] Device check failed:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "We could not verify this device." });
  }
}

/** Like requireDevice, but only for devices of the given kind (e.g. counter tills). */
export const requireDeviceKind = (kind) => (req, res, next) =>
  requireDevice(req, res, () =>
    req.device.kind === kind
      ? next()
      : res.status(403).json({
          success: false,
          code: "DEVICE_UNKNOWN",
          message: "This device is not set up for this function.",
        }),
  );

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () =>
  Array.from(crypto.randomBytes(2), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

/** Raw Ed25519 public key as 32 bytes of base64url, the format scanners expect. */
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** POST /api/admin/devices/register - a staff member enrols the phone or laptop they are using */
router.post(
  "/admin/devices/register",
  requireStaff,
  handle(async (req, res) => {
    const label = String(req.body?.label ?? "").trim().slice(0, 80);
    if (!label) throw new HttpError(400, "Give this device a name, for example 'Gate phone'.");

    const kind = req.body?.kind === "counter" ? "counter" : "scanner";
    let publicKey = null;
    let parkId = null;
    if (kind === "counter") {
      if (!["counter_agent", ...ADMIN_ROLES].includes(req.user.role)) {
        throw new HttpError(403, "Only counter agents and administrators can set up a sales device.");
      }
      publicKey = String(req.body?.publicKey ?? "");
      if (!PUBLIC_KEY_PATTERN.test(publicKey)) throw new HttpError(400, "This device could not create its security key.");
      parkId = String(req.body?.parkId ?? "");
      if (!/^\d{1,18}$/.test(parkId)) throw new HttpError(400, "Choose the terminal this counter sells from.");
      const park = await db.query("SELECT 1 FROM agencies_parks WHERE id = $1 AND is_active IS NOT FALSE", [parkId]);
      if (!park.rows[0]) throw new HttpError(400, "That terminal does not exist.");
    }

    const active = await db.query(
      "SELECT COUNT(*)::int AS n FROM devices WHERE user_id = $1 AND revoked_at IS NULL",
      [req.user.id],
    );
    if (active.rows[0].n >= MAX_ACTIVE_DEVICES_PER_USER) {
      throw new HttpError(
        409,
        "This account already has the maximum number of devices. Ask an administrator to disable one you no longer use.",
      );
    }

    let device;
    for (let attempt = 0; attempt < 8 && !device; attempt += 1) {
      try {
        const { rows } = await db.query(
          `INSERT INTO devices (id, user_id, label, kind, code, public_key, park_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, label, kind, code, created_at`,
          [crypto.randomUUID(), req.user.id, label, kind, kind === "counter" ? randomCode() : null, publicKey, parkId],
        );
        device = rows[0];
      } catch (error) {
        if (error.code !== "23505") throw error;
      }
    }
    if (!device) throw new Error("Could not allocate a device code.");

    res.status(201).json({
      success: true,
      device: { ...device, keyId: device.code ? `c${device.code}` : null },
    });
  }),
);

/** GET /api/admin/devices - every enrolled device and when it last synced */
router.get(
  "/admin/devices",
  requireAdmin,
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT d.id, d.label, d.kind, d.created_at, d.last_seen_at, d.last_sync_at, d.revoked_at,
              d.selling_since, d.lease_until, ap.city AS park_city, ap.park_name,
              u.full_name AS user_name, u.role AS user_role
         FROM devices d
         JOIN users u ON u.id = d.user_id
         LEFT JOIN agencies_parks ap ON ap.id = d.park_id
        ORDER BY d.revoked_at IS NOT NULL, d.last_sync_at DESC NULLS LAST, d.created_at DESC`,
    );
    res.json({ success: true, devices: rows });
  }),
);

/** POST /api/admin/devices/:id/end-session - marks a counter as closed so online booking reopens for its terminal */
router.post(
  "/admin/devices/:id/end-session",
  requireAdmin,
  handle(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "Invalid device.");
    await db.query(
      "UPDATE devices SET selling_since = NULL, lease_until = NULL WHERE id = $1",
      [req.params.id],
    );
    res.json({ success: true });
  }),
);

/** POST /api/admin/devices/:id/revoke - a lost or stolen device stops syncing and downloading data */
router.post(
  "/admin/devices/:id/revoke",
  requireAdmin,
  handle(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "Invalid device.");
    const { rowCount } = await db.query(
      `UPDATE devices SET revoked_at = NOW(), revoked_by = $2, selling_since = NULL, lease_until = NULL
        WHERE id = $1 AND revoked_at IS NULL`,
      [req.params.id, req.user.id],
    );
    if (!rowCount) throw new HttpError(404, "Device not found or already disabled.");
    res.json({ success: true });
  }),
);

export default router;
