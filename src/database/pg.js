import pg from "pg";
import { env } from "../config/env.js";
import { brand } from "../config/brand.js";

// Keep DATE columns as plain 'YYYY-MM-DD' strings so they never shift across time zones.
pg.types.setTypeParser(1082, (value) => value);

const pool = new pg.Pool({
  ...env.pg,
  max: 15,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Every session uses Cameroon time so "today", hold expiry and reports agree in any environment.
  options: `-c timezone=${brand.timezone}`,
});

pool.on("error", (err) => {
  console.error("[Postgres] Idle client error:", err.message);
});

/**
 * Runs `work(client)` inside a transaction on a dedicated connection.
 * Commits on success, rolls back and rethrows on failure.
 */
export async function withTransaction(work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export default pool;
