// src/core/util.js
const { dbq } = require("../db");

function sys(io, room, msg) { io.to(room).emit("system", msg); }
function you(socket, msg) { socket.emit("you", msg); }

function socketOf(io, playerRow) {
  if (!playerRow?.socket_id) return null;
  return io.sockets.sockets.get(playerRow.socket_id) || null;
}

async function ensureRoom(name) {
  const r = await dbq("SELECT * FROM rooms WHERE name=$1", [name]);
  if (r.length) return r[0];
  return (await dbq(
    "INSERT INTO rooms (name, terrain, living_quality, distance_from_capital, tax_rate) VALUES ($1,'plains',0,1,12) RETURNING *",
    [name]
  ))[0];
}

async function roomByName(name) {
  return (await dbq("SELECT * FROM rooms WHERE name=$1", [name]))[0];
}

async function ensureTile(roomName, x, y) {
  const room = await roomByName(roomName);
  if (!room) throw new Error("Room missing");
  const t = await dbq("SELECT * FROM tiles WHERE room_id=$1 AND x=$2 AND y=$3", [room.id, x, y]);
  if (t.length) return t[0];
  const jitter = Math.floor(Math.random()*5) - 2;
  const lq = Math.max(-20, Math.min(20, (room.living_quality || 0) + jitter));
  return (await dbq(
    "INSERT INTO tiles (room_id, x, y, terrain, living_quality) VALUES ($1,$2,$3,'plains',$4) RETURNING *",
    [room.id, x, y, lq]
  ))[0];
}

function sendState(socket, p, extra={}) {
  socket.emit("state", {
    username: p.username, room: p.room, role: p.role, wanted: p.wanted,
    gold: p.gold, food: p.food, meat: p.meat, wood: p.wood, stone: p.stone, hunger: p.hunger,
    home_room: p.home_room, home_x: p.home_x, home_y: p.home_y, ...extra
  });
}

module.exports = { sys, you, socketOf, ensureRoom, roomByName, ensureTile, sendState };
