import crypto from "crypto";
import db from "../database/pg.js";
import { env } from "../config/env.js";

/**
 * Tickets carry an Ed25519 signature so a scanner can prove a QR code is genuine without any network.
 * The private key never leaves the server; scanners only ever receive the public keys.
 */

const MESSAGE_VERSION = "v1";
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

let keyPromise = null;

function describeKey(row) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(row.private_key, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return { keyId: row.key_id, privateKey };
}

async function loadActiveKey() {
  const select = () =>
    db.query(
      `SELECT key_id, private_key FROM signing_keys
        WHERE retired_at IS NULL ORDER BY created_at DESC, key_id LIMIT 1`,
    );

  let { rows } = await select();
  if (!rows[0]) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const rawPublic = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const keyId = crypto.createHash("sha256").update(rawPublic).digest("hex").slice(0, 8);
    await db.query(
      `INSERT INTO signing_keys (key_id, public_key, private_key) VALUES ($1, $2, $3)
       ON CONFLICT (key_id) DO NOTHING`,
      [
        keyId,
        b64url(rawPublic),
        privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      ],
    );
    ({ rows } = await select());
  }
  return describeKey(rows[0]);
}

function activeKey() {
  if (!keyPromise) {
    keyPromise = loadActiveKey().catch((err) => {
      keyPromise = null;
      throw err;
    });
  }
  return keyPromise;
}

export const signedMessage = ({ hash, ref, tripId }) =>
  [MESSAGE_VERSION, hash, ref, tripId].join("|");

/** The address encoded in a ticket's QR code: the public verification page plus the signed proof. */
export async function signedTicketUrl({ hash, ref, tripId }) {
  const { keyId, privateKey } = await activeKey();
  const signature = crypto.sign(
    null,
    Buffer.from(signedMessage({ hash, ref, tripId })),
    privateKey,
  );
  const query = new URLSearchParams({
    r: String(ref),
    t: String(tripId),
    k: keyId,
    s: b64url(signature),
  });
  return `${env.frontendUrl}/verify/${hash}?${query}`;
}

/** Same as signedTicketUrl but never throws: a ticket must still render if signing is unavailable. */
export async function qrValueFor({ hash, ref, tripId }) {
  try {
    return await signedTicketUrl({ hash, ref, tripId });
  } catch (err) {
    console.error("[Signing] Could not sign ticket:", err.message);
    return `${env.frontendUrl}/verify/${hash}`;
  }
}

/** Public keys every scanner needs, including retired ones so older tickets keep verifying. */
export async function listPublicKeys() {
  await activeKey();
  const { rows } = await db.query(
    `SELECT key_id, public_key, retired_at FROM signing_keys ORDER BY created_at`,
  );
  return rows.map((row) => ({
    keyId: row.key_id,
    publicKey: row.public_key,
    retired: Boolean(row.retired_at),
  }));
}
