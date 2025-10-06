// src/features/market.js
const { dbq } = require("../db");
const { register } = require("../core/commands");
const { dayId } = require("./market_maker");

const SELLABLE = new Set(["wood","stone","food","fruit","meat"]);
const BUY_TOOL = new Set(["bow","pickaxe"]);
const BUY_RES  = new Set(["wood","stone","food","fruit","meat"]);

const INPUT_ALIAS  = { fruit: "food" };
const DISPLAY_NAME = { food: "fruit", meat: "meat", wood: "wood", stone: "stone" };

function canonRes(r){ const k=(r||"").toLowerCase(); return INPUT_ALIAS[k] || k; }
function displayRes(c){ return DISPLAY_NAME[c] || c; }
function saleNet(gross, tax, taxFree){ return gross <= (taxFree||10) ? gross : Math.floor(gross * (100 - (tax||0)) / 100); }
function buyCost(gross, tax, taxFree){ return gross <= (taxFree||10) ? gross : Math.floor(gross * (100 + (tax||0)) / 100); }

// --- room helpers ---
async function roomRowByName(name){
  const r = await dbq(
    `SELECT id, name, tax_rate,
            price_wood, price_stone, price_food, price_meat, price_bow, price_pickaxe,
            treasury_gold,
            tax_free_up_to
       FROM rooms
      WHERE name=$1`,
    [name]
  );
  return r[0] || null;
}
async function getStock(roomId, res){
  const r = await dbq("SELECT qty FROM room_stock WHERE room_id=$1 AND resource=$2",[roomId, res]);
  return r[0]?.qty ?? 0;
}
async function ensureStockRow(roomId, res){
  await dbq("INSERT INTO room_stock (room_id, resource, qty) VALUES ($1,$2,0) ON CONFLICT DO NOTHING",[roomId, res]);
}
async function adjustStock(roomId, res, delta){
  await ensureStockRow(roomId, res);
  if (delta >= 0){
    await dbq("UPDATE room_stock SET qty = qty + $1 WHERE room_id=$2 AND resource=$3",[delta, roomId, res]);
    return true;
  } else {
    const have = await getStock(roomId, res);
    if (have + delta < 0) return false;
    await dbq("UPDATE room_stock SET qty = qty + $1 WHERE room_id=$2 AND resource=$3",[delta, roomId, res]);
    return true;
  }
}

// market-maker commission on gross (for market portion only)
async function payMakerCommission(ctx, roomId, roomName, res, gross){
  try{
    const today = dayId();
    const mm = await dbq(
      "SELECT player_id, percent FROM market_makers WHERE room_id=$1 AND resource=$2 AND day_id=$3",
      [roomId, res, today]
    );
    if (!mm.length) return;
    const cut = Math.floor(gross * (mm[0].percent / 100));
    if (cut > 0){
      await dbq("UPDATE players SET gold=gold+$1 WHERE id=$2", [cut, mm[0].player_id]);
      const maker = (await dbq("SELECT username, socket_id FROM players WHERE id=$1",[mm[0].player_id]))[0];
      const msock = ctx.socketOf(maker);
      if (msock) ctx.you(msock, `You earned ${cut}g commission from a ${displayRes(res)} trade in ${roomName}.`);
    }
  } catch(_e){ /* never block trade on commission */ }
}

