// src/features/combat.js
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { getEffects, rollModFromEffects, addEffect } = require("./status");
const { invValue, createBountyOn, payoutBountiesFor } = require("./bounty");

function baseCombatRoll(hunger) {
  return Math.ceil(Math.random() * 100) + Math.floor(((hunger || 50) - 50) / 2);
}

async function handleKill(ctx, killer, victim) {
  // include MEAT in loot
  const loot = {
    gold: victim.gold || 0,
    food: victim.food || 0,
    meat: victim.meat || 0,
    wood: victim.wood || 0,
    stone: victim.stone || 0,
  };

  await dbq(
    "UPDATE players SET gold=gold+$1, food=food+$2, meat=meat+$3, wood=wood+$4, stone=stone+$5 WHERE id=$6",
    [loot.gold, loot.food, loot.meat, loot.wood, loot.stone, killer.id]
  );

  let paid = 0;
  if (victim.wanted) paid = await payoutBountiesFor(victim.id, killer.id);

  const amount = invValue(victim); // make sure this counts meat in bounty.js
  await createBountyOn(killer.id, amount, `murder of ${victim.username}`);

  await ctx.respawn(victim.id);

  // Notify room
  ctx.sys(
    killer.room,
    `${killer.username} killed ${victim.username} and looted G:${loot.gold} F:${loot.food} M:${loot.meat} W:${loot.wood} S:${loot.stone}.`
  );
  if (paid > 0) ctx.sys(killer.room, `${killer.username} claimed ${paid} gold in bounties.`);
  ctx.sys(killer.room, `${killer.username} is now WANTED. Bounty set: ${amount} gold.`);

  // Push fresh state to victim if online
  const vSock = ctx.socketOf(victim);
  if (vSock) {
    const vNow = (await dbq("SELECT * FROM players WHERE id=$1", [victim.id]))[0];
    ctx.sendState(vSock, vNow);
  }
}

function initCombatFeature(registry) {
  register("/attack", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    const name = parts[1];
    if (!name) return ctx.you(socket, "Usage: /attack Name");

    const ts = await dbq(
      "SELECT * FROM players WHERE room=$1 AND username ILIKE $2 AND id<>$3",
      [me.room, name + "%", me.id]
    );
    if (ts.length === 0) return ctx.you(socket, "No such target here.");
    if (ts.length > 1) return ctx.you(socket, "Ambiguous name.");
    const target = ts[0];

    // Effects modify rolls
    const myEff = await getEffects(me.id);
    const tgEff = await getEffects(target.id);
    let myRoll = baseCombatRoll(me.hunger) + rollModFromEffects(myEff);
    let tgRoll = baseCombatRoll(target.hunger) + rollModFromEffects(tgEff);

    // Knights hunt the WANTED (+15)
    if ((me.role || "") === "Knight" && !!target.wanted) myRoll += 15;

    ctx.sys(me.room, `${me.username} attacks ${target.username}! (A:${myRoll} vs D:${tgRoll})`);

    if (myRoll > tgRoll) {
      await handleKill(ctx, me, target);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      ctx.sendState(socket, me2);
    } else {
      const newH = Math.max(1, (me.hunger || 100) - 10);
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, me.id]);
      await addEffect(me.id, "Exhausted", 1, 60);
      ctx.sys(me.room, `${me.username} failed the attack and is exhausted (-10 hunger, Exhausted).`);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      ctx.sendState(socket, me2);
    }
  }, "Name — attack someone in your room");
}

module.exports = { initCombatFeature };
