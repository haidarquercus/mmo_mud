// backend/server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const { dbq } = require("./src/db");
const { register, dispatch } = require("./src/core/commands");
const util = require("./src/core/util");

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Game server running on http://${HOST}:${PORT}`);
});

// ---- optional middlewares (won’t crash if not installed)
function optRequire(name) {
  try { return require(name); }
  catch { console.warn(`[opt] ${name} not installed — continuing without it`); return null; }
}
const compression = optRequire("compression"); // npm i compression
const helmet = optRequire("helmet");           // npm i helmet (optional security)

// --- Features (status shim) ---
const statusFeature = require("./src/features/status");
if (typeof statusFeature.effectsSummary !== "function") {
  statusFeature.effectsSummary = async () => "";
}
const { initStatusFeature } = statusFeature;

const { initInfoFeature } = require("./src/features/info");
const { initChatFeature } = require("./src/features/chat");
const { initEconomyFeature } = require("./src/features/economy");
const { initMovementFeature } = require("./src/features/movement");
const { initSettlementFeature } = require("./src/features/settlement");
const { initSurvivalFeature } = require("./src/features/survival");
const { initCombatFeature } = require("./src/features/combat");
const { initRolesFeature } = require("./src/features/roles");
const { initInventoryFeature } = require("./src/features/inventory");
const { initMarketFeature } = require("./src/features/market");
const { initMarketMakerFeature } = require("./src/features/market_maker");
const { initJobsFeature } = require("./src/features/jobs");
const { initCheatFeature } = require("./src/features/cheat");
const { initWorldFeature } = require("./src/features/world");
const { initWorldJobsFeature } = require("./src/features/world_jobs");
const { initWorldMapApi } = require("./src/features/worldmap_api");
const { initBuildingsFeature } = require("./src/features/buildings");

const app = express();
if (helmet) app.use(helmet({ contentSecurityPolicy: false }));
if (compression) app.use(compression());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  allowEIO3: true,
});

app.use(express.static(path.resolve(__dirname, "../frontend")));
app.use(express.json());

// --------------------------------------------------------------
// Context shared with features
// --------------------------------------------------------------
const ctx = {
  io,
  dbq,
  sys: (room, msg) => util.sys(io, room, msg),
  you: util.you,
  socketOf: (p) => util.socketOf(io, p),
  ensureRoom: util.ensureRoom,
  roomByName: util.roomByName,
  ensureTile: util.ensureTile,
  sendState: util.sendState,
  effectsSummary: statusFeature.effectsSummary,
  getPlayer: async (socket, refresh = false) => {
    let p = (await dbq("SELECT * FROM players WHERE socket_id=$1", [socket.id]))[0] || null;
    if (!p || refresh) p = (await dbq("SELECT * FROM players WHERE socket_id=$1", [socket.id]))[0] || null;
    return p;
  },
  respawn: require("./src/core/player").respawnAsPeasant,
};
ctx.sys.bind(null); // silence linter

// --------------------------------------------------------------
// Dev helpers
// --------------------------------------------------------------
async function devCleanupOrphans() {
  try {
    await dbq("ALTER TABLE players ADD COLUMN IF NOT EXISTS token TEXT UNIQUE", []);
    await dbq("ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ DEFAULT NOW()", []);
    await dbq("DELETE FROM homes WHERE player_id IN (SELECT id FROM players WHERE token IS NULL)", []);
    await dbq("DELETE FROM players WHERE token IS NULL AND socket_id IS NULL", []);
  } catch (e) { console.warn("devCleanupOrphans:", e.message); }
}

// --------------------------------------------------------------
// Dev reset: wipe players/settlements/markets/jobs; keep world grid & Capital
// --------------------------------------------------------------
async function devResetEverythingButWorld() {
  console.log("[DEV_RESET] wiping players/settlements/markets/jobs; keeping world grid…");

  async function hasTable(qualified) {
    const r = await dbq("SELECT to_regclass($1) AS r", [qualified]);
    return !!r[0]?.r;
  }

  await dbq("BEGIN", []);
  try {
    await dbq("SET CONSTRAINTS ALL DEFERRED", []);

    if (await hasTable("public.world_jobs"))     await dbq("DELETE FROM public.world_jobs", []);
    if (await hasTable("public.jobs"))           await dbq("DELETE FROM public.jobs", []);
    if (await hasTable("public.market_makers"))  await dbq("DELETE FROM public.market_makers", []);
    if (await hasTable("public.room_stock"))     await dbq("DELETE FROM public.room_stock", []);
    if (await hasTable("public.homes"))          await dbq("DELETE FROM public.homes", []);
    if (await hasTable("public.players"))        await dbq("DELETE FROM public.players", []);

    if (await hasTable("public.rooms")) {
      await dbq("DELETE FROM public.rooms WHERE name <> 'Capital'", []);
    }

    if (await hasTable("public.world_jobs"))     await dbq("ALTER SEQUENCE IF EXISTS world_jobs_id_seq RESTART WITH 1", []);
    if (await hasTable("public.jobs"))           await dbq("ALTER SEQUENCE IF EXISTS jobs_id_seq RESTART WITH 1", []);
    if (await hasTable("public.market_makers"))  await dbq("ALTER SEQUENCE IF EXISTS market_makers_id_seq RESTART WITH 1", []);
    if (await hasTable("public.room_stock"))     await dbq("ALTER SEQUENCE IF EXISTS room_stock_id_seq RESTART WITH 1", []);
    if (await hasTable("public.homes"))          await dbq("ALTER SEQUENCE IF EXISTS homes_id_seq RESTART WITH 1", []);
    if (await hasTable("public.players"))        await dbq("ALTER SEQUENCE IF EXISTS players_id_seq RESTART WITH 1", []);

    if (await hasTable("public.rooms")) {
      const cap = await dbq("SELECT 1 FROM rooms WHERE name='Capital' LIMIT 1", []);
      if (!cap.length) {
        await dbq(
          `INSERT INTO rooms
             (name, terrain, living_quality, distance_from_capital, tax_rate, owner_player_id,
              world_x, world_y, price_food, price_meat, price_wood, price_stone, price_bow, price_pickaxe)
           VALUES ('Capital','plains',0,1,10,NULL,NULL,NULL,1,3,1,2,20,25)`, []
        );
      }
    }

    await dbq("COMMIT", []);
  } catch (e) {
    await dbq("ROLLBACK", []);
    throw e;
  }
}

