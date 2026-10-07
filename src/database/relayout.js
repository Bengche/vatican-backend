import "../config/env.js";
import db, { withTransaction } from "./pg.js";
import { runMigrations } from "./migrate.js";
import { relayoutBus } from "../services/seatLayout.js";

// Usage: npm run relayout -- --force   (also rebuilds buses that already have bookings; seat numbers change)
const force = process.argv.includes("--force");

await runMigrations();
const { rows } = await db.query(`SELECT id, bus_number FROM buses ORDER BY id`);
for (const bus of rows) {
  const result = await withTransaction((client) =>
    relayoutBus(client, bus.id, { force }),
  );
  console.log(`Bus ${bus.bus_number}: ${result}`);
}
await db.end();
