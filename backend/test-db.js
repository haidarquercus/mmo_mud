// backend/test-db.js
require("dotenv").config();
const { Pool } = require("pg");

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    console.log("🔌 Connecting to Neon...");
    const res = await pool.query("SELECT current_database(), now()");
    console.log("✅ Connected to:", res.rows[0]);
  } catch (err) {
    console.error("❌ Connection failed:", err);
  } finally {
    await pool.end();
  }
})();

