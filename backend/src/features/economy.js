// src/features/economy.js
const { dbq, withTx } = require("../db");
const { register } = require("../core/commands");

// allow fruit alias and meat
const RES = new Set(["food", "fruit", "meat", "wood", "stone"]);

async function findInRoom(prefix, room) {
  return await dbq(
    "SELECT * FROM players WHERE room=$1 AND socket_id IS NOT NULL AND username ILIKE $2",
    [room, prefix + "%"]
  );
}

function initEconomyFeature(registry) {
  register("/pay", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    const name = parts[1];
    const amt = Number(parts[2]);
    if (!name || !Number.isInteger(amt) || amt <= 0) return ctx.you(socket, "Usage: /pay Name amount");
    const m = await findInRoom(name, me.room);
    if (m.length !== 1) return ctx.you(socket, m.length ? "Ambiguous name." : "Target must be in the same room.");
    const t = m[0];
    if (t.id === me.id) return ctx.you(socket, "You cannot pay yourself.");

    await withTx(async (c) => {
      const sRow = (await c.query("SELECT id, gold FROM players WHERE id=$1 FOR UPDATE", [me.id])).rows[0];
      const rRow = (await c.query("SELECT id, gold FROM players WHERE id=$1 FOR UPDATE", [t.id])).rows[0];
      if (sRow.gold < amt) throw new Error("Insufficient gold.");
      await c.query("UPDATE players SET gold=gold-$1 WHERE id=$2", [amt, sRow.id]);
      await c.query("UPDATE players SET gold=gold+$1 WHERE id=$2", [amt, rRow.id]);
    }).catch((e) => {
      ctx.you(socket, e.message || "Payment failed.");
      throw e;
    });

    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    const ts = ctx.socketOf(t);
    if (ts) ctx.you(ts, `${me.username} paid you ${amt} gold.`);
    ctx.sys(me.room, `${me.username} paid ${t.username} ${amt} gold.`);
    ctx.sendState(socket, me2);
  }, "Name amount — pay gold (same room)");

  register("/give", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    const name = parts[1];
    let res = (parts[2] || "").toLowerCase();
    const qty = Number(parts[3]);

    if (!name || !RES.has(res) || !Number.isInteger(qty) || qty <= 0) {
      return ctx.you(socket, "Usage: /give Name food|fruit|meat|wood|stone qty");
    }

    // normalize 'fruit' → 'food' to match players table column
    if (res === "fruit") res = "food";
    const m = await findInRoom(name, me.room);
    if (m.length !== 1) return ctx.you(socket, m.length ? "Ambiguous name." : "Target must be in the same room.");
    const t = m[0];
    if (t.id === me.id) return ctx.you(socket, "You cannot give to yourself.");

    await withTx(async (c) => {
      const sRow = (await c.query(`SELECT id, ${res} FROM players WHERE id=$1 FOR UPDATE`, [me.id])).rows[0];
      const rRow = (await c.query(`SELECT id, ${res} FROM players WHERE id=$1 FOR UPDATE`, [t.id])).rows[0];
      if (sRow[res] < qty) throw new Error("Not enough to give.");
      await c.query(`UPDATE players SET ${res}=${res}-$1 WHERE id=$2`, [qty, sRow.id]);
      await c.query(`UPDATE players SET ${res}=${res}+$1 WHERE id=$2`, [qty, rRow.id]);
    }).catch((e) => {
      ctx.you(socket, e.message || "Give failed.");
      throw e;
    });

    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sys(me.room, `${me.username} gave ${qty} ${res} to ${t.username}.`);
    ctx.sendState(socket, me2);

    const ts = ctx.socketOf(t);
    if (ts) {
      const t2 = (await dbq("SELECT * FROM players WHERE id=$1", [t.id]))[0];
      ctx.sendState(ts, t2);
      // enforce capacity for FOOD (berries) only
      if (res === "food" && ctx.enforceCapacity) await ctx.enforceCapacity(ts, t2);
    }
  }, "Name food|fruit|meat|wood|stone qty — give resources (same room)");
}

module.exports = { initEconomyFeature };
