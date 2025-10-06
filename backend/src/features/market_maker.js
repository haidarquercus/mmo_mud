// src/features/market_maker.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

// canonical resources
const SELLABLE = new Set(["wood", "stone", "food", "meat"]);
const INPUT_ALIAS = { fruit: "food" };
const DISPLAY_NAME = { food: "fruit", wood: "wood", stone: "stone", meat: "meat" };

// --- game day (10 minutes) ---
const DAY_MS = 10 * 60 * 1000; // 10-minute game day
function dayId() { return Math.floor(Date.now() / DAY_MS); }
function dayEndsInMs() { return (dayId() + 1) * DAY_MS - Date.now(); }

function fmtTimeLeft(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  const s = Math.max(0, Math.floor((ms % 60000) / 1000));
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

// --- helpers ---
async function roomPopCount(roomName) {
  const r = await dbq(
    "SELECT COUNT(*)::int AS n FROM players WHERE room=$1 AND socket_id IS NOT NULL",
    [roomName]
  );
  return r[0]?.n || 0;
}

async function roomRowByName(name) {
  const r = await dbq("SELECT * FROM rooms WHERE name=$1", [name]);
  return r[0] || null;
}

function normalizeRes(input) {
  if (!input) return null;
  const raw = input.toLowerCase();
  const canon = INPUT_ALIAS[raw] || raw;
  return SELLABLE.has(canon) ? canon : null;
}
function displayRes(canon) { return DISPLAY_NAME[canon] || canon; }

/**
 * LOWERED threshold:
 *   base = 60 + 5 * pop
 *   Capital gets a small bump (+40) so it's a bit harder there,
 *   then clamped to [30 .. 200]
 */
function thresholdFor(roomName, pop) {
  let base = 50 + (pop * 5);
  if ((roomName || "").toLowerCase() === "capital") base += 50;
  return base;
}

function initMarketMakerFeature(registry) {
  async function handler(ctx, socket, parts) {
    const me = await ctx.getPlayer(socket, true);
    const arg = (parts[1] || "").toLowerCase();

    // /market status
    if (arg === "status") {
      const room = await roomRowByName(me.room);
      if (!room) return ctx.you(socket, "Room not found.");

      const rows = await dbq(
        `SELECT mm.resource, p.username, mm.percent
           FROM market_makers mm
           JOIN players p ON p.id = mm.player_id
          WHERE mm.room_id=$1 AND mm.day_id=$2
          ORDER BY mm.resource`,
        [room.id, dayId()]
      );
      if (!rows.length) {
        ctx.you(socket, `No market makers today. Time left in day: ${fmtTimeLeft(dayEndsInMs())}`);
        return;
      }
      ctx.you(socket, `Time left in day: ${fmtTimeLeft(dayEndsInMs())}`);
      rows.forEach(x => ctx.you(socket, `${displayRes(x.resource)}: ${x.username} (${x.percent}%)`));
      return;
    }

    // /market wood|stone|fruit|meat
    const canon = normalizeRes(arg);
    if (!canon) return ctx.you(socket, "Usage: /market wood|stone|fruit|meat  OR  /market status");

    const pop = await roomPopCount(me.room);
    const need = thresholdFor(me.room, pop);
    const have = Number(me[canon] || 0);
    if (have < need) {
      return ctx.you(
        socket,
        `Need ${need} ${displayRes(canon)} to go to market here (pop ${pop}). You have ${have}.`
      );
    }

    const room = await roomRowByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");
    const today = dayId();

    const taken = await dbq(
      "SELECT 1 FROM market_makers WHERE room_id=$1 AND resource=$2 AND day_id=$3",
      [room.id, canon, today]
    );
    if (taken.length) {
      return ctx.you(socket, `There is already a market maker for ${displayRes(canon)} today.`);
    }

    // stake EXACTLY the minimum required (not your entire inventory)
    const next = { ...me, [canon]: (me[canon] || 0) - need };
    await dbq(
      "UPDATE players SET gold=$1, wood=$2, stone=$3, food=$4, meat=$5 WHERE id=$6",
      [next.gold||0, next.wood||0, next.stone||0, next.food||0, next.meat||0, me.id]
    );

    // register maker (10% cut of GROSS trades, see market.js)
    await dbq(
      "INSERT INTO market_makers (room_id, player_id, resource, day_id, percent) VALUES ($1,$2,$3,$4,10)",
      [room.id, me.id, canon, today]
    );

    ctx.sys(
      me.room,
      `${me.username} has opened the ${displayRes(canon)} market for today (staked ${need}). ` +
      `They earn 10% of all ${displayRes(canon)} trades here.`
    );
    ctx.sendState(socket, next);
  }

  // Register both /market and /gomarket as aliases
  register("/market", handler, "wood|stone|fruit|meat — become today's market maker (or /market status)");
  register("/gomarket", handler, "alias of /market");

  // expose helper(s)
  registry.marketDayId = dayId;
}

module.exports = { initMarketMakerFeature, dayId };
