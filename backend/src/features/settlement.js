// src/features/settlement.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

const NOMAD_CAP = 10;

// --------------------------------------------
// Home storage capacity by tier
// --------------------------------------------
function homeCapacity(tier) {
  switch ((tier || "shack").toLowerCase()) {
    case "manor": return 240;
    case "house": return 120;
    case "hut":   return 60;
    default:      return 20;
  }
}

// --------------------------------------------
// Population cap + living quality scaling
// --------------------------------------------
function popCapForLQ(lq, isCapital = false) {
  if (isCapital) return 200;
  const base = 20;
  const mult = Math.max(1, 1 + lq / 10);
  return Math.floor(base * mult);
}

async function applyDynamicCap(roomId, lq, isCapital) {
  const cap = popCapForLQ(lq, isCapital);
  await dbq("UPDATE rooms SET resident_cap=$1 WHERE id=$2", [cap, roomId]);
  return cap;
}

// --------------------------------------------
// Recalculate town stats (for civic upgrades)
// --------------------------------------------
async function recalcTownStats(roomId) {
  const r = await dbq("SELECT living_quality, name FROM rooms WHERE id=$1", [roomId]);
  if (!r.length) return;
  const room = r[0];

  const civics = await dbq("SELECT COUNT(*)::int AS n FROM room_buildings WHERE room_id=$1", [roomId]);
  const bonus = Math.floor((civics[0]?.n || 0) / 3);
  const newLQ = Math.min(100, (room.living_quality || 0) + bonus);

  const isCapital = room.name.toLowerCase() === "capital";
  const newCap = await applyDynamicCap(roomId, newLQ, isCapital);

  await dbq("UPDATE rooms SET living_quality=$1 WHERE id=$2", [newLQ, roomId]);
  console.log(`[LQ] ${room.name} recalculated: LQ=${newLQ}, cap=${newCap}`);
  return { lq: newLQ, cap: newCap };
}

// --------------------------------------------
// Ensure DB has capacity column
// --------------------------------------------
async function ensureRoomCapColumn() {
  await dbq("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS resident_cap INT DEFAULT 20", []);
}

// --------------------------------------------
// Home + Slot Helpers
// --------------------------------------------
async function getHome(playerId) {
  const r = await dbq(`
    SELECT h.*, r.name AS room_name
    FROM homes h
    LEFT JOIN rooms r ON r.id = h.room_id
    WHERE h.player_id=$1
    LIMIT 1
  `, [playerId]);
  return r[0] || null;
}

async function nextFreeHomeSlot(roomId) {
  const taken = await dbq("SELECT x,y FROM homes WHERE room_id=$1", [roomId]);
  const used = new Set(taken.map(t => `${t.x},${t.y}`));
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const k = `${x},${y}`;
      if (!used.has(k)) return { x, y };
    }
  }
  // fallback if map full
  return { x: Math.floor(Math.random() * 1000), y: Math.floor(Math.random() * 1000) };
}

