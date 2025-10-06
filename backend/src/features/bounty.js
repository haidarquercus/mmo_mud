// src/features/bounty.js
const { dbq } = require("../db");

// Inventory value used to seed auto-bounties after a murder.
// We weight meat higher than fruit; stone higher than wood.
function invValue(p) {
  if (!p) return 50;
  const gold  = Number(p.gold)  || 0;
  const food  = Number(p.food)  || 0; // fruit/berries
  const meat  = Number(p.meat)  || 0;
  const wood  = Number(p.wood)  || 0;
  const stone = Number(p.stone) || 0;

  const base = 50; // floor so killing a naked peasant still sets a bounty
  const value = base
    + gold               // 1x
    + food               // 1x
    + 3 * meat           // 3x (more valuable than food)
    + wood               // 1x
    + 2 * stone;         // 2x

  return Math.max(10, Math.floor(value));
}

async function createBountyOn(killerId, amount, reason) {
  await dbq("UPDATE players SET wanted=true WHERE id=$1", [killerId]);
  await dbq(
    "INSERT INTO bounties (target_id, amount, reason) VALUES ($1,$2,$3)",
    [killerId, amount, reason || "murder"]
  );
}

async function payoutBountiesFor(victimId, hunterId) {
  const rows = await dbq(
    "SELECT amount FROM bounties WHERE target_id=$1 AND active=true",
    [victimId]
  );
  if (!rows.length) return 0;
  const sum = rows.reduce((s, r) => s + r.amount, 0);
  await dbq("UPDATE players SET gold=gold+$1 WHERE id=$2", [sum, hunterId]);
  await dbq("UPDATE bounties SET active=false WHERE target_id=$1 AND active=true", [victimId]);
  await dbq("UPDATE players SET wanted=false WHERE id=$1", [victimId]);
  return sum;
}

module.exports = { invValue, createBountyOn, payoutBountiesFor };
