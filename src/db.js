const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL is not set. Copy .env.example to .env and paste the Supabase pooler URI.');
}

const isServerless = !!process.env.VERCEL;

const pool = connectionString
  ? new Pool({
      connectionString,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: isServerless ? 1 : 5,
      idleTimeoutMillis: isServerless ? 8000 : 30000,
      connectionTimeoutMillis: 8000,
      allowExitOnIdle: isServerless
    })
  : null;

async function query(sql, params, client) {
  const runner = client || pool;
  if (!runner) {
    const error = new Error('DATABASE_URL is not set');
    error.status = 500;
    throw error;
  }
  const result = Array.isArray(params) && params.length
    ? await runner.query(sql, params)
    : await runner.query(sql);
  return result.rows;
}

async function queryOne(sql, params, client) {
  const rows = await query(sql, params, client);
  return rows[0] || null;
}

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

let ready;
function ensureReady() {
  if (!ready) {
    ready = initialize().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

async function initialize() {
  if (!pool) return;
  const existing = await queryOne("SELECT to_regclass('public.users') AS name");
  if (!existing || !existing.name) {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
    await pool.query(schema);
  }
  const seeded = await query(
    'SELECT email FROM users WHERE email = ANY($1::text[])',
    [['admin@nihao-urdu.com', 'student@nihao-urdu.com']]
  );
  const have = new Set(seeded.map((row) => String(row.email).toLowerCase()));
  if (!have.has('admin@nihao-urdu.com')) {
    await seedUser({
      email: 'admin@nihao-urdu.com',
      username: 'admin',
      password: 'admin123',
      fullName: 'Admin User',
      role: 'ADMIN'
    });
  }
  if (!have.has('student@nihao-urdu.com')) {
    await seedUser({
      email: 'student@nihao-urdu.com',
      username: 'student',
      password: 'student123',
      fullName: 'Test Student',
      role: 'STUDENT'
    });
  }
}

async function seedUser(user) {
  const existing = await queryOne('SELECT id FROM users WHERE email = $1', [user.email]);
  if (existing) return;
  const now = new Date();
  await query(
    `INSERT INTO users
      (id, username, email, password_hash, full_name, role, status, auth_provider, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE','PASSWORD',$7,$7)`,
    [crypto.randomUUID(), user.username, user.email, bcrypt.hashSync(user.password, 10), user.fullName, user.role, now]
  );
}

module.exports = { pool, query, queryOne, withTx, ensureReady };
