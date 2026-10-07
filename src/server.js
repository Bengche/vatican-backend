import "./config/env.js";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import db from "./database/pg.js";
import { runMigrations } from "./database/migrate.js";
import "./services/redis.js";
import "./workers/emailWorker.js";
import { expireStaleBookings, reconcilePendingPayments } from "./services/paymentService.js";

import registration from "./auth/register.js";
import userLogin from "./auth/login.js";
import catalog from "./adminRoutes/bus.js";
import trips from "./adminRoutes/trips.js";
import bookings from "./routes/bookings.js";
import payments from "./routes/payments.js";
import verification from "./routes/verify.js";
import admin from "./adminRoutes/admin.js";

const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(
  cors({
    origin(origin, callback) {
      // Non-browser callers (payment gateway, mobile apps) send no Origin header.
      if (!origin || env.corsOrigins.includes(origin) || (!env.isProduction && /^https?:\/\/localhost(:\d+)?$/.test(origin))) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(cookieParser());

app.get("/health", async (req, res) => {
  try {
    await db.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});

app.use("/api", registration);
app.use("/api", userLogin);
app.use("/api", catalog);
app.use("/api", trips);
app.use("/api", bookings);
app.use("/api", payments);
app.use("/api", verification);
app.use("/api", admin);

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Resource not found." });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ success: false, message: "Malformed request." });
  }
  console.error("[Server] Unhandled error:", err);
  return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
});

process.on("unhandledRejection", (reason) => {
  console.error("[Server] Unhandled rejection:", reason);
});

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    console.error("[Server] Database unavailable at startup:", err.message);
  }

  const server = app.listen(env.port, () => {
    console.log(`[Server] Listening on port ${env.port} (${env.isProduction ? "production" : "development"}).`);
  });

  const timers = [
    setInterval(() => expireStaleBookings().catch((err) => console.warn("[Jobs] Expiry failed:", err.message)), 60_000),
    setInterval(() => reconcilePendingPayments().catch((err) => console.warn("[Jobs] Reconcile failed:", err.message)), 45_000),
  ];

  const shutdown = () => {
    timers.forEach(clearInterval);
    server.close(() => db.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start();