function initMarketFeature(registry) {

  // ---- SELL to market (treasury floor + quota first, then market) ----
  register("/sell", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    let resIn = (parts[1] || "").toLowerCase();
    const qty = Number(parts[2]);

    if (!SELLABLE.has(resIn) || !Number.isInteger(qty) || qty <= 0)
      return ctx.you(socket, "Usage: /sell wood|stone|food|fruit|meat qty");

    const res = canonRes(resIn);
    const label = displayRes(res);

    if ((me[res] || 0) < qty) return ctx.you(socket, `Not enough ${label} to sell.`);

    const room = await roomRowByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");

    const buffs = ctx.getRoomBuffs ? await ctx.getRoomBuffs(room.name) : {};
    const taxFree = Number.isFinite(buffs.tax_free_up_to) ? buffs.tax_free_up_to : (room.tax_free_up_to || 10);

    const priceMap = {
      wood: room.price_wood ?? 1,
      stone: room.price_stone ?? 2,
      food: room.price_food ?? 1,
      meat: room.price_meat ?? 3,
    };

    // 1) Treasury portion (untaxed) if floor + quota + treasury allow
    const floorCols = { food:"floor_fruit", meat:"floor_meat", wood:"floor_wood", stone:"floor_stone" };
    const quotaCols = { food:"quota_fruit", meat:"quota_meat", wood:"quota_wood", stone:"quota_stone" };
    const floorRow = await dbq(`SELECT ${floorCols[res]} AS floor, ${quotaCols[res]} AS quota, treasury_gold
                                  FROM rooms WHERE id=$1`, [room.id]);
    const floor = floorRow[0]?.floor || 0;
    const quota = floorRow[0]?.quota || 0;
    const treasury_gold = floorRow[0]?.treasury_gold || 0;

    let treasuryQty = 0;
    let treasuryPaid = 0;

    if (floor > 0 && quota > 0 && treasury_gold > 0) {
      const byQuota = quota;
      const byGold  = Math.floor(treasury_gold / floor);
      treasuryQty = Math.max(0, Math.min(qty, byQuota, byGold));
      treasuryPaid = treasuryQty * floor;

      if (treasuryQty > 0) {
        const qcol = quotaCols[res];
        await dbq(`UPDATE rooms
                      SET treasury_gold = treasury_gold - $1,
                          ${qcol} = GREATEST(0, ${qcol} - $2)
                    WHERE id = $3`,
                  [treasuryPaid, treasuryQty, room.id]);
        await adjustStock(room.id, res, +treasuryQty);
      }
    }

    // 2) Market portion (taxed, maker commission on gross)
    const marketQty = qty - treasuryQty;
    const marketGross = marketQty * (priceMap[res] || 0);
    const marketNet   = saleNet(marketGross, room.tax_rate, taxFree);

    if (marketQty > 0 && marketGross > 0) {
      await payMakerCommission(ctx, room.id, room.name, res, marketGross);
      await adjustStock(room.id, res, +marketQty);
    }

    // 3) Update player
    const gain = (treasuryPaid || 0) + (marketNet || 0);
    const next = { ...me, [res]: (me[res]||0) - qty, gold: (me.gold||0) + gain };
    await dbq(
      "UPDATE players SET gold=$1, wood=$2, stone=$3, food=$4, meat=$5 WHERE id=$6",
      [next.gold, next.wood||0, next.stone||0, next.food||0, next.meat||0, me.id]
    );

    // 4) Messages
    const chunks = [];
    if (treasuryQty > 0) chunks.push(`${treasuryQty} ${label} to treasury at ${floor}g (untaxed)`);
    if (marketQty   > 0) {
      const taxedTxt = (marketGross <= taxFree) ? `no tax (≤${taxFree}g)` : `tax ${room.tax_rate||0}%`;
      chunks.push(`${marketQty} ${label} to market for ${marketNet}g (${taxedTxt})`);
    }
    const summary = chunks.length ? chunks.join("; ") : `nothing (no eligible floor/market)`;

    ctx.sys(me.room, `${me.username} sold ${qty} ${label}: ${summary}.`);
    ctx.sendState(socket, next);
  }, "wood|stone|food|fruit|meat qty — sell (treasury floor first, then market)");

  // ---- BUY (tools or resources) ----
  register("/buy", async (ctx, socket, parts) => {
    const me = await ctx.getPlayer(socket, true);
    const item = (parts[1] || "").toLowerCase();

    const room = await roomRowByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");
    const buffs = ctx.getRoomBuffs ? await ctx.getRoomBuffs(room.name) : {};
    const taxFree = Number.isFinite(buffs.tax_free_up_to) ? buffs.tax_free_up_to : (room.tax_free_up_to || 10);

    // tools path
    if (BUY_TOOL.has(item)){
      const base = item === "bow" ? (room.price_bow ?? 20) : (room.price_pickaxe ?? 25);
      const discounted = Math.ceil(base * (1 - (buffs.tool_discount || 0)));
      const price = buyCost(discounted, room.tax_rate, taxFree);
      if ((me.gold||0) < price) return ctx.you(socket, `Need ${price} gold.`);

      await dbq("UPDATE players SET gold=gold-$1 WHERE id=$2", [price, me.id]);
      const { giveTool, TOOL } = require("./inventory");
      await giveTool(me.id, item);

      const me2 = (await dbq("SELECT * FROM players WHERE id=$1",[me.id]))[0];
      ctx.sys(me.room, `${me.username} bought ${TOOL[item].name} for ${price}g.`);
      ctx.sendState(socket, me2);
      return;
    }

    // resource path
    if (!BUY_RES.has(item)) return ctx.you(socket, "Usage: /buy bow|pickaxe  OR  /buy fruit|meat|wood|stone qty");
    const qty = Number(parts[2]);
    if (!Number.isInteger(qty) || qty <= 0) return ctx.you(socket, "Usage: /buy fruit|meat|wood|stone qty");

    const res = canonRes(item);
    const label = displayRes(res);

    const priceMap = {
      wood: room.price_wood ?? 1,
      stone: room.price_stone ?? 2,
      food: room.price_food ?? 1,
      meat: room.price_meat ?? 3,
    };
    const gross = qty * (priceMap[res] || 0);
    const cost  = buyCost(gross, room.tax_rate, taxFree);

    // check stock
    const have = await getStock(room.id, res);
    if (have < qty) return ctx.you(socket, `Market only has ${have} ${label} available.`);
    if ((me.gold||0) < cost) return ctx.you(socket, `Need ${cost} gold.`);

    const next = { ...me, [res]: (me[res]||0) + qty, gold: (me.gold||0) - cost };
    await dbq(
      "UPDATE players SET gold=$1, wood=$2, stone=$3, food=$4, meat=$5 WHERE id=$6",
      [next.gold, next.wood||0, next.stone||0, next.food||0, next.meat||0, me.id]
    );

    await adjustStock(room.id, res, -qty);
    await payMakerCommission(ctx, room.id, room.name, res, gross);

    const taxedTxt = gross <= taxFree ? `no tax (≤${taxFree}g)` : `+tax ${room.tax_rate||0}%`;
    ctx.sys(me.room, `${me.username} bought ${qty} ${label} for ${cost}g (${taxedTxt}).`);
    ctx.sendState(socket, next);
  }, "bow|pickaxe  OR  fruit|meat|wood|stone qty — buy from market");

  // ---- STOCK readout ----
  register("/stock", async (ctx, socket) => {
    const me = await ctx.getPlayer(socket);
    const room = await roomRowByName(me.room);
    if (!room) return ctx.you(socket, "Room not found.");

    const rows = await dbq(
      "SELECT resource, qty FROM room_stock WHERE room_id=$1 ORDER BY resource",
      [room.id]
    );
    if (!rows.length) return ctx.you(socket, "No market stock yet.");
    rows.forEach(r => ctx.you(socket, `${displayRes(r.resource)}: ${r.qty}`));
  }, " — show room market inventory");
}

module.exports = { initMarketFeature };
