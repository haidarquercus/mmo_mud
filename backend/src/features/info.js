// src/features/info.js
const { dbq } = require("../db");
const { register, helpLines } = require("../core/commands");
const { effectsSummary } = require("./status");

function fmtPlayerLine(p, effText){
  const w = p.wanted ? " [WANTED]" : "";
  return `${p.username}${w} — Role: ${p.role || "Peasant"} — G:${p.gold||0} F:${p.food||0} M:${p.meat||0} W:${p.wood||0} S:${p.stone||0} — Hunger:${p.hunger||0} — Effects: ${effText}`;
}

function initInfoFeature(_registry) {
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

  register("/stats", async (ctx, socket) => {
    const p = await ctx.getPlayer(socket, true);
    ctx.sendState(socket, p);
    const eff = await effectsSummary(p.id);
    ctx.you(socket, fmtPlayerLine(p, eff));
  }, " — show your stats + status");

  register("/who", async (ctx, socket) => {
    const p = await ctx.getPlayer(socket);
    const ps = await dbq("SELECT username, wanted FROM players WHERE room=$1 AND socket_id IS NOT NULL", [p.room]);
    if (!ps.length) return ctx.you(socket, "Nobody here.");
    ctx.you(socket, `Here: ${ps.map(x => x.username + (x.wanted ? " [WANTED]" : "")).join(", ")}`);
  }, " — list players in room");

  register("/bounties", async (ctx, socket) => {
    const rows = await dbq(
      `SELECT b.amount, b.reason, p.username
         FROM bounties b JOIN players p ON p.id=b.target_id
        WHERE b.active=true ORDER BY b.amount DESC LIMIT 10`, []
    );
    if (!rows.length) return ctx.you(socket, "No active bounties.");
    rows.forEach(r => ctx.you(socket, `[${r.username}] bounty: ${r.amount} (${r.reason})`));
  }, " — top bounties");

  register("/inspect", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    const name = parts[1];
    if (!name) return ctx.you(socket, "Usage: /inspect Name");
    const ts = await dbq(
      "SELECT * FROM players WHERE room=$1 AND socket_id IS NOT NULL AND username ILIKE $2",
      [me.room, name + "%"]
    );
    if (ts.length === 0) return ctx.you(socket, "No such player here.");
    if (ts.length > 1) return ctx.you(socket, "Ambiguous name.");
    const t = ts[0];
    const eff = await effectsSummary(t.id);
    ctx.you(socket, fmtPlayerLine(t, eff));
  }, "Name — see someone’s role/stats/status (same room)");
}

module.exports = { initInfoFeature };
