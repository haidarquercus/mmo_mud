// src/features/jobs.js
const { dbq, withTx } = require("../db");
const { register } = require("../core/commands");

const JOB_GEN_MS = 2 * 60 * 1000;
const JOB_LIFETIME_MS = 30 * 60 * 1000;
const ROOM_JOB_CAP = 10;
const ABANDON_COOLDOWN_MS = 60 * 1000;

const DISPLAY_NAME = { food: "fruit", meat: "meat", stone: "stone", wood: "wood" };
const abandonCooldown = new Map();

function fmtJob(j) {
  if (j.type === "courier") return `#${j.id} courier → ${j.dest_room} · reward ${j.gold_reward}g`;
  const label = DISPLAY_NAME[j.req_item] || j.req_item;
  return `#${j.id} ${j.type} · deliver ${j.req_qty} ${label} · reward ${j.gold_reward}g`;
}

async function roomByName(name) {
  const r = await dbq("SELECT * FROM rooms WHERE LOWER(name)=LOWER($1)", [name]);
  return r[0] || null;
}
async function openJobsCount(roomId) {
  const r = await dbq("SELECT COUNT(*)::int AS n FROM jobs WHERE room_id=$1 AND expires_at>NOW()", [roomId]);
  return r[0]?.n || 0;
}

