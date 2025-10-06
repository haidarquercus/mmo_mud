// backend/import-dump.js
require("dotenv").config();
const fs = require("fs");
const { Pool } = require("pg");
const { pipeline } = require("stream");
const { exec } = require("child_process");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Missing DATABASE_URL in .env");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function importDump(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  console.log(`📦 Importing ${filePath} into Neon...`);

  // Use psql through a subprocess with streaming
  const cmd = `psql "${connectionString}" -v ON_ERROR_STOP=1 -f "${filePath}"`;
  const child = exec(cmd, { maxBuffer: 1024 * 1024 * 50 }); // 50 MB buffer

  child.stdout.on("data", (data) => process.stdout.write(data));
  child.stderr.on("data", (data) => process.stderr.write(data));

  return new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`psql exited with code ${code}`));
    });
  });
}

(async () => {
  try {
    await importDump("backup_kingdom.sql");
    console.log("✅ Import complete!");
  } catch (err) {
    console.error("❌ Import failed:", err);
  } finally {
    await pool.end();
  }
})();
