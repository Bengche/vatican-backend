// Loads .env once and exposes validated runtime settings.
import dotenv from "dotenv";

dotenv.config();

const REQUIRED = [
  "PG_HOST",
  "PG_DATABASE",
  "PG_USER",
  "PG_PASSWORD",
  "JWT_SECRET",
];
const missing = REQUIRED.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `[Config] Missing required environment variables: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const isProduction = process.env.NODE_ENV === "production";

if (isProduction && process.env.JWT_SECRET.length < 32) {
  console.error(
    "[Config] JWT_SECRET must be at least 32 characters in production.",
  );
  process.exit(1);
}

const stripSlash = (value) => String(value || "").replace(/\/+$/, "");

// Accepts a plain URL or a pasted provider CLI command (e.g. "redis-cli --tls -u redis://...").
function normaliseRedisUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const matches = value.match(/rediss?:\/\/[^\s'"]+/g);
  if (!matches) return "";
  const url = matches[matches.length - 1];
  return /--tls\b/.test(value) && url.startsWith("redis://")
    ? `rediss://${url.slice(8)}`
    : url;
}

const frontendUrl =
  stripSlash(process.env.FRONTEND_URL) || "http://localhost:3000";

export const env = {
  isProduction,
  port: Number(process.env.PORT) || 8000,
  frontendUrl,
  // Public URL of this API; used for assets embedded in emails (QR codes).
  apiPublicUrl: stripSlash(process.env.API_PUBLIC_URL),
  corsOrigins: (process.env.CORS_ORIGINS || frontendUrl)
    .split(",")
    .map((origin) => stripSlash(origin.trim()))
    .filter(Boolean),
  jwtSecret: process.env.JWT_SECRET,
  pg: {
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    port: Number(process.env.PG_PORT) || 5432,
    ssl: process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
  },
  redisUrl: normaliseRedisUrl(process.env.REDIS_URL),
  sendgridApiKey: process.env.SENDGRID_API_KEY || "",
  alertEmail: process.env.ALERT_EMAIL || "",
  sentryDsn: process.env.SENTRY_DSN || "",
  campay: {
    baseUrl:
      stripSlash(process.env.CAMPAY_BASE_URL) || "https://www.campay.net/api",
    permanentToken: process.env.CAMPAY_APP_PERMANENT_ACCESS_TOKEN || "",
    username: process.env.CAMPAY_APP_USERNAME || "",
    password: process.env.CAMPAY_APP_PASSWORD || "",
  },
  platformPayoutNumber: process.env.DEVELOPER_MOMO_NUMBER || "",
};
