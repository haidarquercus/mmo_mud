// src/features/status.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

// -- helpers --
async function addEffect(playerId, effect, magnitude, seconds) {
  const expires = new Date(Date.now() + seconds * 1000);
  await dbq(
    "INSERT INTO player_effects (player_id, effect, magnitude, expires_at) VALUES ($1,$2,$3,$4)",
    [playerId, effect, magnitude, expires]
  );
}

async function clearExpired() {
  await dbq("DELETE FROM player_effects WHERE expires_at < NOW()", []);
}

async function getEffects(playerId) {
  await clearExpired();
  return await dbq(
    "SELECT effect, magnitude, expires_at FROM player_effects WHERE player_id=$1 ORDER BY expires_at",
    [playerId]
  );
}

function rollModFromEffects(effects) {
  let mod = 0;
  for (const e of effects) {
    if (e.effect === "WellFed") mod += 10 * e.magnitude;
    if (e.effect === "Exhausted") mod -= 10 * e.magnitude;
    if (e.effect === "Wounded") mod -= 5 * e.magnitude;
  }
  return mod;
}

function fmtRemaining(expiresAt) {
  const end = new Date(expiresAt).getTime();
  const ms = Math.max(0, end - Date.now());
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// A compact one-line summary (for /stats or HUD)
async function effectsSummary(playerId) {
  const eff = await getEffects(playerId);
  if (!eff.length) return "None";
  return eff
    .map(e => `${e.effect} x${e.magnitude} (${fmtRemaining(e.expires_at)})`)
    .join(", ");
}

function initStatusFeature({ register }) {
  register("/status", async (ctx, socket) => {
    const p = await ctx.getPlayer(socket);
    const eff = await getEffects(p.id);
    if (!eff.length) return ctx.you(socket, "No active effects.");
    eff.forEach(e =>
      ctx.you(socket, `${e.effect} x${e.magnitude} — ${fmtRemaining(e.expires_at)} left`)
    );
  }, " — show your active effects");
}

module.exports = {
  initStatusFeature,
  addEffect,
  getEffects,
  rollModFromEffects,
  effectsSummary,
};
