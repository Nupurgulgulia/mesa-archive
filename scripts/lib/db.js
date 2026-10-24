require('./env');
const { Pool } = require('pg');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing in .env.local');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
module.exports = { pool, q: (text, params) => pool.query(text, params) };
