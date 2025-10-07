// src/features/worldmap_api.js
const { dbq } = require("../db");

// Compact terrain codes for coloring
function terrainCode(t) {
  const k = (t || "plains").toLowerCase();
  if (k.includes("ocean") || k.includes("water")) return "ocean";
  if (k.includes("mountain")) return "mountain";
  if (k.includes("forest")) return "forest";
  if (k.includes("hills")) return "hills";
  if (k.includes("desert")) return "desert";
  if (k.includes("coast")) return "coast";
  return "plains";
}

// Visual radius for town “borders”
function influenceRadius(pop) {
  const p = Number(pop) || 0;
  const r = Math.sqrt(p) * 0.8; // tune multiplier as you like
  return Math.max(0, Math.round(r * 10) / 10);
}

// Cache schema capabilities (checked once, reused)
let CAPS = null;
async function ensureCaps() {
  if (CAPS) return CAPS;
  const rows = await dbq(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name IN ('jobs','bounties','players','rooms')`,
    []
  );
  const byTable = new Map();
  for (const r of rows) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
    byTable.get(r.table_name).add(r.column_name);
  }
  CAPS = {
    hasJobs: byTable.has("jobs"),
    jobsHasRoom: byTable.get("jobs")?.has("room") || false,
    jobsHasStatus: byTable.get("jobs")?.has("status") || false,
    hasBounties: byTable.has("bounties"),
  };
  return CAPS;
}

async function getWorldGrid() {
  await ensureCaps();

  // 1) Meta
  const meta = (await dbq("SELECT width, height FROM world_meta LIMIT 1", []))[0];
  if (!meta) return null;

  // 2) Cells
  const cells = await dbq("SELECT x,y,biome FROM world_cells ORDER BY y,x", []);
  const width = meta.width, height = meta.height;
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ t: "ocean" }))
  );
  for (const c of cells) grid[c.y][c.x] = { t: terrainCode(c.biome) };

  // 3) Base towns (coords + owner + pop)
  const townsBase = await dbq(
    `
    SELECT
      r.id,
      r.name,
      r.world_x AS x,
      r.world_y AS y,
      (r.name = 'Capital') AS is_capital,
      own.username AS owner,
      COALESCE(pop.n,0)::int AS pop
    FROM rooms r
    LEFT JOIN players own ON own.id = r.owner_player_id
    LEFT JOIN (
      SELECT room, COUNT(*)::int AS n
      FROM players
      GROUP BY room
    ) pop ON pop.room = r.name
    WHERE r.world_x IS NOT NULL AND r.world_y IS NOT NULL
    ORDER BY (r.name='Capital') DESC, r.name
    `,
    []
  );

  // 4) Optional jobs count (only if jobs.room/status exist)
  let jobsByRoom = new Map();
  if (CAPS.hasJobs && CAPS.jobsHasRoom) {
    const whereStatus = CAPS.jobsHasStatus ? "WHERE (status='open' OR status IS NULL)" : "";
    const jobRows = await dbq(
      `SELECT room, COUNT(*)::int AS n FROM jobs ${whereStatus} GROUP BY room`,
      []
    ).catch(() => []); // harden against odd schemas
    for (const r of jobRows) jobsByRoom.set(r.room, r.n);
  }

  // 5) Active bounties by room (you have bounties + target_id)
  let bntsByRoom = new Map();
  if (CAPS.hasBounties) {
    const bRows = await dbq(
      `
      SELECT p.room, COUNT(*)::int AS n
      FROM bounties b
      JOIN players p ON p.id = b.target_id
      WHERE b.active = true
      GROUP BY p.room
      `,
      []
    ).catch(() => []);
    for (const r of bRows) bntsByRoom.set(r.room, r.n);
  }

  // 6) Merge signals
  const towns = townsBase.map(t => {
    const active_jobs = jobsByRoom.get(t.name) || 0;
    const active_bounties = bntsByRoom.get(t.name) || 0;
    return {
      id: t.id,
      name: t.name,
      x: t.x,
      y: t.y,
      is_capital: !!t.is_capital,
      owner: t.owner || null,
      pop: t.pop,
      active_jobs,
      active_bounties,
      influence_radius: influenceRadius(t.pop),
    };
  });

  // 7) Back-compat labels (now enriched)
  const labels = towns.map(t => ({
    x: t.x, y: t.y, name: t.name,
    color: t.is_capital ? "yellow" : "purple",
    pop: t.pop,
    active_jobs: t.active_jobs,
    active_bounties: t.active_bounties,
  }));

  return { width, height, cells: grid, labels, towns };
}

function initWorldMapApi(app) {
  app.get("/api/worldmap.json", async (_req, res) => {
    try {
      const grid = await getWorldGrid();
      if (!grid) return res.status(404).json({ error: "world not generated" });
      res.json(grid);
    } catch (e) {
      console.error("[worldmap] api error:", e);
      res.status(500).json({ error: "internal" });
    }
  });
}

module.exports = { initWorldMapApi };
