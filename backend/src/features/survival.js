// src/features/survival.js
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { addEffect, getEffects } = require("./status");

function initSurvivalFeature(registry) {
  // attach env LQ helper (safe)
  registry.envLQ = async (player) => {
    if (!player || !player.room) return 0;
    const r = await dbq("SELECT living_quality FROM rooms WHERE name=$1", [player.room]);
    let lq = r[0]?.living_quality || 0;
    if (registry.getHome) {
      const home = await registry.getHome(player.id).catch(() => null);
      if (home && home.room_name === player.room) lq = home.tile_lq ?? lq;
    }
    return lq;
  };

  // /gather fruit  (stored in players.food)
  register("/gather", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const what = (parts[1] || "").toLowerCase();
    if (what !== "fruit") return ctx.you(socket, "Usage: /gather fruit");

    const lq = await ctx.envLQ(me);
    let gain = 3, drain = 8; // berries/fruit are modest
    drain = Math.max(5, drain - Math.floor(lq / 5));

    me.food = (me.food || 0) + gain; // fruit == food column
    me.hunger = (me.hunger || 100) - drain;

    if (me.hunger <= 0) {
      await ctx.respawn(me.id);
      ctx.sys(me.room, `${me.username} starved and respawned as a Peasant.`);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      return ctx.sendState(socket, me2);
    }

    await dbq("UPDATE players SET food=$1, hunger=$2 WHERE id=$3", [me.food, me.hunger, me.id]);
    if (ctx.enforceCapacity) await ctx.enforceCapacity(socket, me); // only caps fruit (food)
    ctx.sys(me.room, `${me.username} gathered fruit (+${gain}). Hunger now ${me.hunger}.`);
    ctx.sendState(socket, me);
  }, "fruit — gather fruit; low yield");

  // /hunt  (needs bow) -> yields meat
  register("/hunt", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const inv = require("./inventory");
    const use = await inv.useTool(me.id, "bow");
    if (!use.ok) return ctx.you(socket, "You need a Bow. /craft bow or /buy bow");

    const lq = await ctx.envLQ(me);
    const meat = Math.max(2, Math.floor(Math.random() * 7) + Math.floor(lq / 6)); // 2..8ish
    const drain = Math.max(8, 12 - Math.floor(lq / 6)); // hunting is tiring

    me.meat = (me.meat || 0) + meat;
    me.hunger = (me.hunger || 100) - drain;

    if (me.hunger <= 0) {
      await ctx.respawn(me.id);
      ctx.sys(me.room, `${me.username} collapsed during the hunt and respawned.`);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      return ctx.sendState(socket, me2);
    }
    await dbq("UPDATE players SET meat=$1, hunger=$2 WHERE id=$3", [me.meat, me.hunger, me.id]);
    ctx.sys(me.room, `${me.username} hunted ${meat} meat.${use.broken ? " Bow broke." : ""}`);
    ctx.sendState(socket, me);
  }, " — hunt animals (needs Bow)");

  // /mine  (needs pickaxe) -> stone
  register("/mine", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const inv = require("./inventory");
    const use = await inv.useTool(me.id, "pickaxe");
    if (!use.ok) return ctx.you(socket, "You need a Pickaxe. /craft pickaxe or /buy pickaxe");

    const lq = await ctx.envLQ(me); // later: terrain modifiers
    const stones = Math.max(2, Math.floor(Math.random() * 7)); // 2..8
    const drain = Math.max(6, 10 - Math.floor(lq / 8));

    me.stone = (me.stone || 0) + stones;
    me.hunger = (me.hunger || 100) - drain;

    if (me.hunger <= 0) {
      await ctx.respawn(me.id);
      ctx.sys(me.room, `${me.username} collapsed in the mines and respawned.`);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      return ctx.sendState(socket, me2);
    }
    await dbq("UPDATE players SET stone=$1, hunger=$2 WHERE id=$3", [me.stone, me.hunger, me.id]);
    ctx.sys(me.room, `${me.username} mined ${stones} stone.${use.broken ? " Pickaxe broke." : ""}`);
    ctx.sendState(socket, me);
  }, " — mine stone (needs Pickaxe)");

  // /eat fruit|meat
  register("/eat", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const what = (parts[1] || "").toLowerCase();
    if (!what || (what !== "fruit" && what !== "meat")) {
      return ctx.you(socket, "Usage: /eat fruit|meat");
    }

    if (what === "fruit") {
      if ((me.food || 0) <= 0) return ctx.you(socket, "You have no fruit.");
      me.food -= 1;
      me.hunger = Math.min(100, (me.hunger || 100) + 20);
      await dbq("UPDATE players SET food=$1, hunger=$2 WHERE id=$3", [me.food, me.hunger, me.id]);
      await addEffect(me.id, "WellFed", 1, 120);
      ctx.sys(me.room, `${me.username} ate fruit. Hunger ${me.hunger}. (WellFed)`);
      ctx.sendState(socket, me);
      return;
    }

    // meat
    if ((me.meat || 0) <= 0) return ctx.you(socket, "You have no meat.");
    me.meat -= 1;
    me.hunger = Math.min(100, (me.hunger || 100) + 35); // meat heals more
    await dbq("UPDATE players SET meat=$1, hunger=$2 WHERE id=$3", [me.meat, me.hunger, me.id]);
    await addEffect(me.id, "WellFed", 1, 180); // longer buff for meat
    ctx.sys(me.room, `${me.username} ate meat. Hunger ${me.hunger}. (WellFed)`);
    ctx.sendState(socket, me);
  }, "fruit|meat — eat, restore hunger, gain WellFed");

  // tick: passive hunger drain (respect LQ)
  const TICK_MS = 30000;
  setInterval(async () => {
    try {
      const players = await dbq("SELECT id, room, hunger FROM players", []);
      for (const p of players) {
        if (!p || !p.room) continue;
        const lq = await registry.envLQ(p);
        let drain = 2;
        drain = Math.max(1, drain - Math.floor(lq / 10));
        const newH = Math.max(1, (p.hunger || 100) - drain);
        await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, p.id]);
      }
      // push fresh state to connected sockets
      for (const [id, s] of registry.io.sockets.sockets) {
        const pr = await dbq("SELECT * FROM players WHERE socket_id=$1", [id]);
        if (pr.length) registry.sendState(s, pr[0]);
      }
    } catch (e) {
      console.error("Tick error:", e);
    }
  }, TICK_MS);
}

module.exports = { initSurvivalFeature, getEffects };
