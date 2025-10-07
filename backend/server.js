// backend/server.js
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const { dbq } = require("./src/db");
const { register, dispatch } = require("./src/core/commands");
const util = require("./src/core/util");
const playerCore = require("./src/core/player");
const { regenerateWorldIfEmpty } = require("./src/features/world");

// --------------------------------------------------------------
// Boot world grid once at startup
// --------------------------------------------------------------
(async () => {
  try {
    await regenerateWorldIfEmpty();
    console.log("[BOOT] ✅ Verified world grid present.");
  } catch (e) {
    console.error("[BOOT] ❌ World bootstrap failed:", e);
  }
})();

// --------------------------------------------------------------
// Optional middlewares
// --------------------------------------------------------------
function optRequire(name) {
  try { return require(name); }
  catch { console.warn(`[opt] ${name} not installed — continuing without it`); return null; }
}
const compression = optRequire("compression");
const helmet = optRequire("helmet");

async function bootstrapWorld() {
  await dbq(`
    CREATE TABLE IF NOT EXISTS players (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      token TEXT UNIQUE,
      room TEXT DEFAULT 'Capital',
      role TEXT DEFAULT 'Peasant',
      gold INT DEFAULT 0,
      food INT DEFAULT 0,
      meat INT DEFAULT 0,
      wood INT DEFAULT 0,
      stone INT DEFAULT 0,
      hunger INT DEFAULT 100,
      wanted BOOLEAN DEFAULT false,
      socket_id TEXT,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await dbq(`
    INSERT INTO rooms (name, terrain, living_quality, distance_from_capital, tax_rate)
    VALUES ('Capital', 'plains', 0, 1, 10)
    ON CONFLICT (name) DO NOTHING;
  `);
}
bootstrapWorld().catch(console.error);

// --------------------------------------------------------------
// Feature initialization
// --------------------------------------------------------------
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

// --------------------------------------------------------------
// Express + Socket.IO setup
// --------------------------------------------------------------
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
    if (p && !refresh) return p;

    // Read cookie token safely
    const cookieHeader = socket.handshake?.headers?.cookie || "";
    const match = cookieHeader.match(/kmmoToken=([^;]+)/);
    const token = socket.handshake?.auth?.token || (match ? decodeURIComponent(match[1]) : null);

    if (token) {
      p = (await dbq("SELECT * FROM players WHERE token=$1", [token]))[0] || null;
    }
    return p;
  },

  respawn: playerCore.respawnAsPeasant,
};

// --------------------------------------------------------------
// Dev cleanup (orphans)
// --------------------------------------------------------------
async function devCleanupOrphans() {
  try {
    await dbq("DELETE FROM players WHERE token IS NULL AND socket_id IS NULL");
  } catch (e) {
    console.warn("devCleanupOrphans:", e.message);
  }
}
devCleanupOrphans();

// --------------------------------------------------------------
// Feature registration
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
function p95(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  const i = Math.max(0, Math.floor(b.length * 0.95) - 1);
  return b[i] ?? b[b.length - 1];
}
setInterval(() => {
  const mem = (process.memoryUsage().rss / 1024 / 1024) | 0;
  console.log(`[HEALTH] players=${io.engine.clientsCount} cmds=${METRICS.cmds} errs=${METRICS.errs} p95ms=${p95(METRICS.times)} rssMB=${mem}`);
  METRICS = { cmds: 0, errs: 0, times: [] };
}, 30000);

// --------------------------------------------------------------
// Connection Logic — unified token & reattach flow
// --------------------------------------------------------------
io.on("connection", async (socket) => {
  try {
    const cookieHeader = socket.handshake?.headers?.cookie || "";
    const match = cookieHeader.match(/kmmoToken=([^;]+)/);
    const token =
      socket.handshake?.auth?.token ||
      socket.handshake?.query?.token ||
      (match ? decodeURIComponent(match[1]) : null);

    let me = token ? await playerCore.findByToken(token) : null;

    // --- Fast reattach for returning players
    if (me) {
      await dbq("UPDATE players SET socket_id=$1, last_seen=NOW() WHERE id=$2", [socket.id, me.id]);
      me = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
      return proceed(me);
    }

    // --- New player flow
    util.you(socket, "Welcome, traveler. Choose your name (2–12 chars, start with a letter):");

    const timeout = setTimeout(() => {
      util.you(socket, "Session timed out — please reconnect.");
      socket.disconnect(true);
    }, 30000);

    socket.once("chat", async (name) => {
      clearTimeout(timeout);
      name = String(name || "").trim();

      if (!/^[A-Za-z][A-Za-z0-9 _-]{1,11}$/.test(name)) {
        util.you(socket, "Invalid name. Use 2–12 chars, start with a letter.");
        socket.disconnect(true);
        return;
      }

      try {
        const newToken = crypto.randomUUID?.() || crypto.randomBytes(16).toString("hex");
        const player = await playerCore.createWithName({
          socketId: socket.id,
          token: newToken,
          username: name,
        });
        proceed(player);
      } catch (e) {
        if (e.code === "23505") {
          util.you(socket, "That name is already taken. Please refresh and choose another.");
        } else {
          console.error("Player creation error:", e);
          util.you(socket, "Server error creating player.");
        }
        socket.disconnect(true);
      }
    });

    // --- Proceed with connected player
    async function proceed(player) {
      const roomRow = await util.ensureRoom(player.room || "Capital");
      if (player.room !== roomRow.name) {
        await dbq("UPDATE players SET room=$1 WHERE id=$2", [roomRow.name, player.id]);
      }

      socket.join(roomRow.name);
      util.sys(io, roomRow.name, `${player.username} entered ${roomRow.name}`);
      util.sendState(socket, { ...player, room: roomRow.name, token: player.token });

      socket.on("chat", (msg) =>
        io.to(roomRow.name).emit("chat", `${player.username}: ${msg}`)
      );

      socket.on("command", async (raw) => {
        const t0 = Date.now();
        try {
          await dispatch(ctx, socket, raw);
          record(Date.now() - t0, true);
        } catch (e) {
          console.error("CMD", e);
          util.you(socket, "Command failed.");
          record(Date.now() - t0, false);
        }
      });

      socket.on("disconnect", async () => {
        await dbq("UPDATE players SET socket_id=NULL, last_seen=NOW() WHERE id=$1", [player.id]);
        util.sys(io, roomRow.name, `${player.username} disconnected.`);
      });
    }
  } catch (e) {
    console.error("Connection error:", e);
    try { util.you(socket, "Server error on connect."); } catch {}
  }
});

// --------------------------------------------------------------
// Health check
// --------------------------------------------------------------
app.get("/healthz", (req, res) => res.json({ ok: true }));

// --------------------------------------------------------------
// Listen
// --------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  console.log(`Game server running on http://${HOST}:${PORT}`);
});
