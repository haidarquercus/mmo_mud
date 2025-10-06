// src/features/cheat.js
// Hidden dev command. Enabled only when ALLOW_CHEAT=1 or NODE_ENV !== 'production'.
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { giveTool, TOOL } = require("./inventory");

const COLS = new Set(["gold","food","fruit","meat","wood","stone"]);

function cheatsEnabled() {
  return process.env.ALLOW_CHEAT === "1" || (process.env.NODE_ENV || "").toLowerCase() !== "production";
}

// turn "fruit" into the DB column "food"
function canonRes(k) { return (k || "").toLowerCase() === "fruit" ? "food" : (k || "").toLowerCase(); }

function initCheatFeature(_registry) {
  // IMPORTANT: no help/description argument, so it won't be listed in /help
  register("/cheat", async (ctx, socket, parts) => {
    if (!cheatsEnabled()) {
      // Make it look like it doesn’t exist in production.
      return ctx.you(socket, "Unknown command.");
    }

    const me = await ctx.getPlayer(socket, true);

    // Variants:
    //   /cheat                 -> +1000 to gold, food, meat, wood, stone
    //   /cheat all             -> same as above
    //   /cheat tools           -> +1 Wooden Bow, +1 Stone Pickaxe
    //   /cheat <res> <amt>     -> e.g. /cheat wood 500   (res in gold|food|fruit|meat|wood|stone)
    const sub = (parts[1] || "").toLowerCase();

    if (!sub || sub === "all") {
      const inc = { gold:1000, food:1000, meat:1000, wood:1000, stone:1000 };
      const sets = [];
      const vals = [];
      let i = 1;
      for (const k of Object.keys(inc)) {
        sets.push(`${k} = COALESCE(${k},0) + $${i++}`);
        vals.push(inc[k]);
      }
      vals.push(me.id);
      await dbq(`UPDATE players SET ${sets.join(", ")} WHERE id=$${i}`, vals);
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1",[me.id]))[0];
      ctx.you(socket, "Cheat applied: +1000 gold, food, meat, wood, stone.");
      return ctx.sendState(socket, me2);
    }

    if (sub === "tools") {
      await giveTool(me.id, "bow");
      await giveTool(me.id, "pickaxe");
      const me2 = (await dbq("SELECT * FROM players WHERE id=$1",[me.id]))[0];
      ctx.you(socket, `Cheat applied: +1 ${TOOL.bow.name}, +1 ${TOOL.pickaxe.name}.`);
      return ctx.sendState(socket, me2);
    }

    // /cheat <res> <amt>
    const res = canonRes(sub);
    const amt = Number(parts[2]);
    if (!COLS.has(res) || !Number.isFinite(amt)) {
      return ctx.you(socket, "Usage: /cheat [all|tools|gold|food|fruit|meat|wood|stone] [amount]");
    }
    await dbq(`UPDATE players SET ${res} = COALESCE(${res},0) + $1 WHERE id=$2`, [amt, me.id]);
    const me2 = (await dbq("SELECT * FROM players WHERE id=$1",[me.id]))[0];
    ctx.you(socket, `Cheat applied: +${amt} ${res === "food" ? "fruit" : res}.`);
    return ctx.sendState(socket, me2);
  });
}

module.exports = { initCheatFeature };
