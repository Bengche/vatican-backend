import crypto from "crypto";
import express from "express";
import db from "../database/pg.js";
import { requireAdmin, requireStaff, isAdminRole } from "../middleware/auth.js";
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
        RETURNING id, user_id, kind, revoked_at`,
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

/** POST /api/admin/devices/register - a staff member enrols the phone or laptop they are using */
router.post(
  "/admin/devices/register",
  requireStaff,
  handle(async (req, res) => {
    const label = String(req.body?.label ?? "").trim().slice(0, 80);
    if (!label) throw new HttpError(400, "Give this device a name, for example 'Gate phone'.");

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

    const { rows } = await db.query(
      `INSERT INTO devices (id, user_id, label, kind) VALUES ($1, $2, $3, 'scanner')
       RETURNING id, label, kind, created_at`,
      [crypto.randomUUID(), req.user.id, label],
    );
    res.status(201).json({ success: true, device: rows[0] });
  }),
);

/** GET /api/admin/devices - every enrolled device and when it last synced */
router.get(
  "/admin/devices",
  requireAdmin,
  handle(async (req, res) => {
    const { rows } = await db.query(
      `SELECT d.id, d.label, d.kind, d.created_at, d.last_seen_at, d.last_sync_at, d.revoked_at,
              u.full_name AS user_name, u.role AS user_role
         FROM devices d
         JOIN users u ON u.id = d.user_id
        ORDER BY d.revoked_at IS NOT NULL, d.last_sync_at DESC NULLS LAST, d.created_at DESC`,
    );
    res.json({ success: true, devices: rows });
  }),
);

/** POST /api/admin/devices/:id/revoke - a lost or stolen device stops syncing and downloading data */
router.post(
  "/admin/devices/:id/revoke",
  requireAdmin,
  handle(async (req, res) => {
    if (!UUID_PATTERN.test(req.params.id)) throw new HttpError(400, "Invalid device.");
    const { rowCount } = await db.query(
      `UPDATE devices SET revoked_at = NOW(), revoked_by = $2
        WHERE id = $1 AND revoked_at IS NULL`,
      [req.params.id, req.user.id],
    );
    if (!rowCount) throw new HttpError(404, "Device not found or already disabled.");
    res.json({ success: true });
  }),
);

export default router;
