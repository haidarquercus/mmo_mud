// src/features/combat.js
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { getEffects, rollModFromEffects, addEffect } = require("./status");
const { invValue, createBountyOn, payoutBountiesFor } = require("./bounty");

// Turn locks: prevents spamming — each pair must alternate
const turnLocks = new Map();

function baseCombatRoll(hunger) {
  return Math.ceil(Math.random() * 100) + Math.floor(((hunger || 50) - 50) / 2);
}

async function getCombatStats(id) {
  const r = await dbq(
    `SELECT p.*, ew.attack AS w_atk, ea.defense AS a_def,
            ew.quality AS w_q, ea.quality AS a_q
       FROM players p
  LEFT JOIN equipment ew ON ew.id=p.equipped_weapon_id
  LEFT JOIN equipment ea ON ea.id=p.equipped_armor_id
      WHERE p.id=$1`,
    [id]
  );
  return r[0];
}

function qualBonus(q) {
  if (!q) return 0;
  const s = q.toLowerCase();
  if (s.startsWith("poor")) return -5;
  if (s.startsWith("good")) return +5;
  if (s.startsWith("excellent")) return +10;
  return 0;
}

/**
 * SAFE-ZONE RULE:
 * - Any named location / founded town (i.e., any `rooms` entry) is a safe zone.
 * - In safe zones, PvP is allowed ONLY if either attacker or target is WANTED.
 * - (If you later add true wilderness areas that are not rooms, you can
 *   bypass this check by letting players be in a non-room grid.)
 */
async function canFightHere(attacker, target) {
  // Wanted overrides safe zones.
  if (attacker.wanted || target.wanted) return true;

  // Player is always in some named room (town/city). Treat ALL rooms as safe zones.
  // Therefore, if nobody is wanted, PvP is blocked here.
  return false;
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

  // Respawn victim (clears home/inventory/role, moves to Capital; your player.js handles this)
  await ctx.respawn(victim.id);

  // Room broadcast
  ctx.sys(
    killer.room,
    `${killer.username} killed ${victim.username} and looted G:${loot.gold} F:${loot.food} M:${loot.meat} W:${loot.wood} S:${loot.stone}.`
  );
  if (paid > 0) ctx.sys(killer.room, `${killer.username} claimed ${paid}g in bounties.`);
  ctx.sys(killer.room, `${killer.username} is now WANTED. Bounty set: ${bounty} gold.`);

  // Update victim client if connected
  const vSock = ctx.socketOf(victim);
  if (vSock) {
    const vNow = (await dbq("SELECT * FROM players WHERE id=$1", [victim.id]))[0];
    ctx.sendState(vSock, vNow);
    ctx.you(vSock, "You have been slain. You awaken back in the Capital...");
  }
}

function lockTurn(a, b) {
  const k1 = `${a}:${b}`, k2 = `${b}:${a}`;
  turnLocks.set(k1, Date.now());
  turnLocks.set(k2, Date.now());
  setTimeout(() => { turnLocks.delete(k1); turnLocks.delete(k2); }, 30000);
}
function canAttack(a, b) {
  // You can't attack if you were the last to act in this pair; the other side must respond.
  return !turnLocks.has(`${b}:${a}`);
}

function initCombatFeature(_registry) {
  register("/attack", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    const targetName = parts[1];
    if (!targetName) return ctx.you(socket, "Usage: /attack Name");

    const targets = await dbq(
      "SELECT * FROM players WHERE room=$1 AND username ILIKE $2 AND id<>$3",
      [me.room, targetName + "%", me.id]
    );
    if (!targets.length) return ctx.you(socket, "No such target here.");
    if (targets.length > 1) return ctx.you(socket, "Ambiguous name.");
    const target = targets[0];

    if (!await canFightHere(me, target)) {
      return ctx.you(socket, "This is a town/city safe zone — you may only attack WANTED players here.");
    }

    if (!canAttack(me.id, target.id))
      return ctx.you(socket, "Wait your turn — your opponent must respond.");

    const A = await getCombatStats(me.id);
    const B = await getCombatStats(target.id);

    const myEff = await getEffects(me.id);
    const tgEff = await getEffects(target.id);

    let atkRoll = baseCombatRoll(A.hunger) + rollModFromEffects(myEff) + (A.w_atk || 0) + qualBonus(A.w_q);
    let defRoll = baseCombatRoll(B.hunger) + rollModFromEffects(tgEff) + (B.a_def || 0) + qualBonus(B.a_q);

    // Knight edge vs WANTED
    if ((A.role || "") === "Knight" && B.wanted) atkRoll += 15;

    ctx.sys(A.room, `${A.username} attacks ${B.username}! (A:${atkRoll} vs D:${defRoll})`);

    if (atkRoll > defRoll + 10) {
      await handleKill(ctx, A, B);
    } else if (atkRoll > defRoll) {
      const dmg = Math.min(20 + (A.w_atk || 0), 50);
      const newH = Math.max(0, (B.hunger || 100) - dmg);
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, B.id]);

      // Broadcast and sync both sides
      ctx.sys(A.room, `${A.username} hits ${B.username} (-${dmg} health).`);

      const bSock = ctx.socketOf(B);
      if (bSock) {
        const bNow = (await dbq("SELECT * FROM players WHERE id=$1", [B.id]))[0];
        ctx.sendState(bSock, bNow);
        if (newH <= 0) {
          await handleKill(ctx, A, B);
        } else {
          ctx.you(bSock, `You were hit for ${dmg} damage!`);
        }
      }
    } else {
      const drain = 5;
      const newH = Math.max(1, (A.hunger || 100) - drain);
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, A.id]);
      await addEffect(A.id, "Exhausted", 1, 60);

      ctx.sys(A.room, `${A.username} missed and is exhausted (-${drain} health).`);

      const aSock = ctx.socketOf(A);
      if (aSock) {
        const aNow = (await dbq("SELECT * FROM players WHERE id=$1", [A.id]))[0];
        ctx.sendState(aSock, aNow);
      }
    }

    lockTurn(A.id, B.id);
  }, "Name — attack someone (turn-based combat)");
}

module.exports = { initCombatFeature };
