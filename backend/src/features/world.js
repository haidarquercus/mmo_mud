// backend/src/features/world.js
const express = require("express");
const { dbq } = require("../db");

/**
 * API
 *  POST /api/world/generate?seed=kingdom&size=256&force=0|1
 *  GET  /api/world/meta
 *  GET  /api/world/grid   -> { ok, meta, cells:[{x,y,biome,lq}], towns:[...] }
 *  GET  /api/world/towns  -> [{name,x,y,is_capital,owner,pop}]
 *  GET  /api/world/playerpos?u=Username -> { ok, exists, room, x, y, isTown, is_capital }
 */

function nowIso() { return new Date().toISOString(); }

// ---------- harden schema at runtime ----------
async function ensureWorldCellsColumns() {
  // Keep both quality columns in sync
  await dbq("ALTER TABLE world_cells ADD COLUMN IF NOT EXISTS living_quality INT", []);
  await dbq("ALTER TABLE world_cells ADD COLUMN IF NOT EXISTS lq INT", []);
  // Elevation column (some DBs have NOT NULL constraint already)
  await dbq("ALTER TABLE world_cells ADD COLUMN IF NOT EXISTS elev REAL", []);

  // One-time backfill both ways for LQ
  await dbq("UPDATE world_cells SET living_quality = COALESCE(living_quality, lq)", []);
  await dbq("UPDATE world_cells SET lq = COALESCE(lq, living_quality)", []);

  // Backfill elev for any legacy rows (invert the earlier LQ transform: ~ (lq+20)/100)
  await dbq(
    "UPDATE world_cells SET elev = COALESCE(elev, GREATEST(0, LEAST(1, (COALESCE(living_quality,0) + 20) / 100.0)))",
    []
  );
}
// ---------------------------------------------

async function worldMeta() {
  const m = await dbq("SELECT seed, width, height, created_at FROM world_meta LIMIT 1", []);
  return m[0] || null;
}

async function setWorldMeta(seed, width, height) {
  await dbq("TRUNCATE world_meta RESTART IDENTITY", []);
  await dbq(
    "INSERT INTO world_meta (seed, width, height, created_at) VALUES ($1,$2,$3,$4)",
    [seed, width, height, nowIso()]
  );
}

async function generateCells(seed, size, force) {
  await ensureWorldCellsColumns();

  const existing = await dbq("SELECT COUNT(*)::int AS n FROM world_cells", []);
  if (existing[0].n > 0 && !force) return;

  await dbq("TRUNCATE world_cells RESTART IDENTITY", []);

  // PRNG + simple fbm for an island map
  function sfc32(a,b,c,d){return function(){a|=0;b|=0;c|=0;d|=0;var t=(a+b|0)+d|0;d=d+1|0;a=b^b>>>9;b=c+(c<<3)|0;c=(c<<21|c>>>11);c=c+t|0;return (t>>>0)/4294967296;};}
  function strHash(s){let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
  const seedInt = strHash(String(seed));
  const rng = sfc32(seedInt, seedInt^0x9e3779b9, seedInt^0x85ebca6b, seedInt^0xc2b2ae35);

  function noise2(x,y){const n=Math.sin((x*0.061+13.37)*(y*0.053+7.17))*43758.5453;return n-Math.floor(n);}
  function fbm(x,y){let v=0,a=0.5,f=0.01;for(let i=0;i<5;i++){v+=a*noise2(x*f,y*f);a*=0.5;f*=2.0;}return v;}

  const w=size, h=size, cx=(w-1)/2, cy=(h-1)/2;
  const rows=[];
  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const dx=(x-cx)/w, dy=(y-cy)/h;
      const r=Math.sqrt(dx*dx+dy*dy);
      const island=Math.max(0,1-(r*1.6));
      const elev=fbm(x,y)*island; // 0..~1

      let biome="ocean";
      if (elev>0.03 && elev<=0.08) biome="coast";
      else if (elev>0.08 && elev<=0.35) biome = (rng()<0.55?"plains":"forest");
      else if (elev>0.35 && elev<=0.6) biome = (rng()<0.6?"forest":"hills");
      else if (elev>0.6) biome="mountain";

      const lq=Math.round((elev*100)-20+(Math.floor(rng()*10)-5));
      rows.push([x,y,biome,elev,lq]);
    }
  }

  // Write elev + both quality columns
  const chunk=2000;
  for(let i=0;i<rows.length;i+=chunk){
    const slice=rows.slice(i,i+chunk);
    const vals=slice.map((_,k)=>`($${k*6+1},$${k*6+2},$${k*6+3},$${k*6+4},$${k*6+5},$${k*6+6})`).join(",");
    const flat=[];
    for (const [x,y,biome,elev,lq] of slice) flat.push(x,y,biome,elev,lq,lq);
    await dbq(`INSERT INTO world_cells (x,y,biome,elev,living_quality,lq) VALUES ${vals}`, flat);
  }

  await setWorldMeta(seed,w,h);
  await autoplaceCapital();
}

