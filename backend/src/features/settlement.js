// src/features/settlement.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

const NOMAD_CAP = 10;
const SETTLE_COST = 50;
const UPGRADE_COSTS = { hut: 100, house: 300, manor: 600 };

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
// Ensure DB columns exist
// --------------------------------------------
async function ensureRoomCapColumn() {
  await dbq("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS resident_cap INT DEFAULT 20", []);
  await dbq("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS world_x INT", []);
  await dbq("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS world_y INT", []);
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
  // /settle — Establish your home (costs gold)
  // --------------------------------------------
  register("/settle", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    if (!me) return ctx.you(socket, "No player record found.");

    const roomRes = await dbq(
      "SELECT id, name, COALESCE(world_x,-1) AS world_x, COALESCE(world_y,-1) AS world_y, living_quality, resident_cap FROM rooms WHERE LOWER(name)=LOWER($1) LIMIT 1",
      [me.room]
    );
    if (!roomRes.length) return ctx.you(socket, `Error: current room '${me.room}' not found.`);
    const room = roomRes[0];
    const isCapital = room.name.toLowerCase() === "capital";

    if (room.world_x < 0 || room.world_y < 0)
      return ctx.you(socket, "This settlement has no map coordinates yet. Use /found or /travel to a mapped town.");

    if ((me.gold || 0) < SETTLE_COST)
      return ctx.you(socket, `You need ${SETTLE_COST} gold to establish a home.`);

    const lq = room.living_quality ?? 0;
    const popCap = await applyDynamicCap(room.id, lq, isCapital);
    const existingHomes = await dbq("SELECT COUNT(*)::int AS n FROM homes WHERE room_id=$1", [room.id]);
    if ((existingHomes[0]?.n || 0) >= popCap)
      return ctx.you(socket, `No space in ${room.name} (cap ${popCap}).`);

    await dbq("UPDATE players SET gold=gold-$1 WHERE id=$2", [SETTLE_COST, me.id]);
    await dbq("DELETE FROM homes WHERE player_id=$1", [me.id]);

    const slot = await nextFreeHomeSlot(room.id);
    await dbq(`
      INSERT INTO homes (player_id, room_id, x, y, tier, world_x, world_y)
      VALUES ($1, $2, $3, $4, 'shack', $5, $6)
    `, [me.id, room.id, slot.x, slot.y, room.world_x, room.world_y]);

    await dbq("UPDATE players SET home_room=$1, home_x=$2, home_y=$3 WHERE id=$4",
      [room.name, room.world_x, room.world_y, me.id]);

    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sys(room.name, `${me.username} settled in ${room.name}.`);
    ctx.you(socket, `💰 Spent ${SETTLE_COST} gold. 🏠 Home established in ${room.name}. You can now /uphome hut|house|manor.`);
    ctx.sendState(socket, me2);
  }, "— settle in your current town (50g cost, creates your first home)");

  // --------------------------------------------
  // /where — Current physical location
  // --------------------------------------------
  register("/where", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const r = await dbq("SELECT name, world_x, world_y, terrain, living_quality FROM rooms WHERE LOWER(name)=LOWER($1)", [me.room]);
    if (!r.length) return ctx.you(socket, "You are in an unknown area.");
    const room = r[0];
    const type = room.name.toLowerCase() === "capital" ? "Capital" : "Town";
    ctx.you(socket, `📍 You are in ${type}: ${room.name} (${room.world_x},${room.world_y}) — ${room.terrain}, LQ ${room.living_quality}`);
  }, "— show your current map position");

  // --------------------------------------------
  // /home — Show player’s own home info
  // --------------------------------------------
  register("/home", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const home = await getHome(me.id);
    if (!home) return ctx.you(socket, "You have no home yet. Use /settle first.");
    ctx.you(socket, `Home: ${home.room_name} · tier=${home.tier} (coords ${home.world_x},${home.world_y})`);
  }, "— show your personal home coordinates");

  // --------------------------------------------
  // /settlements — List all named towns & coords
  // --------------------------------------------
  register("/settlements", async (ctx, socket) => {
    const rows = await dbq(`
      SELECT name, world_x, world_y, owner_player_id, resident_cap
      FROM rooms
      WHERE world_x IS NOT NULL AND world_y IS NOT NULL
      ORDER BY name ASC
    `);
    if (!rows.length) return ctx.you(socket, "No settlements found.");
    for (const r of rows) {
      const owner = r.owner_player_id
        ? (await dbq("SELECT username FROM players WHERE id=$1", [r.owner_player_id]))[0]?.username || "—"
        : "—";
      ctx.you(socket, `${r.name} (${r.world_x},${r.world_y}) · Owner: ${owner} · Cap: ${r.resident_cap}`);
    }
  }, "— list all known towns and their coordinates");

  // --------------------------------------------
  // /uphome — Upgrade home tier (costs gold)
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

    const cost = UPGRADE_COSTS[want] || 100;
    if ((me.gold || 0) < cost)
      return ctx.you(socket, `You need ${cost} gold to upgrade to ${want}.`);

    await dbq("UPDATE players SET gold=gold-$1 WHERE id=$2", [cost, me.id]);
    await dbq("UPDATE homes SET tier=$1 WHERE player_id=$2", [want, me.id]);

    const cap = homeCapacity(want);
    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sys(me.room, `${me.username} upgraded home to ${want} (cap ${cap}).`);
    ctx.you(socket, `💰 Spent ${cost} gold. Home upgraded to ${want} (storage cap ${cap}).`);
    ctx.sendState(socket, me2);
  }, "hut|house|manor — upgrade your home with gold (100g/300g/600g)");
}

module.exports = {
  initSettlementFeature,
  getHome,
  homeCapacity,
  popCapForLQ,
  recalcTownStats
};
