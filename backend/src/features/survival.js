// src/features/survival.js
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { addEffect } = require("./status");

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

  // unified health drain helper
  async function applyHealthDrain(ctx, me, drain, reason) {
    me.hunger = Math.max(0, (me.hunger || 100) - drain);
    if (me.hunger <= 0) {
      await ctx.respawn(me.id);
      ctx.sys(me.room, `${me.username} ${reason} and has respawned.`);
      const refreshed = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      ctx.sendState(ctx.socketOf(me), refreshed);
      return false;
    }
    await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [me.hunger, me.id]);
    ctx.sendState(ctx.socketOf(me), me);
    return true;
  }

  // /gather fruit
  register("/gather", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const what = (parts[1] || "").toLowerCase();
    if (what !== "fruit") return ctx.you(socket, "Usage: /gather fruit");

    const lq = await ctx.envLQ(me);
    const gain = 3;
    const drain = Math.max(2, 6 - Math.floor(lq / 5));

    me.food = (me.food || 0) + gain;
    if (!(await applyHealthDrain(ctx, me, drain, "collapsed from exhaustion"))) return;

    await dbq("UPDATE players SET food=$1 WHERE id=$2", [me.food, me.id]);
    ctx.sys(me.room, `${me.username} gathered fruit (+${gain}). Health ${me.hunger}.`);
  }, "fruit — gather fruit; low yield");

  // /hunt  (needs bow)
  register("/hunt", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const inv = require("./inventory");
    const use = await inv.useTool(me.id, "bow");
    if (!use.ok) return ctx.you(socket, "You need a Bow. /craft bow or /buy bow");

    const lq = await ctx.envLQ(me);
    const meat = Math.max(2, Math.floor(Math.random() * 7) + Math.floor(lq / 6));
    const drain = Math.max(4, 10 - Math.floor(lq / 6));

    me.meat = (me.meat || 0) + meat;
    if (!(await applyHealthDrain(ctx, me, drain, "collapsed during the hunt"))) return;

    await dbq("UPDATE players SET meat=$1 WHERE id=$2", [me.meat, me.id]);
    ctx.sys(me.room, `${me.username} hunted ${meat} meat.${use.broken ? " Bow broke." : ""}`);
  }, " — hunt animals (needs Bow)");

  // /mine (needs pickaxe)
  register("/mine", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const inv = require("./inventory");
    const use = await inv.useTool(me.id, "pickaxe");
    if (!use.ok) return ctx.you(socket, "You need a Pickaxe. /craft pickaxe or /buy pickaxe");

    const stones = Math.max(2, Math.floor(Math.random() * 7));
    const drain = Math.max(3, 9 - Math.floor(Math.random() * 2));

    me.stone = (me.stone || 0) + stones;
    if (!(await applyHealthDrain(ctx, me, drain, "collapsed in the mines"))) return;

    await dbq("UPDATE players SET stone=$1 WHERE id=$2", [me.stone, me.id]);
    ctx.sys(me.room, `${me.username} mined ${stones} stone.${use.broken ? " Pickaxe broke." : ""}`);
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
      me.hunger = Math.min(100, (me.hunger || 100) + 15);
      await dbq("UPDATE players SET food=$1, hunger=$2 WHERE id=$3", [me.food, me.hunger, me.id]);
      await addEffect(me.id, "Rested", 1, 60);
      ctx.sys(me.room, `${me.username} ate fruit. Health ${me.hunger}.`);
      ctx.sendState(socket, me);
      return;
    }

    if ((me.meat || 0) <= 0) return ctx.you(socket, "You have no meat.");
    me.meat -= 1;
    me.hunger = Math.min(100, (me.hunger || 100) + 25);
    await dbq("UPDATE players SET meat=$1, hunger=$2 WHERE id=$3", [me.meat, me.hunger, me.id]);
    await addEffect(me.id, "WellFed", 1, 120);
    ctx.sys(me.room, `${me.username} ate meat. Health ${me.hunger}.`);
    ctx.sendState(socket, me);
  }, "fruit|meat — eat, restore health, gain WellFed");
}

module.exports = { initSurvivalFeature };
