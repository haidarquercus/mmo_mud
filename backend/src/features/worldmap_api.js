// src/features/worldmap_api.js
const { dbq } = require("../db");

// Terrain to a compact code (frontend will color)
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
  // pull every room that participates in the world grid
  const rooms = await dbq(
    `SELECT id, name, world_x, world_y, terrain, is_ocean, owner_player_id
       FROM rooms
      WHERE world_x IS NOT NULL AND world_y IS NOT NULL
      ORDER BY world_y, world_x`, []
  );
  if (!rooms.length) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const r of rooms) {
    minX = Math.min(minX, r.world_x); maxX = Math.max(maxX, r.world_x);
    minY = Math.min(minY, r.world_y); maxY = Math.max(maxY, r.world_y);
  }

  // cells indexed by (y, x)
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cells = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ t: "void" })));
  const labels = [];

  for (const r of rooms) {
    const x = r.world_x - minX;
    const y = r.world_y - minY;
    const t = r.is_ocean ? "ocean" : terrainCode(r.terrain);
    cells[y][x] = { t };

    // label rule: Capital always; any room with owner_player_id (LocalLord/King town) shows its name
    const mustLabel = (r.name === "Capital") || !!r.owner_player_id;
    if (mustLabel) {
      labels.push({ x, y, name: r.name });
    }
  }

  return { width, height, minX, minY, cells, labels };
}

function initWorldMapApi(app) {
  // JSON endpoint (lightweight) used by frontend canvas
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