// --------------------------------------------
// MAIN FEATURE INIT
// --------------------------------------------
function initSettlementFeature(registry) {
  ensureRoomCapColumn().catch(() => {});
  registry.getHome = getHome;
  registry.homeCapacity = homeCapacity;
  registry.recalcTownStats = recalcTownStats;

  // --- Capacity enforcement ---
  registry.enforceCapacity = async (socket, player) => {
    const home = await getHome(player.id);
    const cap = home ? homeCapacity(home.tier) : NOMAD_CAP;
    if (player.food > cap) {
      const overflow = player.food - cap;
      player.food = cap;
      await dbq("UPDATE players SET food=$1 WHERE id=$2", [player.food, player.id]);
      if (socket) registry.you(socket, `Storage overflow: ${overflow} fruit spoiled (cap ${cap}).`);
    }
  };

  // --------------------------------------------
  // /settle — Establish your home
  // --------------------------------------------
  register("/settle", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    if (!me) return ctx.you(socket, "No player record found.");

    // Look up current room (case-insensitive)
    const roomRes = await dbq(
      "SELECT id, name, world_x, world_y, living_quality, resident_cap FROM rooms WHERE LOWER(name)=LOWER($1) LIMIT 1",
      [me.room]
    );
    if (!roomRes.length) {
      return ctx.you(socket, "Error: current room not found. Use /travel Town first.");
    }
    const room = roomRes[0];
    const isCapital = room.name.toLowerCase() === "capital";

    // Must be a town or the capital
    const townCheck = await dbq(
      "SELECT 1 FROM towns WHERE LOWER(name)=LOWER($1) OR is_capital=TRUE LIMIT 1",
      [room.name]
    );
    if (!townCheck.length && !isCapital) {
      return ctx.you(socket, "You can only settle inside a town or the Capital. Use /travel Town first.");
    }

    // Update resident cap dynamically
    const lq = room.living_quality ?? 0;
    const popCap = await applyDynamicCap(room.id, lq, isCapital);

    const existingHomes = await dbq("SELECT COUNT(*)::int AS n FROM homes WHERE room_id=$1", [room.id]);
    const currentPop = existingHomes[0]?.n || 0;
    if (currentPop >= popCap) {
      return ctx.you(socket, `No space in ${room.name} (cap ${popCap}).`);
    }

    // Remove previous home if any
    await dbq("DELETE FROM homes WHERE player_id=$1", [me.id]);

    // Assign new home slot
    const slot = await nextFreeHomeSlot(room.id);
    await dbq(`
      INSERT INTO homes (player_id, room_id, x, y, tier, world_x, world_y)
      VALUES ($1, $2, $3, $4, 'shack', $5, $6)
    `, [me.id, room.id, slot.x, slot.y, room.world_x, room.world_y]);

    // Update player
    await dbq(
      "UPDATE players SET home_room=$1, home_x=$2, home_y=$3 WHERE id=$4",
      [room.name, room.world_x, room.world_y, me.id]
    );

    ctx.sys(room.name, `${me.username} settled in ${room.name}.`);
    ctx.you(socket, `🏠 Home established in ${room.name}. You can now /uphome hut|house|manor.`);

    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sendState(socket, me2);
  }, "— settle in your current town (creates a home if within valid limits)");

  // --------------------------------------------
  // /where — Display player home + room
  // --------------------------------------------
  register("/where", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const home = await getHome(me.id);
    if (!home) {
      return ctx.you(socket, `Room: ${me.room}. No home yet. Use /settle`);
    }
    const wx = home.world_x ?? 0;
    const wy = home.world_y ?? 0;
    const rName = home.room_name || me.room;
    ctx.you(socket, `Home: ${rName} · tier=${home.tier} (coords ${wx},${wy})`);
  }, "— show your home and world coordinates");

  // --------------------------------------------
  // /uphome — Upgrade your home tier
  // --------------------------------------------
  register("/uphome", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const home = await getHome(me.id);
    if (!home) return ctx.you(socket, "You need a home first. Use /settle");

    const order = ["shack", "hut", "house", "manor"];
    const cur = (home.tier || "shack").toLowerCase();
    const want = (parts[1] || "").toLowerCase();

    if (!["hut", "house", "manor"].includes(want))
      return ctx.you(socket, "Usage: /uphome hut|house|manor");

    const next = order[Math.min(order.indexOf(cur) + 1, order.length - 1)];
    if (want !== next)
      return ctx.you(socket, `You must upgrade step-by-step. Next is ${next}.`);

    await dbq("UPDATE homes SET tier=$1 WHERE player_id=$2", [want, me.id]);
    const cap = homeCapacity(want);

    ctx.sys(me.room, `${me.username} upgraded home to ${want} (storage cap ${cap}).`);
    ctx.you(socket, `Home upgraded to ${want}. You can now store up to ${cap} resources.`);
  }, "hut|house|manor — upgrade your home step by step");
}

module.exports = {
  initSettlementFeature,
  getHome,
  homeCapacity,
  popCapForLQ,
  recalcTownStats
};
