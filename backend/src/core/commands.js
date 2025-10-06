// src/core/commands.js
const cmds = new Map();
function register(name, handler, help) { cmds.set(name.toLowerCase(), { handler, help }); }
async function dispatch(ctx, socket, raw) {
  const parts = raw.trim().split(/\s+/);
  const cmd = (parts[0]||"").toLowerCase();
  const entry = cmds.get(cmd);
  if (!entry) { ctx.you(socket, `Unknown command: ${raw}`); return; }
  await entry.handler(ctx, socket, parts);
}
function helpLines() {
  return [...cmds.entries()]
    .filter(([n]) => n.startsWith("/"))
    .map(([n, v]) => v.help ? `${n} ${v.help}` : n);
}
module.exports = { register, dispatch, helpLines };
