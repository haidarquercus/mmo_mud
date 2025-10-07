// src/features/info.js
const { dbq } = require("../db");
const { register, helpLines } = require("../core/commands");
const { effectsSummary } = require("./status");

function fmtPlayerLine(p, effText) {
  const w = p.wanted ? " [WANTED]" : "";
  return `${p.username}${w} — Role: ${p.role || "Peasant"} — G:${p.gold || 0} F:${p.food || 0} M:${p.meat || 0} W:${p.wood || 0} S:${p.stone || 0} — Hunger:${p.hunger || 0} — Effects: ${effText}`;
}

function initInfoFeature(_registry) {
  // /help
  register("/help", async (ctx, socket) => {
    const base = (typeof helpLines === "function" ? helpLines() : []) || [];
    for (const l of base) ctx.you(socket, l);
    [
      "— Core —",
      "/stats · /status · /who · /bounties · /inspect Name",
      "/w Name msg · /pay Name amount · /give Name food|fruit|meat|wood|stone qty",
      "— Survival / Gear —",
      "/gather fruit · /hunt (bow) · /mine (pickaxe) · /eat fruit|meat",
      "/inventory · /craft bow|pickaxe · /buy bow|pickaxe",
      "— Market —",
      "/sell wood|stone|fruit|meat n  (≤10g untaxed; treasury floors may buy a portion)",
      "/settax % · /setprice item price · /setfloor res price · /setquota res amount · /fund amount",
      "— Settlement —",
      "/travel Room · /settle x y · /where · /uphome [hut|house|manor]",
      "— Jobs —",
      "/jobs · /accept id · /myjob · /deliver · /abandon",
      "— Social / Combat —",
      "/attack Name",
    ].forEach(l => ctx.you(socket, l));
  });

  // /stats
  register("/stats", async (ctx, socket) => {
    const p = await ctx.getPlayer(socket, true);
    if (!p) return ctx.you(socket, "Reattach failed — please reload.");
    const eff = await effectsSummary(p.id);
    ctx.sendState(socket, p);
    ctx.you(socket, fmtPlayerLine(p, eff));
  }, " — show your stats + status");

  // 🏰 /who with pretty output
  register("/who", async (ctx, socket) => {
    const p = await ctx.getPlayer(socket);
    if (!p) return ctx.you(socket, "Reattach failed — please reload.");
    if (!p.room) return ctx.you(socket, "You are not in a room.");

    const ps = await dbq(
      "SELECT username, wanted, role FROM players WHERE room=$1 AND socket_id IS NOT NULL ORDER BY username ASC",
      [p.room]
    );
    if (!ps.length) return ctx.you(socket, `🏰 ${p.room}: (no one here)`);

    let lines = [`🏰 ${p.room}:`];
    for (const x of ps) {
      const tag = x.role && x.role !== "Peasant" ? ` (${x.role})` : "";
      const mark = x.wanted ? " [WANTED]" : "";
      lines.push(`- ${x.username}${tag}${mark}`);
    }
    lines.forEach(l => ctx.you(socket, l));
  }, " — list players in room");

  // /bounties
  register("/bounties", async (ctx, socket) => {
    const rows = await dbq(
      `SELECT b.amount, b.reason, p.username
         FROM bounties b JOIN players p ON p.id=b.target_id
        WHERE b.active=true ORDER BY b.amount DESC LIMIT 10`, []
    );
    if (!rows.length) return ctx.you(socket, "No active bounties.");
    ctx.you(socket, "🎯 Top Bounties:");
    rows.forEach(r => ctx.you(socket, `- ${r.username}: ${r.amount} (${r.reason})`));
  }, " — top bounties");

  // /inspect
  register("/inspect", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");
    if (!me.room) return ctx.you(socket, "You are not in a room.");

    const name = parts[1];
    if (!name) return ctx.you(socket, "Usage: /inspect Name");

    const ts = await dbq(
      "SELECT * FROM players WHERE room=$1 AND socket_id IS NOT NULL AND username ILIKE $2",
      [me.room, name + "%"]
    );
    if (!ts.length) return ctx.you(socket, "No such player here.");
    if (ts.length > 1) return ctx.you(socket, "Ambiguous name.");

    const t = ts[0];
    const eff = await effectsSummary(t.id);
    ctx.you(socket, fmtPlayerLine(t, eff));
  }, "Name — see someone’s role/stats/status (same room)");

  // 🧭 /where — nice output
  register("/where", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket);
    if (!me) return ctx.you(socket, "Reattach failed — please reload.");

    const home = await dbq(
      "SELECT room_name, tile_x, tile_y FROM homes WHERE player_id=$1 LIMIT 1",
      [me.id]
    );

    if (home.length) {
      const h = home[0];
      return ctx.you(socket, `🏡 Home: ${h.room_name} [${h.tile_x ?? "?"}, ${h.tile_y ?? "?"}]`);
    }

    const room = me.room || "Unknown";
    ctx.you(socket, `📍 You are currently in ${room}.`);
  }, " — show your current room or home coordinates");
}

module.exports = { initInfoFeature };
