// bots/botfarm.js
// Usage:
//   npm i socket.io-client
//   BOT_VERBOSE=1 node botfarm.js --n=10 --url=http://127.0.0.1:3000 --room=Capital
//
// Flags: --n <count>  --url <server>  --room <startRoom>  --tick <ms>

const { io } = require("socket.io-client");

// ---- CLI parsing (no deps)
const args = Object.fromEntries(
  process.argv.slice(2).map(s => {
    const m = s.match(/^--([^=]+)=(.*)$/);
    if (m) return [m[1], m[2]];
    if (s.startsWith("--")) return [s.slice(2), true];
    return [s, true];
  })
);
const N = Number(args.n || 10);
const URL = args.url || "http://127.0.0.1:3000";
const START_ROOM = args.room || "Capital";
const TICK_MS = Number(args.tick || 1200);

const PRICE_BOW  = 20;
const PRICE_PICK = 25;
const LORD_FEE   = 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (a,b) => Math.floor(Math.random()*(b-a+1))+a;
const pick  = arr => arr[Math.floor(Math.random()*arr.length)];
const now   = () => Date.now();
const VERBOSE = !!process.env.BOT_VERBOSE;

class Bot {
  constructor(id, url) {
    this.id = id;
    this.url = url;
    this.state = { room:"Capital", username:"", gold:0, food:0, meat:0, wood:0, stone:0, hunger:100, role:"Peasant" };
    this.hasBow = false;
    this.hasPick = false;
    this.lastCmdAt = 0;
    this.cmdDelay = rand(650, 950);
    this.nextChatAt = now() + rand(10_000, 30_000);
    this.hasFounded = false;
    this.connected = false;
    this.connect();
  }

  connect() {
    this.sock = io(this.url, {
      path: "/socket.io",
      // Allow polling fallback so "websocket error" doesn't brick us
      transports: ["polling", "websocket"],
      upgrade: true,

      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 8000,
      forceNew: true,
    });

    this.sock.on("connect", () => {
      this.connected = true;
      this.log(`connected socket=${this.sock.id}`);
    });
    this.sock.on("disconnect", (reason) => {
      this.connected = false;
      this.log(`disconnected (${reason})`);
    });
    this.sock.on("connect_error", (err) => {
      // Show more detail if engine/io provides it
      console.error(`[B${this.id}] connect_error:`, err?.message || err, err?.description || "", err?.context || "");
    });
    this.sock.on("error", (err) => {
      console.error(`[B${this.id}] error:`, err?.message || err);
    });

    // server messages
    this.sock.on("state", s => { this.state = { ...this.state, ...s }; if (!this.state.username && s.username) this.state.username = s.username; });
    this.sock.on("you", msg => this.parsePrivate(msg));
    this.sock.on("system", msg => this.parseSystem(msg));
    this.sock.on("chat", _ => {});
  }

  log(msg){ if (VERBOSE) console.log(`[B${this.id} ${this.state.username||""}] ${msg}`); }

  send(raw) {
    // throttle
    const delta = now() - this.lastCmdAt;
    if (delta < this.cmdDelay) return false;
    this.lastCmdAt = now();
    if (raw.startsWith("/")) this.sock.emit("command", raw);
    else this.sock.emit("chat", raw);
    this.log(`> ${raw}`);
    return true;
  }

  parsePrivate(msg){
    const mBow = msg.match(/Wooden Bow:\s*(\d+)/i);
    if (mBow) this.hasBow = Number(mBow[1]) > 0;
    const mPick = msg.match(/Stone Pickaxe:\s*(\d+)/i);
    if (mPick) this.hasPick = Number(mPick[1]) > 0;
    if (/You need a Bow/i.test(msg)) this.hasBow = false;
    if (/You need a Pickaxe/i.test(msg)) this.hasPick = false;
  }
  parseSystem(msg){
    if (/bought .*Bow/i.test(msg)) this.hasBow = true;
    if (/bought .*Pickaxe/i.test(msg)) this.hasPick = true;
    const mEnter = msg.match(/^([A-Za-z0-9]+)\s+entered/);
    if (mEnter && !this.state.username) this.state.username = mEnter[1];
  }

  async init(){
    // wait a bit for first connection/state
    for (let i=0;i<10;i++){
      if (this.connected) break;
      await sleep(300);
    }
    await sleep(rand(300, 800));
    this.send(`/travel ${START_ROOM}`);
    await sleep(rand(300, 800));
    this.send(`/inventory`);
  }

  maybeChat(){
    if (now() < this.nextChatAt) return;
    this.nextChatAt = now() + rand(25_000, 60_000);
    const lines = [
      "hello folks","trading berries for coins","anyone selling tools?",
      "hunting run, brb","tax fair today?","need a pickaxe soon..."
    ];
    this.send(pick(lines));
  }

  tick(){
    if (!this.connected) return;

    if (this.state.hunger <= 35 && this.state.food > 0) return this.send("/eat");
    if (!this.state.room) return this.send(`/stats`);

    if (this.state.gold < PRICE_BOW && this.state.food >= 25) {
      const sellAmt = Math.max(10, this.state.food - 5);
      return this.send(`/sell food ${sellAmt}`);
    }
    if (!this.hasBow && this.state.gold >= PRICE_BOW) return this.send("/buy bow");

    if (this.hasBow) {
      if (this.state.meat >= 20) return this.send(`/sell meat ${Math.floor(this.state.meat/2) || 10}`);
      return this.send("/hunt");
    } else {
      if (this.state.food >= 15) return this.send(`/sell food ${Math.floor(this.state.food/2)}`);
      return this.send("/gather food");
    }
  }

  longTick(){
    if (!this.connected) return;

    if (!this.hasPick && this.state.gold >= PRICE_PICK) return this.send("/buy pickaxe");
    if (this.hasPick && this.state.stone >= 12) return this.send(`/sell stone ${Math.floor(this.state.stone/2) || 6}`);
    if (this.hasPick) this.send("/mine");

    if (this.state.role !== "LocalLord" && this.state.gold >= LORD_FEE) return this.send("/promote LocalLord");

    if (this.state.role === "LocalLord" && !this.hasFounded) {
      this.hasFounded = true;
      const name = `County${this.id}-${rand(100,999)}`;
      return this.send(`/found ${name}`);
    }

    if (this.state.role === "LocalLord" && Math.random() < 0.05) {
      this.send("/settax 12");
      this.send("/decree Welcome! Prices fair; sell meat here.");
    }
  }

  start(){
    this._fast = setInterval(() => { this.maybeChat(); this.tick(); }, TICK_MS + rand(-200, 200));
    this._slow = setInterval(() => {
      this.longTick();
      if (Math.random() < 0.2) this.send("/stats");
      if (Math.random() < 0.2) this.send("/inventory");
    }, 3500 + rand(-500, 500));
  }

  stop(){
    clearInterval(this._fast); clearInterval(this._slow);
    this.sock.disconnect();
  }
}

(async () => {
  console.log(`Spawning ${N} bots -> ${URL} (room: ${START_ROOM})`);
  const bots = [];
  for (let i=0;i<N;i++){
    await sleep(rand(40, 90)); // stagger connects
    const b = new Bot(i+1, URL);
    bots.push(b);
    b.init().then(()=>b.start());
  }

  process.on("SIGINT", () => {
    console.log("\nStopping bots...");
    bots.forEach(b => b.stop());
    setTimeout(()=>process.exit(0), 500);
  });
})();
