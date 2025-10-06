// backend/import-dump-node.js
require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const { Pool } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Missing DATABASE_URL in .env");

const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

async function importDump(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  console.log(`📦 Importing ${filePath} into Neon (pure Node mode)...`);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let buffer = "";
  let count = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("--")) continue; // skip comments

    buffer += line + "\n";

    if (trimmed.endsWith(";")) {
      try {
        await pool.query(buffer);
        count++;
        if (count % 20 === 0) console.log(`...executed ${count} statements`);
      } catch (err) {
        console.error(`❌ Error on statement #${count + 1}:`, err.message);
      }
      buffer = "";
    }
  }

  console.log(`✅ Done. Executed ${count} SQL statements.`);
}

(async () => {
  try {
    await importDump("backup_kingdom.sql");
  } catch (err) {
    console.error("❌ Import failed:", err);
  } finally {
    await pool.end();
  }
})();
