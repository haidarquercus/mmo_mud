// src/features/inventory.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

const TOOL = {
  bow:      { name: "Wooden Bow", baseDur: 10, craftCost: { wood: 20, gold: 5 } }, // 10 uses
  pickaxe:  { name: "Stone Pickaxe", baseDur: 30, craftCost: { wood: 10, stone: 10, gold: 5 } },
};

// Give a specific tool instance with durability
async function giveTool(playerId, key, durability) {
  const base = TOOL[key]; if (!base) throw new Error("bad tool");
  const dur = durability ?? base.baseDur;
  await dbq(
    "INSERT INTO player_tools (player_id, tool_key, durability) VALUES ($1,$2,$3)",
    [playerId, key, dur]
  );
}

async function countTool(playerId, key) {
  const r = await dbq(
    "SELECT COUNT(*)::int AS n FROM player_tools WHERE player_id=$1 AND tool_key=$2",
    [playerId, key]
  );
  return r[0]?.n || 0;
}

// Top/equipped tool (the one we’ll consume first)
async function topTool(playerId, key) {
  const r = await dbq(
    "SELECT id, durability FROM player_tools WHERE player_id=$1 AND tool_key=$2 ORDER BY id LIMIT 1",
    [playerId, key]
  );
  return r[0] || null;
}

async function useTool(playerId, key) {
  const row = await topTool(playerId, key);
  if (!row) return { ok:false, broken:false };
  if (row.durability <= 1) {
    await dbq("DELETE FROM player_tools WHERE id=$1", [row.id]);
    return { ok:true, broken:true };
  } else {
    await dbq("UPDATE player_tools SET durability=durability-1 WHERE id=$1", [row.id]);
    return { ok:true, broken:false };
  }
}

function fmtInvLine(key, n, usesLeft) {
  const icon = key === "bow" ? "🏹" : "⛏️";
  const base = `${icon} ${TOOL[key].name}: ${n}`;
  if (key === "bow" && n > 0 && typeof usesLeft === "number") {
    return `${base} (uses ${usesLeft})`;
  }
  return base;
}

function canAfford(p, cost) {
  for (const k of Object.keys(cost)) if ((p[k]||0) < cost[k]) return false;
  return true;
}
async function payCost(p, cost) {
  const next = { ...p };
  for (const k of Object.keys(cost)) next[k] = (next[k]||0) - cost[k];
  // Keep columns aligned with your current schema
  await dbq(
    "UPDATE players SET gold=$1, wood=$2, stone=$3, food=$4, meat=$5 WHERE id=$6",
    [next.gold||0, next.wood||0, next.stone||0, next.food||0, next.meat||0, p.id]
  );
  return next;
}

function initInventoryFeature(_registry) {
  // /inventory
  register("/inventory", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const bows  = await countTool(me.id, "bow");
    const picks = await countTool(me.id, "pickaxe");
    const topBow = await topTool(me.id, "bow");
    ctx.you(socket, fmtInvLine("bow", bows, topBow?.durability ?? undefined));
    ctx.you(socket, fmtInvLine("pickaxe", picks));
  }, " — show tools & counts");

  // /craft bow | pickaxe
  register("/craft", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const key = (parts[1]||"").toLowerCase();
    if (!(key in TOOL)) return ctx.you(socket, "Usage: /craft bow | /craft pickaxe");

    const cost = TOOL[key].craftCost;
    if (!canAfford(me, cost)) return ctx.you(socket, "Not enough resources to craft.");
    const after = await payCost(me, cost);
    await giveTool(me.id, key);
    ctx.you(socket, `Crafted ${TOOL[key].name}.`);
    ctx.sendState(socket, after);
  }, "bow|pickaxe — craft a tool");
}

module.exports = { initInventoryFeature, giveTool, useTool, countTool, TOOL };
