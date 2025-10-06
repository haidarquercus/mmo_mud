// src/features/roles.js
const { dbq } = require("../db");
const { register } = require("../core/commands");

const ALLOWED = new Set(["peasant", "blacksmith", "locallord", "king"]);
function norm(r) {
  return r.charAt(0).toUpperCase() + r.slice(1).toLowerCase();
}

const INPUT_ALIAS = { fruit: "food" };
const FLOOR_COL = {
  food: "floor_fruit",
  meat: "floor_meat",
  wood: "floor_wood",
  stone: "floor_stone",
};
const QUOTA_COL = {
  food: "quota_fruit",
  meat: "quota_meat",
  wood: "quota_wood",
  stone: "quota_stone",
};

const MIN_CHEB_DIST = 3;

// ---------- helpers ----------
async function anyKingId() {
  const r = await dbq("SELECT id FROM players WHERE role='King' LIMIT 1", []);
  return r[0]?.id || null;
}
function canonRes(k) {
  return INPUT_ALIAS[(k || "").toLowerCase()] || (k || "").toLowerCase();
}

async function worldMeta() {
  const m = await dbq("SELECT width, height FROM world_meta LIMIT 1", []);
  return m[0] || null;
}
async function cellAt(x, y) {
  const r = await dbq(
    "SELECT x,y,biome,living_quality AS lq FROM world_cells WHERE x=$1 AND y=$2 LIMIT 1",
    [x, y]
  );
  return r[0] || null;
}
async function roomXY(name) {
  const r = await dbq(
    "SELECT world_x, world_y FROM rooms WHERE name=$1 LIMIT 1",
    [name]
  );
  if (r.length && r[0].world_x != null && r[0].world_y != null)
    return { x: r[0].world_x, y: r[0].world_y };
  return null;
}
async function capitalXY() {
  const r = await dbq(
    "SELECT world_x, world_y FROM rooms WHERE name='Capital' LIMIT 1",
    []
  );
  if (r.length && r[0].world_x != null && r[0].world_y != null)
    return { x: r[0].world_x, y: r[0].world_y };
  const m = await worldMeta();
  if (m) return { x: ((m.width - 1) / 2) | 0, y: ((m.height - 1) / 2) | 0 };
  return { x: 0, y: 0 };
}

async function hasSettlementWithinCheb(x, y, dist) {
  const rr = await dbq(
    `SELECT name, world_x AS x, world_y AS y
       FROM rooms
      WHERE world_x IS NOT NULL AND world_y IS NOT NULL
        AND world_x BETWEEN ($1::int - $3::int) AND ($1::int + $3::int)
        AND world_y BETWEEN ($2::int - $3::int) AND ($2::int + $3::int)
      LIMIT 1`,
    [x, y, dist]
  );
  return rr[0] || null;
}

async function nearestFreeCellAround(x0, y0) {
  for (let R = 8; R <= 80; R += 8) {
    const cand = await dbq(
      `SELECT x,y,living_quality AS lq
         FROM world_cells
        WHERE x BETWEEN ($1::int - $3::int) AND ($1::int + $3::int)
          AND y BETWEEN ($2::int - $3::int) AND ($2::int + $3::int)
          AND biome <> 'ocean' AND living_quality >= 0
        ORDER BY living_quality DESC
        LIMIT 400`,
      [x0, y0, R]
    );
    for (const c of cand) {
      const near = await hasSettlementWithinCheb(c.x, c.y, MIN_CHEB_DIST);
      if (!near) return c;
    }
  }
  return null;
}

async function ownedRoomsOf(playerId) {
  const r = await dbq(
    "SELECT id, name FROM rooms WHERE owner_player_id=$1 ORDER BY name",
    [playerId]
  );
  return r;
}

async function assertLordPowersHere(ctx, socket, me) {
  if (me.role === "King") return { ok: true, roomId: null };

  const here = (
    await dbq(
      "SELECT id, name, owner_player_id FROM rooms WHERE name=$1 LIMIT 1",
      [me.room]
    )
  )[0];

  if (!here) {
    ctx.you(socket, "Room not found.");
    return { ok: false };
  }
  if (here.owner_player_id === me.id) return { ok: true, roomId: here.id };

  const mine = await ownedRoomsOf(me.id);
  if (!mine.length) {
    ctx.you(
      socket,
      "You are not a lord of any town yet. Get promoted or /found a town."
    );
    return { ok: false };
  }
  ctx.you(
    socket,
    `You are Lord of: ${mine
      .map((r) => r.name)
      .join(", ")}. You are in ${me.room}. /travel to your town to manage it.`
  );
  return { ok: false };
}

