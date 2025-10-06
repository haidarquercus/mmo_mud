// src/db.js
require('dotenv').config();
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

// Neon-friendly: no startup options in connection; we set schema per session instead
const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    })
  : new Pool({
      user: process.env.PGUSER || 'postgres',
      host: process.env.PGHOST || 'localhost',
      database: process.env.PGDATABASE || 'kingdom',
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5433,
      ssl: false,
    });

// Simple query helper (always ensure public schema active)
async function dbq(q, p = []) {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public;');
    const res = await client.query(q, p);
    return res.rows;
  } finally {
    client.release();
  }
}

// Transaction helper
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('SET search_path TO public;');
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, dbq, withTx };
