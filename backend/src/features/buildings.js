// src/features/buildings.js
const { dbq } = require("../db");

// ---------- helpers: ownership & rooms ----------
async function isLordOrKing(playerId, roomName) {
  const r = await dbq(
    "SELECT (owner_player_id = $1) AS lord FROM rooms WHERE name=$2",
    [playerId, roomName]
  );
  if (r[0]?.lord) return true;
  const k = await dbq("SELECT 1 FROM players WHERE id=$1 AND role='King'", [playerId]);
  return !!k.length;
}

async function roomRowByName(name) {
  const r = await dbq("SELECT * FROM rooms WHERE name=$1", [name]);
  return r[0] || null;
}

function toObj(effects) {
  if (!effects) return {};
  if (typeof effects === "object") return effects;
  try { return JSON.parse(effects); } catch { return {}; }
}

// ---------- schema (idempotent) ----------
async function ensureSchema() {
  await dbq("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS tax_free_up_to INT", []);
  await dbq("ALTER TABLE rooms ADD COLUMN IF NOT EXISTS lq_bonus INT DEFAULT 0", []);

  await dbq(`
    CREATE TABLE IF NOT EXISTS building_types (
      key     TEXT PRIMARY KEY,
      name    TEXT NOT NULL,
      cost    INT  NOT NULL,
      upkeep  INT  DEFAULT 0,
      effects JSONB DEFAULT '{}'::jsonb
    )`, []);

  await dbq(`
    CREATE TABLE IF NOT EXISTS room_buildings (
      room_id  INT  NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      bkey     TEXT NOT NULL REFERENCES building_types(key) ON DELETE CASCADE,
      level    INT  NOT NULL DEFAULT 1,
      built_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room_id, bkey)
    )`, []);
}

// ---------- catalog & room state ----------
async function catalog() {
  await ensureSchema();
  const rows = await dbq("SELECT key, name, cost, upkeep, effects FROM building_types ORDER BY name", []);
  return rows.map(r => ({ ...r, effects: toObj(r.effects) }));
}

async function roomBuildings(roomId) {
  await ensureSchema();
  const rows = await dbq(
    `SELECT rb.bkey, bt.name, rb.level, bt.effects, bt.cost, bt.upkeep, rb.built_at
       FROM room_buildings rb
       JOIN building_types bt ON bt.key = rb.bkey
      WHERE rb.room_id=$1
      ORDER BY bt.name`,
    [roomId]
  );
  return rows.map(r => ({ ...r, effects: toObj(r.effects) }));
}

function mergeEffects(rows) {
  const buffs = {
    storage_bonus: 0,
    tool_discount: 0,
    tax_free_up_to: null,
    lq_bonus: 0,
    hunger_decay_mult: 1.0,
    guard_bonus: 0
  };

  for (const r of rows) {
    const e = toObj(r.effects);
    if (Number.isFinite(e.storage_bonus))    buffs.storage_bonus += e.storage_bonus;
    if (Number.isFinite(e.tool_discount))    buffs.tool_discount += e.tool_discount;
    if (Number.isFinite(e.lq_bonus))         buffs.lq_bonus      += e.lq_bonus;
    if (Number.isFinite(e.guard_bonus))      buffs.guard_bonus   += e.guard_bonus;
    if (Number.isFinite(e.hunger_decay_mult))buffs.hunger_decay_mult *= e.hunger_decay_mult;
    if (Number.isFinite(e.tax_free_up_to)) {
      const cur = buffs.tax_free_up_to ?? 0;
      buffs.tax_free_up_to = Math.max(cur, e.tax_free_up_to);
    }
  }
  buffs.tool_discount     = Math.min(Math.max(buffs.tool_discount, 0), 0.5);
  buffs.hunger_decay_mult = Math.min(Math.max(buffs.hunger_decay_mult, 0.5), 1.0);
  return buffs;
}

async function getRoomBuffsByName(roomName) {
  const room = await roomRowByName(roomName);
  if (!room) return mergeEffects([]);

  const rows  = await roomBuildings(room.id);
  const buffs = mergeEffects(rows);

  if (Number.isFinite(room.tax_free_up_to)) {
    const cur = buffs.tax_free_up_to ?? 0;
    buffs.tax_free_up_to = Math.max(cur, room.tax_free_up_to);
  }
  buffs.lq_bonus = (buffs.lq_bonus || 0) + (room.lq_bonus || 0);

  return buffs;
}

function effectSummary(buffs) {
  const parts = [];
  if (buffs.storage_bonus)       parts.push(`+${buffs.storage_bonus} storage cap`);
  if (buffs.tool_discount)       parts.push(`${Math.round(buffs.tool_discount * 100)}% cheaper tools`);
  if (Number.isFinite(buffs.tax_free_up_to)) parts.push(`tax-free ≤ ${buffs.tax_free_up_to}g`);
  if (buffs.lq_bonus)            parts.push(`LQ +${buffs.lq_bonus}`);
  if (buffs.hunger_decay_mult && buffs.hunger_decay_mult < 1) {
    parts.push(`-${Math.round((1 - buffs.hunger_decay_mult) * 100)}% hunger drain`);
  }
  return parts.length ? parts.join(", ") : "no passive effects";
}