async function autoplaceCapital() {
  await ensureWorldCellsColumns();

  const cap = await dbq("SELECT id, name, world_x, world_y FROM rooms WHERE name='Capital' LIMIT 1", []);
  if (cap.length && cap[0].world_x!=null && cap[0].world_y!=null) return;

  const meta = await worldMeta(); if (!meta) return;

  const top = await dbq(
    `SELECT x,y,living_quality AS lq
       FROM world_cells
      WHERE biome <> 'ocean'
      ORDER BY living_quality DESC
      LIMIT 400`, []
  );
  if (!top.length) return;

  const cx=(meta.width-1)/2, cy=(meta.height-1)/2;
  let best=top[0], bestD=1e9;
  for (const c of top){ const d=Math.hypot(c.x-cx,c.y-cy); if (d<bestD){bestD=d; best=c;} }

  if (!cap.length){
    await dbq(
      `INSERT INTO rooms
        (name, terrain, living_quality, distance_from_capital, tax_rate, owner_player_id, world_x, world_y,
         price_food, price_meat, price_wood, price_stone, price_bow, price_pickaxe)
       VALUES ('Capital','plains',0,1,10,NULL,$1,$2, 1,3,1,2,20,25)`,
      [best.x,best.y]
    );
  } else {
    await dbq("UPDATE rooms SET world_x=$1, world_y=$2 WHERE id=$3", [best.x,best.y,cap[0].id]);
  }
}

async function roomsOverlay() {
  const rows = await dbq(
    `SELECT r.id, r.name, r.world_x AS x, r.world_y AS y,
            (r.name='Capital') AS is_capital,
            p.username AS owner,
            COALESCE(pop.n,0) AS pop
       FROM rooms r
  LEFT JOIN players p ON p.id = r.owner_player_id
  LEFT JOIN (SELECT room AS name, COUNT(*)::int AS n FROM players GROUP BY room) pop
         ON pop.name = r.name
      WHERE r.world_x IS NOT NULL AND r.world_y IS NOT NULL
      ORDER BY is_capital DESC, r.name`, []
  );
  return rows.map(r => ({
    id:r.id, name:r.name, x:r.x, y:r.y,
    is_capital: !!r.is_capital, owner: r.owner || null, pop: r.pop || 0
  }));
}

async function gridCells() {
  await ensureWorldCellsColumns();

  const meta = await worldMeta();
  if (!meta) return { meta:null, cells:[], towns:[] };

  const cells = await dbq(
    "SELECT x,y,biome,living_quality AS lq FROM world_cells ORDER BY y,x", []
  );
  const towns = await roomsOverlay();
  return { meta, cells, towns };
}

// ---- NEW: current player's room position (by username) ----
async function playerPos(username) {
  if (!username) return { exists:false };
  const r = await dbq(
    `SELECT p.username, p.room, r.world_x AS x, r.world_y AS y, (r.name='Capital') AS is_capital
       FROM players p
  LEFT JOIN rooms r ON r.name = p.room
      WHERE p.username = $1
      LIMIT 1`,
    [username]
  );
  if (!r.length) return { exists:false };
  const row = r[0];
  const isTown = row.x !== null && row.y !== null;
  return {
    exists: true,
    room: row.room,
    x: row.x,
    y: row.y,
    isTown,
    is_capital: !!row.is_capital
  };
}

function initWorldFeature(arg) {
  // Accept either app or { app }
  const app = (arg && arg.use) ? arg : (arg && arg.app) ? arg.app : null;
  if (!app || typeof app.use !== "function") {
    throw new Error("initWorldFeature(app): expected Express app or { app }");
  }

  const api = express.Router();

  api.post("/generate", async (req, res) => {
    if (process.env.ADMIN_TOKEN) {
      if (req.get("x-admin-token") !== process.env.ADMIN_TOKEN) {
        return res.status(403).json({ ok:false, error:"forbidden" });
      }
    }
    try {
      const url = new URL(req.protocol + "://" + req.get("host") + req.originalUrl);
      const seed = url.searchParams.get("seed") || "kingdom";
      const size = Math.max(32, Math.min(512, Number(url.searchParams.get("size") || 256)));
      const force = Number(url.searchParams.get("force") || 0) === 1;

      await generateCells(seed, size, force);
      const meta = await worldMeta();
      res.json({ ok:true, meta });
    } catch (e) {
      console.error("world/generate", e);
      res.status(500).json({ ok:false, error:e.message });
    }
  });

  api.get("/meta", async (_req, res) => {
    const meta = await worldMeta();
    res.json({ ok: !!meta, meta });
  });

  api.get("/grid", async (_req, res) => {
    try {
      const out = await gridCells();
      res.json({ ok:true, ...out });
    } catch (e) {
      console.error("world/grid", e);
      res.status(500).json({ ok:false, error:e.message });
    }
  });

  api.get("/towns", async (_req, res) => {
    try {
      const t = await roomsOverlay();
      res.json({ ok:true, towns:t });
    } catch (e) {
      res.status(500).json({ ok:false, error:e.message });
    }
  });

  // NEW: player position by username (map page reads username from localStorage)
  api.get("/playerpos", async (req, res) => {
    try {
      const u = String(req.query.u || req.query.user || "").trim();
      if (!u) return res.json({ ok:false, error:"missing user" });
      const pos = await playerPos(u);
      res.json({ ok:true, ...pos });
    } catch (e) {
      res.status(500).json({ ok:false, error:e.message });
    }
  });

  app.use("/api/world", api);
}

async function regenerateWorldIfEmpty() {
  const rows = await dbq("SELECT COUNT(*) FROM world_cells", []);
  const count = parseInt(rows[0].count || 0);
  if (count === 0) {
    console.log("[WORLD] Regenerating initial grid...");
    await generateWorld({ width: 40, height: 40 });
  }
}

module.exports = { initWorldFeature, generateWorld, regenerateWorldIfEmpty };

