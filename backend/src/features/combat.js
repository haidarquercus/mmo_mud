// src/features/combat.js
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { getEffects, rollModFromEffects, addEffect } = require("./status");
const { invValue, createBountyOn, payoutBountiesFor } = require("./bounty");

// simple in-memory combat cooldowns
const turnLocks = new Map(); // key: "attackerId:targetId" or vice versa

function baseCombatRoll(hunger) {
  return Math.ceil(Math.random() * 100) + Math.floor(((hunger || 50) - 50) / 2);
}

async function getCombatStats(playerId) {
  const rows = await dbq(
    `SELECT p.id, p.username, p.hunger, p.role,
            ew.attack AS w_atk, ea.defense AS a_def,
            ew.quality AS w_q, ea.quality AS a_q
       FROM players p
  LEFT JOIN equipment ew ON ew.id = p.equipped_weapon_id
  LEFT JOIN equipment ea ON ea.id = p.equipped_armor_id
      WHERE p.id=$1`,
    [playerId]
  );
  return rows[0];
}

function qualBonus(q) {
  if (!q) return 0;
  const s = q.toLowerCase();
  if (s.startsWith("poor")) return -5;
  if (s.startsWith("good")) return +5;
  if (s.startsWith("excellent")) return +10;
  return 0;
}

async function handleKill(ctx, killer, victim) {
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

  const bounty = invValue(victim);
  await createBountyOn(killer.id, bounty, `murder of ${victim.username}`);
  await ctx.respawn(victim.id);

  ctx.sys(
    killer.room,
    `${killer.username} killed ${victim.username} and looted G:${loot.gold} F:${loot.food} M:${loot.meat} W:${loot.wood} S:${loot.stone}.`
  );
  if (paid > 0) ctx.sys(killer.room, `${killer.username} claimed ${paid}g in bounties.`);
  ctx.sys(killer.room, `${killer.username} is now WANTED. Bounty set: ${bounty} gold.`);
}

function lockTurn(a, b) {
  const k1 = `${a}:${b}`, k2 = `${b}:${a}`;
  turnLocks.set(k1, Date.now());
  turnLocks.set(k2, Date.now());
  setTimeout(() => { turnLocks.delete(k1); turnLocks.delete(k2); }, 30000);
}
function canAttack(a, b) {
  return !turnLocks.has(`${b}:${a}`); // can't attack if you just attacked and waiting for counter
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
    if (!ts.length) return ctx.you(socket, "No such target here.");
    if (ts.length > 1) return ctx.you(socket, "Ambiguous name.");
    const target = ts[0];

    if (!canAttack(me.id, target.id))
      return ctx.you(socket, "Wait your turn — your opponent must respond.");

    const A = await getCombatStats(me.id);
    const B = await getCombatStats(target.id);

    const myEff = await getEffects(me.id);
    const tgEff = await getEffects(target.id);

    let myRoll =
      baseCombatRoll(A.hunger) +
      rollModFromEffects(myEff) +
      (A.w_atk || 0) +
      qualBonus(A.w_q);
    let tgRoll =
      baseCombatRoll(B.hunger) +
      rollModFromEffects(tgEff) +
      (B.a_def || 0) +
      qualBonus(B.a_q);

    if ((A.role || "") === "Knight" && !!B.wanted) myRoll += 15;

    ctx.sys(me.room, `${A.username} attacks ${B.username}! (A:${myRoll} vs D:${tgRoll})`);

    if (myRoll > tgRoll + 10) {
      await handleKill(ctx, A, B);
    } else if (myRoll > tgRoll) {
      const dmg = Math.min(20 + (A.w_atk || 0), 50);
      const newH = Math.max(1, (B.hunger || 100) - dmg);
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, B.id]);
      ctx.sys(me.room, `${A.username} hits ${B.username} (-${dmg} health).`);
    } else {
      const drain = 5;
      const newH = Math.max(1, (A.hunger || 100) - drain);
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, A.id]);
      await addEffect(A.id, "Exhausted", 1, 60);
      ctx.sys(me.room, `${A.username} missed and is exhausted (-${drain} health).`);
    }

    lockTurn(A.id, B.id);
  }, "Name — attack someone (turn-based combat)");
}

module.exports = { initCombatFeature };