// ---------------------------------
function initRolesFeature(registry) {
  // fallback for getHome if settlement feature hasn't attached yet
  if (!registry.getHome) {
    registry.getHome = async (playerId) => {
      const r = await dbq(
        `SELECT h.*, r.name AS room_name 
         FROM homes h 
         LEFT JOIN rooms r ON r.id = h.room_id 
         WHERE h.player_id=$1 LIMIT 1`,
        [playerId]
      );
      return r[0] || null;
    };
  }

  register("/role", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket, true);
    ctx.you(socket, `Role: ${me.role || "Peasant"}`);
  });

  register("/setrole", async (ctx, socket, parts) => {
    const raw = (parts[1] || "").toLowerCase();
    if (!ALLOWED.has(raw))
      return ctx.you(
        socket,
        "Usage: /setrole peasant|blacksmith|locallord|king"
      );
    const me = await ctx.getPlayer(socket);
    await dbq("UPDATE players SET role=$1 WHERE id=$2", [norm(raw), me.id]);
    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sys(me2.room, `${me2.username} is now ${me2.role}.`);
    ctx.sendState(socket, me2);
  });

  // Peasant → LocalLord (requires house-tier + gold)
  register("/promote", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const target = (parts[1] || "").toLowerCase();
    if (target !== "locallord")
      return ctx.you(socket, "Usage: /promote LocalLord");
    if (me.role === "LocalLord" || me.role === "King")
      return ctx.you(socket, "You already have high rank.");

    const home = await registry.getHome(me.id);
    if (!home || !["house", "manor"].includes((home.tier || "").toLowerCase())) {
      return ctx.you(
        socket,
        "You must own at least a House before being granted a County."
      );
    }

    const fee = 500;
    if ((me.gold || 0) < fee)
      return ctx.you(socket, `Need ${fee} gold to be granted a county.`);

    const kid = await anyKingId();
    await dbq("UPDATE players SET gold=gold-$1, role='LocalLord' WHERE id=$2", [
      fee,
      me.id,
    ]);
    if (kid)
      await dbq("UPDATE players SET gold=gold+$1 WHERE id=$2", [fee, kid]);
    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sys(me2.room, `${me2.username} has been promoted to LocalLord.`);
    ctx.sendState(socket, me2);
  }, "LocalLord — pay fee (requires House tier)");

  // /found (requires LocalLord + house-tier home)
  register("/found", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    if (me.role !== "LocalLord" && me.role !== "King") {
      return ctx.you(socket, "Only Local Lords or the King can found towns.");
    }

    const home = await registry.getHome(me.id);
    if (!home || !["house", "manor"].includes((home.tier || "").toLowerCase())) {
      return ctx.you(
        socket,
        "You must have at least a House-tier home before founding a town."
      );
    }

    let x = null,
      y = null;
    let nameTokens = parts.slice(1);
    if (
      nameTokens.length >= 3 &&
      Number.isInteger(Number(nameTokens.at(-2))) &&
      Number.isInteger(Number(nameTokens.at(-1)))
    ) {
      x = Number(nameTokens.at(-2));
      y = Number(nameTokens.at(-1));
      nameTokens = nameTokens.slice(0, -2);
    }
    const name = (nameTokens.join(" ") || "").trim();
    if (!name || name.length < 3)
      return ctx.you(socket, "Usage: /found CountyName [x y]");
    if (name.toLowerCase() === "capital")
      return ctx.you(socket, "That name is reserved.");
    if ((await dbq("SELECT 1 FROM rooms WHERE name=$1", [name])).length)
      return ctx.you(socket, "That room already exists.");

    const meta = await worldMeta();
    if (!meta) return ctx.you(socket, "World not generated yet.");

    let spot = null;
    if (x != null && y != null) {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= meta.width ||
        y >= meta.height
      ) {
        return ctx.you(
          socket,
          `Out of bounds (0..${meta.width - 1}, 0..${meta.height - 1}).`
        );
      }
      const cell = await cellAt(x, y);
      if (!cell) return ctx.you(socket, "Invalid cell.");
      if (cell.biome === "ocean") return ctx.you(socket, "Cannot found on ocean.");
      if ((cell.lq ?? -1) < 0)
        return ctx.you(socket, "That location’s living quality is too low.");
      const near = await hasSettlementWithinCheb(x, y, MIN_CHEB_DIST);
      if (near)
        return ctx.you(
          socket,
          `Too close to ${near.name} at (${near.x},${near.y}). Need at least ${MIN_CHEB_DIST} cells away.`
        );
      spot = { x, y, lq: cell.lq };
    } else {
      const origin = (await roomXY(me.room)) || (await capitalXY());
      spot = await nearestFreeCellAround(origin.x, origin.y);
      if (!spot)
        return ctx.you(socket, "No suitable location found (try coordinates).");
    }

    await dbq(
      `INSERT INTO rooms (
          name, terrain, living_quality, distance_from_capital, tax_rate, owner_player_id,
          world_x, world_y,
          price_food, price_meat, price_wood, price_stone, price_bow, price_pickaxe,
          treasury_gold, floor_fruit, floor_meat, floor_wood, floor_stone,
          quota_fruit, quota_meat, quota_wood, quota_stone, quotas_day, resident_cap
        ) VALUES (
          $1,'plains',$2,2,10,$3,
          $4,$5,
          1,3,1,2,20,25,
          0, 0,0,0,0,
          300,150,250,200,0,20
        )`,
      [name, Math.max(0, spot.lq ?? 0), me.id, spot.x, spot.y]
    );

    const me2 = (
      await dbq("UPDATE players SET room=$1 WHERE id=$2 RETURNING *", [
        name,
        me.id,
      ])
    )[0];
    ctx.sys(me.room, `${me.username} founded ${name} at (${spot.x},${spot.y}).`);
    ctx.sys(name, `${me.username} arrived.`);
    ctx.sendState(socket, me2);
  }, "CountyName [x y] — found & own a new town (requires House tier)");

  // decree, fund, setfloor, setquota — same as before
  register("/decree", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const auth = await assertLordPowersHere(ctx, socket, me);
    if (!auth.ok && me.role !== "King") return;
    const text = parts.slice(1).join(" ").trim();
    if (!text) return ctx.you(socket, "Usage: /decree message");
    ctx.sys(me.room, `📜 Decree from ${me.username}: ${text}`);
  });

  register("/fund", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const auth = await assertLordPowersHere(ctx, socket, me);
    if (!auth.ok && me.role !== "King") return;

    const amount = Number(parts[1]);
    if (!Number.isInteger(amount) || amount <= 0)
      return ctx.you(socket, "Usage: /fund amount");
    if ((me.gold || 0) < amount) return ctx.you(socket, "Not enough gold.");

    const room = (await dbq("SELECT id FROM rooms WHERE name=$1", [me.room]))[0];
    await dbq("UPDATE players SET gold=gold-$1 WHERE id=$2", [amount, me.id]);
    await dbq(
      "UPDATE rooms SET treasury_gold=COALESCE(treasury_gold,0)+$1 WHERE id=$2",
      [amount, room.id]
    );

    ctx.sys(me.room, `${me.username} funded the ${me.room} treasury by ${amount}g.`);
    const me2 = (await dbq("SELECT * FROM players WHERE id=$1", [me.id]))[0];
    ctx.sendState(socket, me2);
  });

  register("/setfloor", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const auth = await assertLordPowersHere(ctx, socket, me);
    if (!auth.ok && me.role !== "King") return;

    let res = canonRes(parts[1]);
    const price = Number(parts[2]);
    if (
      !["food", "meat", "wood", "stone"].includes(res) ||
      !Number.isInteger(price) ||
      price < 0
    )
      return ctx.you(socket, "Usage: /setfloor fruit|meat|wood|stone price");

    const room = (
      await dbq(
        "SELECT id, price_food, price_meat, price_wood, price_stone FROM rooms WHERE name=$1",
        [me.room]
      )
    )[0];
    const market =
      {
        food: room.price_food,
        meat: room.price_meat,
        wood: room.price_wood,
        stone: room.price_stone,
      }[res] ?? 0;
    if (price > market)
      return ctx.you(socket, `Floor cannot exceed market price (${market}).`);

    const col = FLOOR_COL[res];
    await dbq(`UPDATE rooms SET ${col}=$1 WHERE id=$2`, [price, room.id]);
    ctx.sys(
      me.room,
      `${me.username} set ${res === "food" ? "fruit" : res} floor to ${price}g.`
    );
  });

  register("/setquota", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const auth = await assertLordPowersHere(ctx, socket, me);
    if (!auth.ok && me.role !== "King") return;

    let res = canonRes(parts[1]);
    const amount = Number(parts[2]);
    if (
      !["food", "meat", "wood", "stone"].includes(res) ||
      !Number.isInteger(amount) ||
      amount < 0 ||
      amount > 2000
    )
      return ctx.you(socket, "Usage: /setquota fruit|meat|wood|stone amount (0..2000)");

    const room = (await dbq("SELECT id FROM rooms WHERE name=$1", [me.room]))[0];
    const col = QUOTA_COL[res];
    await dbq(`UPDATE rooms SET ${col}=$1 WHERE id=$2`, [amount, room.id]);
    ctx.sys(
      me.room,
      `${me.username} set ${res === "food" ? "fruit" : res} quota to ${amount}.`
    );
  });
}

module.exports = { initRolesFeature };