// Weighted RNG helper
function weightedPick(pairs) {
  let sum = 0;
  for (const [, w] of pairs) sum += Math.max(0, w);
  if (sum <= 0) return pairs[0][0];
  let r = Math.random() * sum;
  for (const [v, w] of pairs) {
    r -= Math.max(0, w);
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

// ----- Job Generation -----
async function genJobForRoom(room) {
  const pFood = room.price_food ?? 1;
  const pMeat = room.price_meat ?? 3;
  const pStone = room.price_stone ?? 2;
  const type = weightedPick([["forage", pFood], ["hunt", pMeat], ["mine", pStone], ["courier", 1]]);
  const expires = new Date(Date.now() + JOB_LIFETIME_MS);

  if (type === "courier") {
    const dest = await dbq("SELECT name FROM rooms WHERE name<>$1 ORDER BY RANDOM() LIMIT 1", [room.name]);
    if (!dest.length) return null;
    const reward = Math.max(5, Math.round(((pFood + pMeat + pStone) / 3) * 10));
    const ins = await dbq(
      `INSERT INTO jobs (room_id,type,req_item,req_qty,dest_room,gold_reward,expires_at)
       VALUES ($1,'courier',NULL,0,$2,$3,$4) RETURNING *`,
      [room.id, dest[0].name, reward, expires]
    );
    return ins[0];
  }

  const req_item = type === "hunt" ? "meat" : type === "mine" ? "stone" : "food";
  const baseQty = 10 + Math.floor(Math.random() * 21);
  const priceMap = { food: pFood, meat: pMeat, stone: pStone };
  const qty = Math.max(5, Math.round(baseQty * (0.8 + (priceMap[req_item] || 1) / 10)));
  const reward = Math.max(1, Math.round(qty * (priceMap[req_item] || 1) * 1.1));

  const ins = await dbq(
    `INSERT INTO jobs (room_id,type,req_item,req_qty,dest_room,gold_reward,expires_at)
     VALUES ($1,$2,$3,$4,NULL,$5,$6) RETURNING *`,
    [room.id, type, req_item, qty, reward, expires]
  );
  return ins[0];
}

async function ensureJobsTick(io) {
  try {
    await dbq("DELETE FROM jobs WHERE expires_at<=NOW()", []);
    const rooms = await dbq("SELECT id,name,price_food,price_meat,price_stone FROM rooms", []);
    for (const r of rooms) {
      const open = await openJobsCount(r.id);
      const need = Math.max(0, ROOM_JOB_CAP - open);
      const toCreate = Math.min(3, need);
      for (let i = 0; i < toCreate; i++) {
        const j = await genJobForRoom(r);
        if (j) io.to(r.name).emit("system", `New job posted: ${fmtJob(j)}`);
      }
    }
  } catch (e) {
    console.error("Jobs tick error:", e);
  }
}

async function currentClaim(playerId) {
  const r = await dbq(
    `SELECT jc.*, j.type, j.req_item, j.req_qty, j.dest_room, j.gold_reward, j.expires_at, j.room_id
       FROM job_claims jc
       JOIN jobs j ON j.id=jc.job_id
      WHERE jc.player_id=$1 AND jc.status='claimed' AND j.expires_at>NOW()
      ORDER BY jc.claimed_at DESC LIMIT 1`,
    [playerId]
  );
  return r[0] || null;
}

// ----- Feature Registration -----
function initJobsFeature(registry) {

  // /jobs — list
  register("/jobs", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const room = await roomByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");
    const rows = await dbq(
      "SELECT * FROM jobs WHERE room_id=$1 AND expires_at>NOW() ORDER BY id",
      [room.id]
    );
    if (!rows.length) return ctx.you(socket, "No open jobs. Check back soon.");
    rows.forEach(j => ctx.you(socket, fmtJob(j)));
  }, "— list open jobs in this room");

  // /myjob — show active
  register("/myjob", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const c = await currentClaim(me.id);
    if (!c) return ctx.you(socket, "You have no active job.");
    ctx.you(socket, `Active job: ${fmtJob(c)} (claimed ${new Date(c.claimed_at).toLocaleTimeString()})`);
  }, "— show your active job");

  // /accept — claim
  register("/accept", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const id = Number(parts[1]);
    if (!Number.isInteger(id)) return ctx.you(socket, "Usage: /accept <jobId>");
    const cur = await currentClaim(me.id);
    if (cur) return ctx.you(socket, "You already have a job. /deliver or /abandon first.");

    try {
      await withTx(async (c) => {
        const job = (await c.query("SELECT * FROM jobs WHERE id=$1 FOR UPDATE", [id])).rows[0];
        if (!job) throw new Error("No such job.");
        if (new Date(job.expires_at).getTime() <= Date.now()) throw new Error("That job expired.");
        const room = await roomByName(me.room);
        if (!room || room.id !== job.room_id) throw new Error("That job is not in this room.");
        const claimed = (await c.query(
          "SELECT 1 FROM job_claims WHERE job_id=$1 AND status='claimed' LIMIT 1",
          [id]
        )).rows.length > 0;
        if (claimed) throw new Error("That job is already claimed.");
        await c.query("INSERT INTO job_claims (job_id,player_id,status) VALUES ($1,$2,'claimed')", [id, me.id]);
      });
      ctx.sys(me.room, `${me.username} accepted job #${id}.`);
    } catch (e) {
      ctx.you(socket, e.message || "Could not accept the job.");
    }
  }, "<jobId> — accept a job in this room");

  // /deliver — complete
  register("/deliver", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const claim = await currentClaim(me.id);
    if (!claim) return ctx.you(socket, "You have no active job.");
    const room = await roomByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");

    try {
      await withTx(async (c) => {
        const row = (await c.query(
          `SELECT jc.id AS claim_id, j.*
             FROM job_claims jc
             JOIN jobs j ON j.id=jc.job_id
            WHERE jc.id=$1 FOR UPDATE`,
          [claim.id]
        )).rows[0];
        if (!row) throw new Error("Job not found.");
        if (new Date(row.expires_at).getTime() <= Date.now()) throw new Error("This job has expired.");

        if (row.type === "courier") {
          if (me.room.toLowerCase() !== row.dest_room.toLowerCase())
            throw new Error(`Travel to ${row.dest_room} and use /deliver there.`);
          await c.query("UPDATE players SET gold=gold+$1 WHERE id=$2", [row.gold_reward, me.id]);
        } else {
          const item = row.req_item;
          const qty = row.req_qty;
          const pNow = (await c.query(
            `SELECT id,gold,food,meat,stone FROM players WHERE id=$1 FOR UPDATE`, [me.id]
          )).rows[0];
          if ((pNow[item] || 0) < qty)
            throw new Error(`You need ${qty} ${DISPLAY_NAME[item]} to deliver.`);
          await c.query(`UPDATE players SET ${item}=${item}-$1,gold=gold+$2 WHERE id=$3`,
            [qty, row.gold_reward, me.id]);
        }

        await c.query("UPDATE job_claims SET status='completed' WHERE id=$1", [claim.id]);
        await c.query("DELETE FROM jobs WHERE id=$1", [row.id]);
      });

      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      ctx.you(socket, `✅ Job complete! You earned ${claim.gold_reward} gold.`);
      ctx.sys(me.room, `${me.username} completed job #${claim.job_id}.`);
      ctx.sendState(socket, me2);
    } catch (e) {
      ctx.you(socket, e.message || "Delivery failed.");
    }
  }, "— complete your current job when ready");

  // /abandon — cancel
  register("/abandon", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const claim = await currentClaim(me.id);
    if (!claim) return ctx.you(socket, "You have no active job.");
    const last = abandonCooldown.get(me.id) || 0;
    if (Date.now() - last < ABANDON_COOLDOWN_MS) {
      const s = Math.ceil((ABANDON_COOLDOWN_MS - (Date.now() - last)) / 1000);
      return ctx.you(socket, `Please wait ${s}s before abandoning again.`);
    }
    await dbq("UPDATE job_claims SET status='abandoned' WHERE id=$1", [claim.id]);
    abandonCooldown.set(me.id, Date.now());
    ctx.sys(me.room, `${me.username} abandoned their job.`);
  }, "— abandon your current job");

  // Spawn generator
  if (registry.io && !registry.__jobsTick) {
    registry.__jobsTick = true;
    setInterval(() => ensureJobsTick(registry.io), JOB_GEN_MS);
    ensureJobsTick(registry.io);
  }
}

module.exports = { initJobsFeature };