// Run light cleanup every boot; only reset when asked
devCleanupOrphans();
if (process.env.DEV_RESET === "1") {
  devResetEverythingButWorld().catch(console.error);
}

// --------------------------------------------------------------
// Register features
// --------------------------------------------------------------
initInfoFeature({ register });
initChatFeature({ register });
initEconomyFeature({ register });
initMovementFeature({ register });
initSettlementFeature(ctx);
initSurvivalFeature(ctx);
initStatusFeature({ register });
initCombatFeature({ register });
initRolesFeature({ register });
initInventoryFeature({ register });
initMarketFeature({ register });
initMarketMakerFeature({ register });
initJobsFeature({ register, io });
initCheatFeature({ register });
initWorldFeature({ app, register });
initWorldJobsFeature({ register, io });
initWorldMapApi(app);
initBuildingsFeature({ register });

// --------------------------------------------------------------
// Minimal metrics
// --------------------------------------------------------------
let METRICS = { cmds: 0, errs: 0, times: [] };
function record(ms, ok = true) {
  METRICS.cmds++; if (!ok) METRICS.errs++; METRICS.times.push(ms);
  if (METRICS.times.length > 5000) METRICS.times.shift();
}
function p95(a){ if(!a.length) return 0; const b=[...a].sort((x,y)=>x-y); const i=Math.max(0,Math.floor(b.length*0.95)-1); return b[i]??b[b.length-1]; }
setInterval(()=> {
  const mem=(process.memoryUsage().rss/1024/1024)|0;
  console.log(`[HEALTH] players=${io.engine.clientsCount} cmds=${METRICS.cmds} errs=${METRICS.errs} p95ms=${p95(METRICS.times)} rssMB=${mem}`);
  METRICS={cmds:0,errs:0,times:[]};
}, 30000);

// --------------------------------------------------------------
// Wire connection (TOKEN-BASED IDENTITY, with cookie fallback)
// --------------------------------------------------------------
io.on("connection", async (socket) => {
  try {
    // Read from auth, then query, then cookie
    const cookieHeader = socket.handshake?.headers?.cookie || "";
    const readCookie = (name) => {
      const parts = cookieHeader.split(";").map(s => s.trim());
      const prefix = name + "=";
      for (const p of parts) if (p.startsWith(prefix)) return decodeURIComponent(p.slice(prefix.length));
      return null;
    };

    const token =
      socket.handshake?.auth?.token ||
      socket.handshake?.query?.token ||
      readCookie("kmmoToken") ||
      null;

    const me = await require("./src/core/player").ensureByTokenOrCreate({ socketId: socket.id, token });

    const roomRow = await util.ensureRoom(me.room || "Capital");
    if (me.room !== roomRow.name) await dbq("UPDATE players SET room=$1 WHERE id=$2", [roomRow.name, me.id]);
    socket.join(roomRow.name);

    util.sys(io, roomRow.name, `${me.username} entered ${roomRow.name}`);
    util.sendState(socket, { ...me, room: roomRow.name, token: me.token });

    socket.on("chat", (msg) => io.to(roomRow.name).emit("chat", `${me.username}: ${msg}`));

    socket.on("command", async (raw) => {
      const t0 = Date.now();
      try { await dispatch(ctx, socket, raw); record(Date.now()-t0, true); }
      catch (e) { console.error("CMD", e); util.you(socket, "Command failed."); record(Date.now()-t0, false); }
    });

    socket.on("disconnect", async () => {
      await dbq("UPDATE players SET socket_id=NULL, last_seen=NOW() WHERE id=$1", [me.id]);
      util.sys(io, roomRow.name, `${me.username} disconnected.`);
    });
  } catch (e) {
    console.error("Connection error:", e);
    try { util.you(socket, "Server error on connect."); } catch {}
  }
});

// --------------------------------------------------------------
// Listen
// --------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1"; // set to "0.0.0.0" for LAN
server.listen(PORT, HOST, () => {
  console.log(`Game server running on http://${HOST}:${PORT}`);
});
