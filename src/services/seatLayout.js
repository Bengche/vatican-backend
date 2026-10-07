/**
 * Cameroon coach plan, front to back (driver on the left):
 *   row 1   driver | co-driver seat | aisle | front door
 *   rows    2 seats | aisle | 3 seats
 *   door row  2 seats | aisle | rear door
 *   last row  remaining seats, no aisle, centred
 * Non-seat cells (driver, doors, aisles) are stored as non-bookable rows.
 */
export function buildLayout(capacity) {
  const cells = [];
  let seatNumber = 0;

  const seat = (row, col, isWindow) => {
    seatNumber += 1;
    cells.push({ label: `S${seatNumber}`, row, col, isAisle: false, isWindow });
  };
  const marker = (label, row, col) =>
    cells.push({ label, row, col, isAisle: true, isWindow: false });
  const door = (row) => [4, 5, 6].forEach((col) => marker("DOOR", row, col));

  let row = 1;
  marker("DRIVER", row, 1);
  seat(row, 2, false);
  marker("AISLE", row, 3);
  door(row);

  const remaining = Math.max(capacity - 1, 0);
  const hasDoorRow = remaining >= 3;
  const rest = hasDoorRow ? remaining - 2 : remaining;

  let fullRows = Math.floor(rest / 5);
  let lastCount = rest % 5;
  if (lastCount === 0 && fullRows > 0) {
    fullRows -= 1;
    lastCount = 5;
  }

  for (let i = 0; i < fullRows; i += 1) {
    row += 1;
    seat(row, 1, true);
    seat(row, 2, false);
    marker("AISLE", row, 3);
    seat(row, 4, false);
    seat(row, 5, false);
    seat(row, 6, true);
  }

  if (hasDoorRow) {
    row += 1;
    seat(row, 1, true);
    seat(row, 2, false);
    marker("AISLE", row, 3);
    door(row);
  }

  if (lastCount > 0) {
    row += 1;
    for (let col = 1; col <= lastCount; col += 1) {
      seat(row, col, lastCount === 5 && (col === 1 || col === 5));
    }
  }

  return cells;
}

export async function insertCells(client, busId, cells) {
  if (cells.length === 0) return;
  await client.query(
    `INSERT INTO bus_seats (bus_id, seat_label, row_num, col_num, is_aisle, is_window)
     SELECT $1, s.label, s.row_num, s.col_num, s.is_aisle, s.is_window
       FROM unnest($2::text[], $3::int[], $4::int[], $5::boolean[], $6::boolean[]) AS s(label, row_num, col_num, is_aisle, is_window)`,
    [
      busId,
      cells.map((c) => c.label),
      cells.map((c) => c.row),
      cells.map((c) => c.col),
      cells.map((c) => c.isAisle),
      cells.map((c) => c.isWindow),
    ],
  );
}

/**
 * Rebuilds an existing bus with the current plan. Seat ids are kept, so bookings stay attached,
 * but seat numbers change; buses that already have bookings are left alone unless `force` is set.
 */
export async function relayoutBus(client, busId, { force = false } = {}) {
  const seats = (
    await client.query(
      `SELECT id FROM bus_seats WHERE bus_id = $1 AND is_aisle = false ORDER BY row_num, col_num, id`,
      [busId],
    )
  ).rows;
  if (seats.length === 0) return "empty";

  if (!force) {
    const booked = await client.query(
      `SELECT 1 FROM booking_seats bs JOIN bus_seats s ON s.id = bs.seat_id WHERE s.bus_id = $1 LIMIT 1`,
      [busId],
    );
    if (booked.rowCount > 0) return "has-bookings";
  }

  const cells = buildLayout(seats.length);
  const seatCells = cells.filter((c) => !c.isAisle);
  const markerCells = cells.filter((c) => c.isAisle);

  await client.query(
    `DELETE FROM bus_seats WHERE bus_id = $1 AND is_aisle = true`,
    [busId],
  );
  await client.query(
    `UPDATE bus_seats s
        SET seat_label = v.label, row_num = v.row_num, col_num = v.col_num, is_window = v.is_window
       FROM unnest($1::bigint[], $2::text[], $3::int[], $4::int[], $5::boolean[]) AS v(id, label, row_num, col_num, is_window)
      WHERE s.id = v.id`,
    [
      seats.map((s) => s.id),
      seatCells.map((c) => c.label),
      seatCells.map((c) => c.row),
      seatCells.map((c) => c.col),
      seatCells.map((c) => c.isWindow),
    ],
  );
  await insertCells(client, busId, markerCells);
  return "updated";
}

/** Applies the current plan to every bus still on the old layout and without bookings. */
export async function upgradeBusLayouts(db, withTransaction) {
  const { rows } = await db.query(
    `SELECT b.id FROM buses b
      WHERE NOT EXISTS (SELECT 1 FROM bus_seats s WHERE s.bus_id = b.id AND s.seat_label = 'DRIVER')`,
  );
  for (const { id } of rows) {
    const result = await withTransaction((client) => relayoutBus(client, id));
    if (result === "has-bookings")
      console.warn(
        `[Layout] Bus ${id} has bookings; run "npm run relayout -- --force" to update it.`,
      );
  }
}
