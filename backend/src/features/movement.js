// src/features/movement.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

function initMovementFeature(registry) {
  register("/travel", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket);
    const targetRoom = parts[1];
    if (!targetRoom) return ctx.you(socket, "Usage: /travel RoomName");
    socket.leave(me.room);
    ctx.sys(me.room, `${me.username} left for ${targetRoom}`);
    const target = await ctx.ensureRoom(targetRoom);
    await dbq("UPDATE players SET room=$1 WHERE id=$2", [target.name, me.id]);
    socket.join(target.name);
    ctx.sys(target.name, `${me.username} arrived.`);
    const me2 = (await dbq("SELECT * FROM players WHERE id=$1",[me.id]))[0];
    ctx.sendState(socket, me2);
  }, "RoomName — move to another room");
}

module.exports = { initMovementFeature };
