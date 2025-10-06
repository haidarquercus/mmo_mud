// src/features/world_jobs.js
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { useTool } = require("./inventory");
const { addEffect } = require("./status");

// ---- config knobs ----
const MAX_SITES   = 5;   // maintain up to N active treasure sites
const MAX_BANDITS = 7;   // maintain up to N active bandits
const TICK_MS     = 60 * 1000;  // maintenance tick
const LIFETIME_MIN = { site: 180, bandit: 120 }; // minutes before despawn

function randInt(a,b){ return (a + Math.floor(Math.random() * (b - a + 1))); }

async function randomLandRooms(limit) {
  return await dbq(
    "SELECT id, name, world_x, world_y, terrain, living_quality FROM rooms WHERE is_ocean=FALSE AND world_x IS NOT NULL ORDER BY random() LIMIT $1",
    [limit]
  );
}

async function ensureTreasureSites(io) {
  const act = await dbq("SELECT COUNT(*)::int AS n FROM treasure_sites WHERE active=TRUE AND expires_at>NOW()", []);
  if ((act[0]?.n || 0) >= MAX_SITES) return;

  const need = MAX_SITES - (act[0]?.n || 0);
  const rooms = await randomLandRooms(need * 2);

  for (let i=0; i<rooms.length && i<need; i++) {
    const r = rooms[i];
    const reward = randInt(80, 160);
    const remaining = randInt(1, 3);
    const chance_bp = randInt(90, 160); // 1 in X per /dig
    const expires = new Date(Date.now() + LIFETIME_MIN.site*60*1000);
    await dbq(
      `INSERT INTO treasure_sites (room_id, world_x, world_y, clue, reward, remaining, chance_bp, expires_at, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)`,
      [r.id, r.world_x, r.world_y, `Old map points to (${r.world_x},${r.world_y})`, reward, remaining, chance_bp, expires]
    );
    // announce to Capital (lightweight “job board”)
    io.to("Capital").emit("system", `New job posted: treasure dig at (${r.world_x},${r.world_y}) · reward ${reward}g each · ${remaining} finds remain`);
  }
}

async function ensureBandits(io) {
  const act = await dbq("SELECT COUNT(*)::int AS n FROM npcs_bandits WHERE alive=TRUE AND expires_at>NOW()", []);
  if ((act[0]?.n || 0) >= MAX_BANDITS) return;

  const need = MAX_BANDITS - (act[0]?.n || 0);
  const rooms = await randomLandRooms(need * 2);

  for (let i=0; i<rooms.length && i<need; i++) {
    const r = rooms[i];
    const hp = randInt(30, 60);
    const power = randInt(50, 80);
    const reward = randInt(40, 120);
    const expires = new Date(Date.now() + LIFETIME_MIN.bandit*60*1000);
    await dbq(
      `INSERT INTO npcs_bandits (room_id, world_x, world_y, hp, power, reward, expires_at, alive)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE)`,
      [r.id, r.world_x, r.world_y, hp, power, reward, expires]
    );
    io.to("Capital").emit("system", `New job posted: bandit sighted near (${r.world_x},${r.world_y}) · reward ${reward}g`);
  }
}

async function cleanupExpired() {
  await dbq("UPDATE treasure_sites SET active=FALSE WHERE expires_at<NOW() OR remaining<=0", []);
  await dbq("UPDATE npcs_bandits SET alive=FALSE WHERE expires_at<NOW() OR hp<=0", []);
}

async function hereRoom(me) {
  const r = await dbq("SELECT id, name, world_x, world_y, is_ocean FROM rooms WHERE name=$1", [me.room]);
  return r[0] || null;
}

