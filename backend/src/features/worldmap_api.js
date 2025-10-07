// src/features/worldmap_api.js
const { dbq } = require("../db");

function terrainCode(t) {
  const k = (t || "plains").toLowerCase();
  if (k.includes("ocean") || k.includes("water")) return "ocean";
  if (k.includes("mountain")) return "mountain";
  if (k.includes("forest")) return "forest";
  if (k.includes("hills")) return "hills";
  if (k.includes("desert")) return "desert";
  return "plains";
}

async function getWorldGrid() {
  const meta = (await dbq("SELECT width, height FROM world_meta LIMIT 1", []))[0];
  if (!meta) return null;

  const cells = await dbq(
    "SELECT x,y,biome,living_quality AS lq FROM world_cells ORDER BY y,x", []
  );

  const towns = await dbq(
    `SELECT name, world_x AS x, world_y AS y, owner_player_id,
            (name='Capital') AS is_capital
       FROM rooms
      WHERE world_x IS NOT NULL AND world_y IS NOT NULL`, []
  );

  const width = meta.width, height = meta.height;
  const grid = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ t: "ocean" }))
  );

  for (const c of cells) {
    grid[c.y][c.x] = { t: terrainCode(c.biome) };
  }

  const labels = towns.map(t => ({
    x: t.x, y: t.y, name: t.name,
    color: t.is_capital ? "yellow" : "purple"
  }));

  return { width, height, cells: grid, labels };
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
