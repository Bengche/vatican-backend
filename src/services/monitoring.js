import { env } from "../config/env.js";

let sentry = null;

/** Optional error tracking. Active only when SENTRY_DSN is set and @sentry/node is installed. */
export async function initMonitoring() {
  if (!env.sentryDsn) return;
  try {
    const mod = await import("@sentry/node");
    mod.init({ dsn: env.sentryDsn, environment: env.isProduction ? "production" : "development", tracesSampleRate: 0 });
    sentry = mod;
    console.log("[Monitoring] Error tracking enabled.");
  } catch {
    console.warn("[Monitoring] SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node");
  }
}

export function captureError(error) {
  try {
    sentry?.captureException(error);
  } catch {
    /* never let monitoring break the request */
  }
}