function initWorldJobsFeature(registry) {

  // maintenance tick
  setInterval(async () => {
    try {
      await cleanupExpired();
      await ensureTreasureSites(registry.io);
      await ensureBandits(registry.io);
    } catch (e) {
      console.error("[world_jobs] tick error:", e);
    }
  }, TICK_MS);

  // --- Treasure: /sites (nearby list) ---
  register("/sites", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const r = await hereRoom(me);
    if (!r || r.world_x === null) return ctx.you(socket, "World not generated yet. Ask the King to /worldgen.");

    const rows = await dbq(
      `SELECT ts.id, ts.world_x, ts.world_y, ts.reward, ts.remaining, (ts.expires_at - NOW()) AS ttl
         FROM treasure_sites ts
        WHERE ts.active=TRUE AND ts.expires_at>NOW()
        ORDER BY ABS(ts.world_x-$1)+ABS(ts.world_y-$2) ASC
        LIMIT 8`,
      [r.world_x, r.world_y]
    );
    if (!rows.length) return ctx.you(socket, "No active treasure sites.");
    rows.forEach(s => ctx.you(socket,
      `#${s.id} treasure at (${s.world_x},${s.world_y}) · reward ${s.reward}g · ${s.remaining} left · ends in ~${fmtTTL(s.ttl)}`));
  }, " — list nearby treasure digs");

  // --- Treasure: /dig (needs pickaxe, in same grid) ---
  register("/dig", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const r = await hereRoom(me);
    if (!r || r.world_x === null) return ctx.you(socket, "World not generated yet.");

    // tool check
    const use = await useTool(me.id, "pickaxe");
    if (!use.ok) return ctx.you(socket, "You need a Pickaxe. /craft pickaxe or /buy pickaxe");

    // find an active site for this room
    const site = (await dbq(
      `SELECT * FROM treasure_sites WHERE room_id=$1 AND active=TRUE AND expires_at>NOW() ORDER BY id LIMIT 1`,
      [r.id]
    ))[0];
    // still allow “dry” dig with exhaustion if no site
    const drain = 10;
    const newH = Math.max(1, (me.hunger || 100) - drain);

    if (!site) {
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, me.id]);
      ctx.sys(me.room, `${me.username} dug for treasure but found nothing. ${use.broken ? "Pickaxe broke." : ""}`);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      return ctx.sendState(socket, me2);
    }

    // roll chance
    const hit = (randInt(1, site.chance_bp) === 1);
    if (hit) {
      await dbq("UPDATE players SET gold=gold+$1, hunger=$2 WHERE id=$3", [site.reward, newH, me.id]);
      await dbq("UPDATE treasure_sites SET remaining=remaining-1 WHERE id=$1", [site.id]);
      ctx.sys(me.room, `${me.username} unearthed a relic and earned ${site.reward}g! ${use.broken ? "Pickaxe broke." : ""}`);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      return ctx.sendState(socket, me2);
    } else {
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, me.id]);
      ctx.sys(me.room, `${me.username} dug a deep hole but found nothing. ${use.broken ? "Pickaxe broke." : ""}`);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      return ctx.sendState(socket, me2);
    }
  }, " — dig for treasure in this grid (needs Pickaxe)");

  // --- Bandits: /bandits (here or nearby) ---
  register("/bandits", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    const r = await hereRoom(me);
    if (!r || r.world_x === null) return ctx.you(socket, "World not generated yet.");

    const here = await dbq(
      `SELECT id, hp, power, reward, (expires_at - NOW()) AS ttl
         FROM npcs_bandits
        WHERE room_id=$1 AND alive=TRUE AND expires_at>NOW()
        ORDER BY id`, [r.id]);
    if (here.length) {
      here.forEach(b => ctx.you(socket, `Bandit #${b.id} — HP:${b.hp} POW:${b.power} · reward ${b.reward}g · ~${fmtTTL(b.ttl)}`));
      return;
    }
    // nearest
    const near = await dbq(
      `SELECT id, world_x, world_y, reward, (expires_at - NOW()) AS ttl
         FROM npcs_bandits
        WHERE alive=TRUE AND expires_at>NOW()
        ORDER BY ABS(world_x-$1)+ABS(world_y-$2) ASC
        LIMIT 6`,
      [r.world_x, r.world_y]
    );
    if (!near.length) return ctx.you(socket, "No bandits nearby.");
    near.forEach(b => ctx.you(socket, `Bandit #${b.id} near (${b.world_x},${b.world_y}) · reward ${b.reward}g · ~${fmtTTL(b.ttl)}`));
  }, " — list bandits here/nearby");

  // --- Bandits: /fight [id] (fight a bandit in this grid) ---
  register("/fight", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const r = await hereRoom(me);
    if (!r || r.world_x === null) return ctx.you(socket, "World not generated yet.");

    let b;
    if (parts[1]) {
      const id = Number(parts[1]);
      if (!Number.isInteger(id)) return ctx.you(socket, "Usage: /fight [banditId]");
      b = (await dbq("SELECT * FROM npcs_bandits WHERE id=$1 AND room_id=$2 AND alive=TRUE", [id, r.id]))[0];
      if (!b) return ctx.you(socket, "No such bandit here.");
    } else {
      b = (await dbq("SELECT * FROM npcs_bandits WHERE room_id=$1 AND alive=TRUE ORDER BY id LIMIT 1", [r.id]))[0];
      if (!b) return ctx.you(socket, "No bandits in this grid.");
    }

    // simple roll: player vs bandit power; effects can be added later
    const rollP = Math.ceil(Math.random()*100) + Math.floor(((me.hunger||50) - 50)/2);
    const rollB = Math.ceil(Math.random()*100) + Math.floor((b.power - 50)/2);
    ctx.sys(me.room, `${me.username} engages Bandit #${b.id}! (A:${rollP} vs B:${rollB})`);

    if (rollP >= rollB) {
      // kill
      await dbq("UPDATE npcs_bandits SET hp=0, alive=FALSE WHERE id=$1", [b.id]);
      await dbq("UPDATE players SET gold=gold+$1 WHERE id=$2", [b.reward, me.id]);
      ctx.sys(me.room, `${me.username} defeated Bandit #${b.id} and earned ${b.reward}g!`);
    } else {
      // fail = hunger drain + Exhausted
      const newH = Math.max(1, (me.hunger||100) - 12);
      await dbq("UPDATE players SET hunger=$1 WHERE id=$2", [newH, me.id]);
      await addEffect(me.id, "Exhausted", 1, 90);
      ctx.sys(me.room, `${me.username} failed to subdue Bandit #${b.id} and is exhausted (-12 hunger).`);
    }
    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sendState(socket, me2);
  }, "[id] — fight a bandit in this grid");
}

function fmtTTL(interval) {
  // PG interval-ish -> rough minutes
  try {
    const s = typeof interval === "string" ? interval : (interval?.toString?.() || "");
    const m = s.match(/(\d+):(\d+):/);
    if (m) {
      const mins = Number(m[1])*60 + Number(m[2]);
      return `${Math.max(1, Math.floor(mins))}m`;
    }
  } catch {}
  return "soon";
}

module.exports = { initWorldJobsFeature };
