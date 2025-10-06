require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  try {
    console.log("⚙️  Setting search_path for current database...");
    await pool.query(`ALTER DATABASE neondb SET search_path TO public;`);
    console.log("✅ search_path set to public");
  } catch (err) {
    console.error("❌", err);
  } finally {
    await pool.end();
  }
})();
