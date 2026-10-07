import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

// Roles stored in users.role that may manage the platform.
const ADMIN_ROLES = new Set(["agency_admin", "super_admin"]);

export const isAdminRole = (role) => ADMIN_ROLES.has(role);

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

export function requireAdmin(req, res, next) {
  authenticateToken(req, res, () => {
    if (!isAdminRole(req.user?.role)) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to perform this action.",
      });
    }
    return next();
  });
}
