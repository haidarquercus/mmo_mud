// src/features/chat.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

// prefix lookup (same-room whisper targeting handled elsewhere if you want)
async function findTarget(prefix) {
  return await dbq(
    "SELECT * FROM players WHERE socket_id IS NOT NULL AND username ILIKE $1",
    [prefix + "%"]
  );
}

function initChatFeature(registry) {
  // /public → explicit local chat (room broadcast)
  register("/public", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const msg = parts.slice(1).join(" ").trim();
    if (!msg) return ctx.you(socket, "Usage: /public message");
    ctx.io.to(me.room).emit("chat", `${me.username}: ${msg}`);
  }, "message — talk to everyone in the room");

  // /say → alias of /public
  register("/say", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const msg = parts.slice(1).join(" ").trim();
    if (!msg) return ctx.you(socket, "Usage: /say message");
    ctx.io.to(me.room).emit("chat", `${me.username}: ${msg}`);
  }, "message — talk to everyone in the room");

  // /w Name msg → whisper
  register("/w", async (ctx, socket, parts) => {
    const targetPrefix = parts[1];
    const msg = parts.slice(2).join(" ").trim();
    if (!targetPrefix || !msg) return ctx.you(socket, "Usage: /w Name message");

    const matches = await findTarget(targetPrefix);
    if (matches.length === 0) return ctx.you(socket, "No such player online.");
    if (matches.length > 1) return ctx.you(socket, "Ambiguous name.");

    const target = matches[0];
    const ts = ctx.socketOf(target);
    if (!ts) return ctx.you(socket, "Player went offline.");

    const me = await ctx.getPlayer(socket, true);
    ctx.you(socket, `(to ${target.username}) ${msg}`);
    ctx.you(ts, `(from ${me.username}) ${msg}`);
  }, "Name message — private message");
}

module.exports = { initChatFeature };
