// src/features/jobs.js
const { dbq, withTx } = require("../db");
const { register } = require("../core/commands");

// ===== Config =====
const JOB_GEN_MS = 2 * 60 * 1000;           // generate every 2 minutes
const JOB_LIFETIME_MS = 30 * 60 * 1000;     // jobs expire after 30 minutes
const ROOM_JOB_CAP = 10;                    // max open jobs per room
const PARTY_COOLDOWN_MS = 0;                // reserved for future
const ABANDON_COOLDOWN_MS = 60 * 1000;      // 60s cooldown after abandon

// canonical item keys in DB: 'food','meat','stone','wood'. Display: fruit/...
const DISPLAY_NAME = { food: "fruit", meat: "meat", stone: "stone", wood: "wood" };

const abandonCooldown = new Map(); // playerId -> timestamp

function fmtJob(j) {
  // j.type in ('forage','hunt','mine','courier')
  if (j.type === "courier") {
    return `#${j.id} courier → ${j.dest_room} · reward ${j.gold_reward}g`;
  }
  const label = DISPLAY_NAME[j.req_item] || j.req_item;
  return `#${j.id} ${j.type} · deliver ${j.req_qty} ${label} · reward ${j.gold_reward}g`;
}

async function roomByName(name) {
  const r = await dbq("SELECT * FROM rooms WHERE name=$1", [name]);
  return r[0] || null;
}

async function openJobsCount(roomId) {
  const r = await dbq(
    "SELECT COUNT(*)::int AS n FROM jobs WHERE room_id=$1 AND expires_at > NOW()",
    [roomId]
  );
  return r[0]?.n || 0;
}

