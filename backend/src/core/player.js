// src/core/player.js
const crypto = require("crypto");
const { dbq } = require("../db");

// --- schema hardening (safe to call multiple times) ---
async function ensureIdentityColumns() {
  await dbq("ALTER TABLE players ADD COLUMN IF NOT EXISTS token TEXT UNIQUE", []);
  await dbq(
    "ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()",
    []
  );
}

// --- small helpers ---
function normalizeToken(t) {
  if (!t) return null;
  // Trim & clamp to a sane size to avoid pathological input
  t = String(t).trim();
  if (t.length > 128) t = t.slice(0, 128);
  return t;
}
async function bumpSeen(playerId) {
  await dbq("UPDATE players SET last_seen=NOW() WHERE id=$1", [playerId]);
}

// --- queries / helpers ---
async function loadBySocket(socketId) {
  const r = await dbq("SELECT * FROM players WHERE socket_id=$1", [socketId]);
  return r[0] || null;
}
async function findByToken(token) {
  const r = await dbq("SELECT * FROM players WHERE token=$1", [token]);
  return r[0] || null;
}

/**
 * Sticky identity: attach by token if present; otherwise create a new player
 * with a fresh token. Always sets socket_id and bumps last_seen.
 *
 * @param {Object} arg
 * @param {string} arg.socketId - current socket id
 * @param {string|null} arg.token - optional persisted token from client
 * @returns {Promise<object>} player row
 */
async function ensureByTokenOrCreate({ socketId, token }) {
  await ensureIdentityColumns();

  const safeToken = normalizeToken(token);

  // Reattach if we already know this token
  if (safeToken) {
    const existing = await findByToken(safeToken);
    if (existing) {
      await dbq(
        "UPDATE players SET socket_id=$1, last_seen=NOW() WHERE id=$2",
        [socketId, existing.id]
      );
      const r = await dbq("SELECT * FROM players WHERE id=$1", [existing.id]);
      return r[0];
    }
  }

  // Create a brand new player with a fresh token
  const newToken = safeToken || crypto.randomBytes(16).toString("hex");
  let username = "U-" + newToken.slice(-6);

  // Try a few variants if username collides
  let row = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      row = (
        await dbq(
          `INSERT INTO players
           (username, token, room, role, gold, food, meat, wood, stone, hunger, wanted, socket_id, last_seen)
           VALUES ($1,$2,'Capital','Peasant',0,0,0,0,0,100,false,$3,NOW())
           RETURNING *`,
          [username, newToken, socketId]
        )
      )[0];
      break;
    } catch (e) {
      if (e && e.code === "23505") {
        // Unique constraint (probably username). Tweak & retry.
        username = "U-" + newToken.slice(-(6 + attempt)) + Math.floor(Math.random() * 10);
        continue;
      }
      throw e;
    }
  }
  if (!row) throw new Error("Failed to create player");
  return row;
}

/**
 * DEPRECATED: was upserting by username (caused identity collisions).
 * Kept for backward compatibility, but now creates a fresh player with its own token.
 */
async function ensureForSocket(socketId, usernameHint) {
  await ensureIdentityColumns();
  const token = crypto.randomBytes(16).toString("hex");
  const username = (usernameHint && String(usernameHint).slice(0, 20)) || "U-" + token.slice(-6);
  const r = await dbq(
    `INSERT INTO players
     (username, token, room, role, gold, food, meat, wood, stone, hunger, wanted, socket_id, last_seen)
     VALUES ($1,$2,'Capital','Peasant',0,0,0,0,0,100,false,$3,NOW())
     RETURNING *`,
    [username, token, socketId]
  );
  return r[0];
}

async function respawnAsPeasant(playerId) {
  await dbq("DELETE FROM homes WHERE player_id=$1", [playerId]);
  await dbq(
    `UPDATE players
        SET food=0,
            meat=0,
            wood=0,
            stone=0,
            gold=0,
            hunger=100,
            role='Peasant',
            room='Capital',
            home_room=NULL,
            home_x=NULL,
            home_y=NULL
      WHERE id=$1`,
    [playerId]
  );
}

module.exports = {
  loadBySocket,
  findByToken,
  ensureByTokenOrCreate,
  ensureForSocket, // legacy
  respawnAsPeasant,
  bumpSeen,        // NEW: optional convenience
  ensureIdentityColumns, // export if migrations run from elsewhere
};
