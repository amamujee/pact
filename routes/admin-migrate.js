// routes/admin-migrate.js
// Owns: Neon → Render PostgreSQL migration admin endpoints.
// Does NOT own: app logic, Slack handlers, billing, or user-facing routes.
//
// These routes are for one-time migration use only.
// Access via ?secret=<ADMIN_SECRET> or X-Admin-Secret header.

'use strict';

const express = require('express');

const router = express.Router();

function requireAuth(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return next();
  if (req.query.secret === secret || req.headers['x-admin-secret'] === secret) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// GET /admin/migrate/tables
// List all Neon tables with row counts
// ---------------------------------------------------------------------------
router.get('/tables', requireAuth, async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    const tablesR = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tables = [];
    for (const row of tablesR.rows) {
      const cnt = await pool.query(`SELECT COUNT(*) as n FROM "${row.table_name}"`);
      tables.push({ name: row.table_name, rowCount: parseInt(cnt.rows[0].n) });
    }
    await pool.end();
    res.json({ tables, total: tables.length });
  } catch (err) {
    await pool.end();
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/migrate/export
// Dump all Neon data to /tmp/neon-export.json on Render disk
// ---------------------------------------------------------------------------
router.post('/export', requireAuth, async (req, res) => {
  const { Pool } = require('pg');
  const fs = require('fs');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    const tablesR = await pool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);
    const tables = tablesR.rows.map(r => r.table_name);
    const data = {};
    const tableInfo = [];

    for (const table of tables) {
      const cntR = await pool.query(`SELECT COUNT(*) as n FROM "${table}"`);
      const count = parseInt(cntR.rows[0].n);
      if (count > 0) {
        const rowsR = await pool.query(`SELECT * FROM "${table}"`);
        data[table] = rowsR.rows;
        tableInfo.push({ name: table, rowCount: count });
        console.log(`[migrate] Export ${table}: ${count} rows`);
      } else {
        tableInfo.push({ name: table, rowCount: 0 });
      }
    }

    await pool.end();

    const payload = { exportedAt: new Date().toISOString(), tables: tableInfo, data };
    fs.writeFileSync('/tmp/neon-export.json', JSON.stringify(payload));
    const totalRows = Object.values(data).reduce((s, rows) => s + rows.length, 0);

    res.json({
      success: true,
      exportedTables: tableInfo.length,
      totalRows,
      note: 'Run POST /admin/migrate/import with RENDER_DATABASE_URL in body to import.'
    });
  } catch (err) {
    await pool.end();
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/migrate/import
// Import /tmp/neon-export.json into Render PostgreSQL
// Body: { renderDatabaseUrl: string }
// ---------------------------------------------------------------------------
router.post('/import', requireAuth, async (req, res) => {
  const { renderDatabaseUrl } = req.body;
  if (!renderDatabaseUrl) {
    return res.status(400).json({ error: 'renderDatabaseUrl required in body' });
  }

  const fs = require('fs');
  const { Pool } = require('pg');

  if (!fs.existsSync('/tmp/neon-export.json')) {
    return res.status(400).json({
      error: 'Run POST /admin/migrate/export first. Export file missing at /tmp/neon-export.json.'
    });
  }

  let exportData;
  try {
    exportData = JSON.parse(fs.readFileSync('/tmp/neon-export.json', 'utf8'));
  } catch (e) {
    return res.status(400).json({ error: `Invalid JSON export file: ${e.message}` });
  }

  const { tables, data } = exportData;
  const renderPool = new Pool({ connectionString: renderDatabaseUrl, ssl: { rejectUnauthorized: false } });

  try {
    const results = [];

    for (const t of tables) {
      const tableName = typeof t === 'string' ? t : t.name;
      const rows = data[tableName];

      if (!rows || rows.length === 0) {
        results.push({ table: tableName, status: 'skipped', rows: 0 });
        continue;
      }

      const cols = Object.keys(rows[0]);
      const colList = cols.map(c => `"${c}"`).join(', ');
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');

      // Drop + recreate table (TEXT columns only for safety — type coercion handled at insert)
      await renderPool.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
      const colDefs = cols.map(c => `"${c}" TEXT`).join(', ');
      await renderPool.query(`CREATE TABLE "${tableName}" (${colDefs})`);

      // Batch insert using multi-row VALUES syntax (max 500 rows per statement)
      const BATCH = 500;
      let imported = 0;

      for (let i = 0; i < rows.length; i += BATCH) {
        const chunk = rows.slice(i, i + BATCH);

        // Build multi-row VALUES: ($1, $2, $3), ($4, $5, $6), ...
        const valueSets = [];
        const values = [];
        let paramIndex = 1;

        for (const row of chunk) {
          const vals = cols.map(c => {
            const v = row[c];
            if (v === null) return null;
            if (typeof v === 'object') return JSON.stringify(v);
            return v;
          });
          valueSets.push('(' + vals.map(() => `$${paramIndex++}`).join(', ') + ')');
          values.push(...vals);
        }

        const sql = `INSERT INTO "${tableName}" (${colList}) VALUES ${valueSets.join(', ')} ON CONFLICT DO NOTHING`;
        await renderPool.query(sql, values);
        imported += chunk.length;
      }

      results.push({ table: tableName, status: 'imported', rows: imported });
      console.log(`[migrate] Imported ${tableName}: ${imported} rows`);
    }

    await renderPool.end();

    // Cleanup export file
    fs.unlinkSync('/tmp/neon-export.json');

    res.json({
      success: true,
      results,
      totalTables: results.length,
      note: 'All data imported. Next: update DATABASE_URL env var and redeploy.'
    });
  } catch (err) {
    await renderPool.end();
    res.status(500).json({ error: err.message, hint: 'Check table/column names match Neon schema' });
  }
});

// ---------------------------------------------------------------------------
// POST /admin/migrate/create-render-postgres
// Create new Render PostgreSQL via Render API
// ---------------------------------------------------------------------------
router.post('/create-render-postgres', requireAuth, async (req, res) => {
  const RENDER_API_KEY = process.env.RENDER_API_KEY;
  if (!RENDER_API_KEY) {
    return res.status(500).json({ error: 'RENDER_API_KEY env var not set on this deployment' });
  }

  try {
    const response = await fetch('https://api.render.com/v1/postgres', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RENDER_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ name: 'pact-db', plan: 'free', region: 'oregon' })
    });

    const text = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: `Render API: ${text}` });
    }

    const result = JSON.parse(text);
    res.json({
      success: true,
      internalPort: result.internalPort,
      password: result.password,
      database: result.database,
      note: 'Use host/port from connection string. Save the password — it is shown once.'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;