function weightedPick(pairs) {
  // pairs = [[value, weight], ...]
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

async function genJobForRoom(room) {
  // Weights based on room prices → higher price signals demand
  const pFood = room.price_food ?? 1;
  const pMeat = room.price_meat ?? 3;
  const pStone = room.price_stone ?? 2;

  const type = weightedPick([
    ["forage", pFood],
    ["hunt", pMeat],
    ["mine", pStone],
    ["courier", 1],
  ]);

  const expires = new Date(Date.now() + JOB_LIFETIME_MS);

  if (type === "courier") {
    // pick any other room as destination
    const dest = await dbq("SELECT name FROM rooms WHERE name <> $1 ORDER BY RANDOM() LIMIT 1", [room.name]);
    if (!dest.length) return null; // only one room exists
    const reward = Math.max(5, Math.round( (pFood + pMeat + pStone) / 3 * 10 ));
    const ins = await dbq(
      "INSERT INTO jobs (room_id, type, req_item, req_qty, dest_room, gold_reward, expires_at) VALUES ($1,'courier',NULL,0,$2,$3,$4) RETURNING *",
      [room.id, dest[0].name, reward, expires]
    );
    return ins[0];
  }

  // resource jobs
  let req_item = "food";
  if (type === "hunt") req_item = "meat";
  if (type === "mine") req_item = "stone";

  // qty 10..30, slightly scaled by price
  const baseQty = 10 + Math.floor(Math.random() * 21);
  const priceMap = { food: pFood, meat: pMeat, stone: pStone };
  const qty = Math.max(5, Math.round(baseQty * (0.8 + (priceMap[req_item] || 1) / 10)));
  const reward = Math.max(1, Math.round(qty * (priceMap[req_item] || 1) * 1.1));

  const ins = await dbq(
    "INSERT INTO jobs (room_id, type, req_item, req_qty, dest_room, gold_reward, expires_at) VALUES ($1,$2,$3,$4,NULL,$5,$6) RETURNING *",
    [room.id, type, req_item, qty, reward, expires]
  );
  return ins[0];
}

async function ensureJobsTick(io) {
  try {
    // Cleanup expired jobs to keep table small
    await dbq("DELETE FROM jobs WHERE expires_at <= NOW()", []);

    const rooms = await dbq("SELECT id, name, price_food, price_meat, price_stone FROM rooms", []);
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

// Helpers to find current claim
async function currentClaim(playerId) {
  const r = await dbq(
    `SELECT jc.*, j.type, j.req_item, j.req_qty, j.dest_room, j.gold_reward, j.expires_at, j.room_id
       FROM job_claims jc
       JOIN jobs j ON j.id = jc.job_id
      WHERE jc.player_id=$1 AND jc.status='claimed' AND j.expires_at > NOW()
      ORDER BY jc.claimed_at DESC
      LIMIT 1`,
    [playerId]
  );
  return r[0] || null;
}

function initJobsFeature(registry) {
  // List jobs in room
  register("/jobs", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const room = await roomByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");

    const rows = await dbq(
      "SELECT * FROM jobs WHERE room_id=$1 AND expires_at > NOW() ORDER BY id",
      [room.id]
    );
    if (!rows.length) return ctx.you(socket, "No open jobs. Check back soon.");
    rows.forEach(j => ctx.you(socket, fmtJob(j)));
  }, " — list open jobs in this room");

  // Show your claim
  register("/myjob", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const c = await currentClaim(me.id);
    if (!c) return ctx.you(socket, "You have no active job.");
    ctx.you(socket, `Active job: ${fmtJob(c)} (claimed at ${new Date(c.claimed_at).toLocaleTimeString()})`);
  }, " — show your active job (if any)");

  // Accept a job
  register("/accept", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const id = Number(parts[1]);
    if (!Number.isInteger(id)) return ctx.you(socket, "Usage: /accept <jobId>");

    // already have a job?
    const cur = await currentClaim(me.id);
    if (cur) return ctx.you(socket, "You already have a job. /deliver or /abandon first.");

    // check job exists in your room, not expired, not claimed
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

      await c.query(
        "INSERT INTO job_claims (job_id, player_id, status) VALUES ($1,$2,'claimed')",
        [id, me.id]
      );
    }).catch(e => {
      return ctx.you(socket, e.message || "Could not accept the job.");
    });

    ctx.sys(me.room, `${me.username} accepted job #${id}.`);
  }, "jobId — accept a job");

  // Deliver a job
  register("/deliver", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const claim = await currentClaim(me.id);
    if (!claim) return ctx.you(socket, "You have no active job.");

    const room = await roomByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");

    try {
      await withTx(async (c) => {
        // Lock claim & job rows
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
          // Must be in destination room
          if (me.room !== row.dest_room) throw new Error(`Travel to ${row.dest_room} and use /deliver there.`);
          // Pay and complete
          await c.query("UPDATE players SET gold=gold+$1 WHERE id=$2", [row.gold_reward, me.id]);
          await c.query("UPDATE job_claims SET status='completed' WHERE id=$1", [claim.id]);
          await c.query("DELETE FROM jobs WHERE id=$1", [row.id]);
        } else {
          const item = row.req_item; // 'food','meat','stone'
          const qty = row.req_qty;
          // Re-check latest inventory
          const pNow = (await c.query(
            `SELECT id, gold, food, meat, stone FROM players WHERE id=$1 FOR UPDATE`,
            [me.id]
          )).rows[0];
          if ((pNow[item] || 0) < qty) throw new Error(`You need ${qty} ${DISPLAY_NAME[item]} to deliver.`);
          await c.query(`UPDATE players SET ${item}=${item}-$1, gold=gold+$2 WHERE id=$3`,
            [qty, row.gold_reward, me.id]);
          await c.query("UPDATE job_claims SET status='completed' WHERE id=$1", [claim.id]);
          await c.query("DELETE FROM jobs WHERE id=$1", [row.id]);
        }
      });
    } catch (e) {
      return ctx.you(socket, e.message || "Delivery failed.");
    }

    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sys(me.room, `${me.username} completed a job and earned ${claim.gold_reward}g.`);
    ctx.sendState(socket, me2);
  }, " — complete your current job if requirements are met");

  // Abandon current job
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
  }, " — abandon your current job (short cooldown)");

  // Schedule generator/cleaner
  if (registry.io && !registry.__jobsTick) {
    registry.__jobsTick = true;
    setInterval(() => ensureJobsTick(registry.io), JOB_GEN_MS);
    // Kick once on boot
    ensureJobsTick(registry.io);
  }
}

module.exports = { initJobsFeature };
