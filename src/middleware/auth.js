import jwt from "jsonwebtoken";
import db from "../database/pg.js";
import { env } from "../config/env.js";

export const ADMIN_ROLES = ["agency_admin", "super_admin"];
export const COUNTER_ROLES = [...ADMIN_ROLES, "counter_agent"];
export const STAFF_ROLES = [...ADMIN_ROLES, "counter_agent", "gateman"];

export const isAdminRole = (role) => ADMIN_ROLES.includes(role);

function readToken(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7);
  return req.cookies?.token || null;
}

export function authenticateToken(req, res, next) {
  const token = readToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Please sign in to continue.",
    });
  }

  try {
    req.user = jwt.verify(token, env.jwtSecret);
    return next();
  } catch {
    return res.status(401).json({
      success: false,
      message: "Your session has expired. Please sign in again.",
    });
  }
}

/**
 * Allows only the given roles. The role is read from the database on every call,
 * so a demotion or deactivation takes effect immediately instead of when the token expires.
 */
export function requireRoles(...roles) {
  return (req, res, next) =>
    authenticateToken(req, res, async () => {
      try {
        const { rows } = await db.query("SELECT role, is_active FROM users WHERE id = $1", [req.user.id]);
        const account = rows[0];

        if (!account || account.is_active === false || !roles.includes(account.role)) {
          return res.status(403).json({
            success: false,
            message: "You do not have permission to perform this action.",
          });
        }
        req.user.role = account.role;
        return next();
      } catch (error) {
        console.error("[Auth] Role check failed:", error.message);
        return res.status(500).json({ success: false, message: "We could not verify your access." });
      }
    });
}

export const requireAdmin = requireRoles(...ADMIN_ROLES);
export const requireCounter = requireRoles(...COUNTER_ROLES);
export const requireStaff = requireRoles(...STAFF_ROLES);