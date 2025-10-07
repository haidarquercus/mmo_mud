// src/features/inventory.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

const QUALS = ["Poor", "Normal", "Good", "Excellent"];
const SLOT = { weapon: "weapon", armor: "armor" };

async function equipItem(playerId, itemName) {
  const rows = await dbq(
    "SELECT * FROM equipment WHERE player_id=$1 AND name ILIKE $2 LIMIT 1",
    [playerId, itemName + "%"]
  );
  if (!rows.length) return null;
  const eq = rows[0];
  const col =
    eq.slot === "weapon" ? "equipped_weapon_id" : "equipped_armor_id";
  await dbq(`UPDATE players SET ${col}=$1 WHERE id=$2`, [eq.id, playerId]);
  return eq;
}

async function unequip(playerId, slot) {
  const col =
    slot === "weapon" ? "equipped_weapon_id" : "equipped_armor_id";
  await dbq(`UPDATE players SET ${col}=NULL WHERE id=$1`, [playerId]);
}

function costForQuality(q) {
  const base = QUALS.indexOf(q);
  return Math.max(10, (base + 1) * 10);
}

function initInventoryFeature(_registry) {
  // --- existing tool commands remain intact ---
  const { giveTool, useTool, countTool, TOOL } = require("./inventory_tools_fallback") || {};

  // /forge weapon|armor [quality]
  register("/forge", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const slot = (parts[1] || "").toLowerCase();
    const qual = (parts[2] || "Normal").replace(/^\w/, c => c.toUpperCase());
    if (!["weapon", "armor"].includes(slot))
      return ctx.you(socket, "Usage: /forge weapon|armor [quality]");
    if (!QUALS.includes(qual)) return ctx.you(socket, `Quality must be one of ${QUALS.join(", ")}`);

    const cost = costForQuality(qual);
    if ((me.gold || 0) < cost) return ctx.you(socket, `Need ${cost} gold to forge ${qual} ${slot}.`);

    const atk = slot === "weapon" ? 10 + QUALS.indexOf(qual) * 5 : 0;
    const def = slot === "armor" ? 10 + QUALS.indexOf(qual) * 5 : 0;
    await dbq("UPDATE players SET gold=gold-$1 WHERE id=$2", [cost, me.id]);
    await dbq(
      "INSERT INTO equipment (player_id, slot, name, quality, attack, defense) VALUES ($1,$2,$3,$4,$5,$6)",
      [me.id, slot, `${qual} ${slot === "weapon" ? "Sword" : "Armor"}`, qual, atk, def]
    );
    ctx.you(socket, `Forged ${qual} ${slot}. (-${cost} gold)`);
  }, "weapon|armor [quality] — forge gear");

  // /equip name
  register("/equip", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    const name = parts.slice(1).join(" ");
    if (!name) return ctx.you(socket, "Usage: /equip name");
    const eq = await equipItem(me.id, name);
    if (!eq) return ctx.you(socket, "You don't have that item.");
    ctx.you(socket, `Equipped ${eq.name} (${eq.quality}).`);
  }, "name — equip a forged item");

  // /unequip weapon|armor
  register("/unequip", async (ctx, socket, parts) => {
    const slot = (parts[1] || "").toLowerCase();
    if (!["weapon", "armor"].includes(slot))
      return ctx.you(socket, "Usage: /unequip weapon|armor");
    const me = await ctx.getPlayer(socket);
    await unequip(me.id, slot);
    ctx.you(socket, `Unequipped ${slot}.`);
  }, "weapon|armor — unequip gear");

  // /inventory (expanded)
  register("/inventory", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const eq = await dbq("SELECT slot, name, quality FROM equipment WHERE player_id=$1", [me.id]);
    if (!eq.length) return ctx.you(socket, "Inventory empty.");
    for (const e of eq) ctx.you(socket, `${e.slot.toUpperCase()}: ${e.name} (${e.quality})`);
  }, " — show your gear");
}

module.exports = { initInventoryFeature };