// ---------- feature init ----------
function initBuildingsFeature(registry) {
  const register = registry && registry.register;
  if (typeof register !== "function") {
    throw new Error("initBuildingsFeature requires registry with { register }");
  }

  // /civic list | status | build <key> | demolish <key>
  register("/civic", async (ctx, socket, parts) => {
    await ensureSchema();

    const me   = await ctx.getPlayer(socket, true);
    const room = await roomRowByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");

    const sub = (parts[1] || "").toLowerCase();

    // list
    if (!sub || sub === "list") {
      const rows = await catalog();
      if (!rows.length) {
        ctx.you(socket, "No civic buildings available yet. (Admin can seed building_types.)");
        return;
      }
      ctx.you(socket, "Available civic buildings:");
      for (const r of rows) {
        const effText = effectSummary(mergeEffects([{ effects: r.effects }]));
        ctx.you(socket, `• ${r.name} (${r.key}) — cost ${r.cost}g — ${effText}`);
      }
      ctx.you(socket, "Use: /civic build <key>  |  /civic status  |  /civic demolish <key>");
      return;
    }

    // status
    if (sub === "status") {
      const built = await roomBuildings(room.id);
      if (!built.length) {
        const buffs = await getRoomBuffsByName(room.name);
        ctx.you(socket, `No civic buildings yet. Current bonuses: ${effectSummary(buffs)}.`);
        return;
      }
      ctx.you(socket, `Civic buildings in ${room.name}:`);
      for (const b of built) {
        const effText = effectSummary(mergeEffects([{ effects: b.effects }]));
        ctx.you(socket, `• ${b.name} (${b.bkey}) — built ${new Date(b.built_at).toLocaleString()} — ${effText}`);
      }
      const buffs = await getRoomBuffsByName(room.name);
      ctx.you(socket, `Total bonuses: ${effectSummary(buffs)}.`);
      return;
    }

    // build
    if (sub === "build") {
      const key = (parts[2] || "").toLowerCase();
      if (!key) return ctx.you(socket, "Usage: /civic build <key>");
      if (!(await isLordOrKing(me.id, room.name))) {
        return ctx.you(socket, "Only the King or this room's Lord may build.");
      }

      const bt = (await dbq("SELECT * FROM building_types WHERE key=$1", [key]))[0];
      if (!bt) return ctx.you(socket, "Unknown building key. Use /civic list.");

      const already = await dbq(
        "SELECT 1 FROM room_buildings WHERE room_id=$1 AND bkey=$2",
        [room.id, key]
      );
      if (already.length) return ctx.you(socket, "That building already exists here.");

      if ((room.treasury_gold || 0) < bt.cost) {
        return ctx.you(socket, `Treasury needs ${bt.cost}g. Current: ${room.treasury_gold || 0}g.`);
      }

      // pay & create
      await dbq("UPDATE rooms SET treasury_gold=treasury_gold-$1 WHERE id=$2", [bt.cost, room.id]);
      await dbq("INSERT INTO room_buildings (room_id, bkey) VALUES ($1,$2)", [room.id, key]);

      const eff = toObj(bt.effects);
      if (Number.isFinite(eff.tax_free_up_to)) {
        await dbq("UPDATE rooms SET tax_free_up_to=GREATEST(COALESCE(tax_free_up_to,0),$1) WHERE id=$2",
          [eff.tax_free_up_to, room.id]);
      }
      if (Number.isFinite(eff.lq_bonus)) {
        await dbq("UPDATE rooms SET lq_bonus=COALESCE(lq_bonus,0)+$1 WHERE id=$2",
          [eff.lq_bonus, room.id]);
      }

      // trigger recalculation in settlement system
      if (registry.recalcTownStats) {
        const updated = await registry.recalcTownStats(room.id);
        if (updated) {
          console.log(`[TOWN] Updated ${room.name} → LQ ${updated.lq}, cap ${updated.cap}`);
        }
      }

      const buffs = await getRoomBuffsByName(room.name);
      ctx.sys(room.name, `🏛️ ${me.username} built ${bt.name}. Bonuses now: ${effectSummary(buffs)}.`);
      return;
    }

    // demolish
    if (sub === "demolish") {
      const key = (parts[2] || "").toLowerCase();
      if (!key) return ctx.you(socket, "Usage: /civic demolish <key>");
      if (!(await isLordOrKing(me.id, room.name))) {
        return ctx.you(socket, "Only the King or this room's Lord may demolish.");
      }

      const bt = (await dbq("SELECT * FROM building_types WHERE key=$1", [key]))[0];
      if (!bt) return ctx.you(socket, "Unknown building key.");

      const exists = await dbq(
        "SELECT 1 FROM room_buildings WHERE room_id=$1 AND bkey=$2",
        [room.id, key]
      );
      if (!exists.length) return ctx.you(socket, "That building isn't present.");

      const refund = Math.floor((bt.cost || 0) * 0.5);
      await dbq("DELETE FROM room_buildings WHERE room_id=$1 AND bkey=$2", [room.id, key]);
      if (refund > 0) {
        await dbq("UPDATE rooms SET treasury_gold=COALESCE(treasury_gold,0)+$1 WHERE id=$2", [refund, room.id]);
      }

      // recalc after demolition
      if (registry.recalcTownStats) {
        const updated = await registry.recalcTownStats(room.id);
        if (updated) {
          console.log(`[TOWN] Updated ${room.name} → LQ ${updated.lq}, cap ${updated.cap}`);
        }
      }

      const buffs = await getRoomBuffsByName(room.name);
      ctx.sys(room.name, `🏗️ ${bt.name} demolished. Treasury refunded ${refund}g. Bonuses now: ${effectSummary(buffs)}.`);
      return;
    }

    ctx.you(socket, "Usage: /civic list | /civic status | /civic build <key> | /civic demolish <key>");
  }, "Manage civic buildings: list, status, build, demolish");
}

module.exports = {
  initBuildingsFeature,
  getRoomBuffsByName,
};
