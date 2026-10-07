// Seats on the right of the walkway for each plan; the left side always has two.
export const LAYOUTS = { "2+3": 3, "2+2": 2 };
export const DEFAULT_LAYOUT = "2+3";
// Bump when buildLayout changes so unbooked buses are rebuilt at startup.
export const LAYOUT_VERSION = 4;

/**
 * Cameroon coach plan, front to back (driver on the left):
 *   row 1     driver | open cab space | front passenger seat (right window)
 *   row 2     2 seats | aisle | front door
 *   rows      2 seats | aisle | 2 or 3 seats
 *   door row  2 seats | aisle | rear door
 *   last row  a normal row when the seats fit exactly, otherwise the leftovers centred without an aisle
 * Non-seat cells (driver, doors, aisles) are stored as non-bookable rows.
 */
export function buildLayout(capacity, type = DEFAULT_LAYOUT) {
  const right = LAYOUTS[type] ?? LAYOUTS[DEFAULT_LAYOUT];
  const cols = 3 + right;
  const rowSize = 2 + right;
  const cells = [];
  let seatNumber = 0;

  const seat = (row, col, isWindow) => {
    seatNumber += 1;
    cells.push({ label: `S${seatNumber}`, row, col, isAisle: false, isWindow });
  };
  const marker = (label, row, col) =>
    cells.push({ label, row, col, isAisle: true, isWindow: false });
  const leftPair = (row) => {
    seat(row, 1, true);
    seat(row, 2, false);
    marker("AISLE", row, 3);
  };
  const normalRow = (row) => {
    leftPair(row);
    for (let col = 4; col <= cols; col += 1) seat(row, col, col === cols);
  };
  const doorRow = (row) => {
    leftPair(row);
    for (let col = 4; col <= cols; col += 1) marker("DOOR", row, col);
  };

  let row = 1;
  marker("DRIVER", row, 1);
  for (let col = 2; col < cols; col += 1) marker("AISLE", row, col);
  seat(row, cols, true);

  let rest = Math.max(capacity - 1, 0);

  if (rest >= 2) {
    row += 1;
    doorRow(row);
    rest -= 2;
  }
  const hasRearDoor = rest >= 3;
  if (hasRearDoor) rest -= 2;

  let fullRows = Math.floor(rest / rowSize);
  let lastCount = rest % rowSize;
  if (lastCount === 0 && fullRows > 0) {
    fullRows -= 1;
    lastCount = rowSize;
  }

  for (let i = 0; i < fullRows; i += 1) {
    row += 1;
    normalRow(row);
  }

  if (hasRearDoor) {
    row += 1;
    doorRow(row);
  }

  if (lastCount === rowSize) {
    row += 1;
    normalRow(row);
  } else if (lastCount > 0) {
    row += 1;
    for (let col = 1; col <= lastCount; col += 1) seat(row, col, false);
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

  const bus = await client.query(
    `SELECT seat_layout FROM buses WHERE id = $1`,
    [busId],
  );
  const cells = buildLayout(seats.length, bus.rows[0]?.seat_layout);
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
  await client.query(`UPDATE buses SET layout_version = $2 WHERE id = $1`, [
    busId,
    LAYOUT_VERSION,
  ]);
  return "updated";
}

/** Applies the current plan to buses on an older layout version that have no bookings. */
export async function upgradeBusLayouts(db, withTransaction) {
  const { rows } = await db.query(
    `SELECT b.id FROM buses b WHERE b.layout_version < $1`,
    [LAYOUT_VERSION],
  );
  for (const { id } of rows) {
    const result = await withTransaction((client) => relayoutBus(client, id));
    if (result === "has-bookings")
      console.warn(
        `[Layout] Bus ${id} has bookings; run "npm run relayout -- --force" to update it.`,
      );
  }
}
