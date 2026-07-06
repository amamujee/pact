// scripts/migrate-db.js
// Database migration: Neon → Render PostgreSQL
// Usage:
//   Export:  node scripts/migrate-db.js export
//   Import:  node scripts/migrate-db.js import <render-url>
//   Status:  node scripts/migrate-db.js status

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NEON_URL = process.env.DATABASE_URL;

function neonPool() {
  return new Pool({
    connectionString: NEON_URL,
    ssl: { rejectUnauthorized: false }
  });
}

function renderPool(url) {
  return new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
}

function auth(req) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return true;
  return req.headers['x-admin-secret'] === secret;
}

// ---------------------------------------------------------------------------
// Phase 1: Export schema + data from Neon
// ---------------------------------------------------------------------------
async function getNeonTables(pool) {
  const r = await pool.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return r.rows.map(x => x.table_name);
}

async function getTableSchema(pool, table) {
  const cols = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default, character_maximum_length, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  `, [table]);

  const pks = await pool.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_name = kcu.table_name
    WHERE tc.table_name = $1 AND tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
  `, [table]);

  const indexes = await pool.query(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE tablename = $1 AND schemaname = 'public'
    AND indexname NOT IN (
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = $1 AND constraint_type = 'PRIMARY KEY'
    )
  `, [table]);

  return {
    columns: cols.rows,
    primaryKey: pks.rows.map(x => x.column_name),
    indexes: indexes.rows
  };
}

async function exportNeon() {
  const pool = neonPool();
  const tables = await getNeonTables(pool);
  console.log(`Found ${tables.length} tables: ${tables.join(', ')}`);

  const schema = {};
  const data = {};

  for (const table of tables) {
    console.log(`Exporting ${table}...`);
    const schemaInfo = await getTableSchema(pool, table);
    schema[table] = schemaInfo;

    const countR = await pool.query(`SELECT COUNT(*) as cnt FROM "${table}"`);
    const count = parseInt(countR.rows[0].cnt);

    if (count > 0) {
      const rows = await pool.query(`SELECT * FROM "${table}"`);
      data[table] = rows.rows;
      console.log(`  → ${count} rows`);
    } else {
      console.log(`  → 0 rows`);
    }
  }

  await pool.end();

  const exportFile = path.join(__dirname, '..', 'neon-export.json');
  const payload = {
    exportedAt: new Date().toISOString(),
    tables,
    schema,
    data
  };
  fs.writeFileSync(exportFile, JSON.stringify(payload, null, 2));
  console.log(`\nExport complete → ${exportFile}`);

  const sizes = {};
  for (const [t, rows] of Object.entries(data)) {
    sizes[t] = rows.length;
  }
  console.log('Table sizes:', sizes);

  return exportFile;
}

// ---------------------------------------------------------------------------
// Phase 2: Create Render PostgreSQL via Render API
// ---------------------------------------------------------------------------
async function createRenderPostgres() {
  const RENDER_API_KEY = process.env.RENDER_API_KEY;
  if (!RENDER_API_KEY) {
    console.error('RENDER_API_KEY env var required to create PostgreSQL');
    process.exit(1);
  }

  const response = await fetch('https://api.render.com/v1/postgres', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RENDER_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'pact-db',
      plan: 'free',
      region: 'oregon'
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Render API error: ${response.status} ${err}`);
  }

  const result = await response.json();
  console.log('Render PostgreSQL created:', result);
  return result;
}

// ---------------------------------------------------------------------------
// Phase 3: Import into Render PostgreSQL
// ---------------------------------------------------------------------------
async function importToRender(renderUrl) {
  const exportFile = path.join(__dirname, '..', 'neon-export.json');
  if (!fs.existsSync(exportFile)) {
    console.error('Export file not found. Run `node scripts/migrate-db.js export` first.');
    process.exit(1);
  }

  const payload = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
  const { tables, data } = payload;

  const pool = renderPool(renderUrl);

  console.log('Creating schema...');
  for (const table of tables) {
    const si = payload.schema[table];
    if (!si) { console.warn(`No schema for ${table}, skipping`); continue; }

    // DROP existing table
    try {
      await pool.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    } catch (e) { /* ignore */ }

    // CREATE TABLE
    const colDefs = si.columns.map(c => {
      let type = c.data_type;
      if (c.character_maximum_length) type += `(${c.character_maximum_length})`;
      else if (c.numeric_precision !== null) type += `(${c.numeric_precision},${c.numeric_scale || 0})`;
      return `  "${c.column_name}" ${type} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''} ${c.column_default || ''}`.trim();
    }).filter(x => x.length > 2);

    const pkClause = si.primaryKey.length > 0 ? `, PRIMARY KEY (${si.primaryKey.map(x => `"${x}"`).join(', ')})` : '';

    await pool.query(`CREATE TABLE "${table}" (\n${colDefs.join(',\n')}${pkClause}\n)`);
    console.log(`  Created table: ${table}`);

    // CREATE indexes
    for (const idx of (si.indexes || [])) {
      try {
        // Extract index name and def
        const idxMatch = idx.indexdef.match(/CREATE(?: UNIQUE)? INDEX ([^\"]+|[^\"]+)/);
        const idxName = idx.indexname;
        // Re-create the index (strip the leading "CREATE ..." prefix)
        const idxDef = idx.indexdef.replace(/CREATE(?: UNIQUE)? INDEX \"?[^\"]+\"? ON/i, 'CREATE');
        await pool.query(`DROP INDEX IF EXISTS "${idxName}"`);
        await pool.query(idxDef);
        console.log(`  Created index: ${idxName}`);
      } catch (e) {
        console.warn(`  Index ${idx.indexname} failed: ${e.message}`);
      }
    }
  }

  console.log('\nImporting data...');
  for (const table of tables) {
    const rows = data[table];
    if (!rows || rows.length === 0) { console.log(`  ${table}: 0 rows, skipped`); continue; }

    const cols = Object.keys(rows[0]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const colNames = cols.map(c => `"${c}"`).join(', ');

    const colTypeMap = {};
    for (const c of (payload.schema[table]?.columns || [])) {
      colTypeMap[c.column_name] = c.data_type;
    }

    // Batch insert in chunks of 100
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values = chunk.flatMap(row => cols.map(c => formatValue(row[c], colTypeMap[c])));
      const paramSets = [];
      for (let j = 0; j < chunk.length; j++) {
        paramSets.push(cols.map((_, k) => `$${j * cols.length + k + 1}`).join(', '));
      }
      const valuesFlat = chunk.flatMap(row => cols.map(c => row[c]));
      const sql = `INSERT INTO "${table}" (${colNames}) VALUES ${paramSets.map(ps => `(${ps})`).join(', ')} ON CONFLICT DO NOTHING`;

      await pool.query(sql, valuesFlat);
      console.log(`  ${table}: ${Math.min(i + CHUNK, rows.length)}/${rows.length} rows`);
    }
  }

  await pool.end();
  console.log('\nImport complete!');
}

function formatValue(val, type) {
  if (val === null) return null;
  if (type === 'jsonb' || type === 'json') {
    return typeof val === 'string' ? val : JSON.stringify(val);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Verify Neon tables
// ---------------------------------------------------------------------------
async function verifyNeon() {
  const pool = neonPool();
  const tables = await getNeonTables(pool);
  console.log(`Neon has ${tables.length} tables\n`);

  for (const table of tables) {
    const r = await pool.query(`SELECT COUNT(*) as cnt, MAX(updated_at) as max_updated FROM "${table}"`);
    const firstR = await pool.query(`SELECT * FROM "${table}" LIMIT 1`);
    const cols = firstR.fields.map(f => f.name).slice(0, 5).join(', ');
    console.log(`  ${table}: ${r.rows[0].cnt} rows, last-updated: ${r.rows[0].max_updated}, cols: ${cols}...`);
  }

  await pool.end();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === 'export') {
  exportNeon().catch(e => { console.error(e); process.exit(1); });
} else if (cmd === 'import') {
  const renderUrl = args[1];
  if (!renderUrl) {
    console.error('Usage: node scripts/migrate-db.js import <render-database-url>');
    process.exit(1);
  }
  importToRender(renderUrl).catch(e => { console.error(e); process.exit(1); });
} else if (cmd === 'create-render') {
  createRenderPostgres().catch(e => { console.error(e); process.exit(1); });
} else if (cmd === 'verify') {
  verifyNeon().catch(e => { console.error(e); process.exit(1); });
} else {
  console.log('Usage: node scripts/migrate-db.js [export|import|verify|create-render]');
  console.log('  export        — dump Neon schema+data to neon-export.json');
  console.log('  import <url>  — import neon-export.json into Render PostgreSQL');
  console.log('  verify        — show Neon table stats');
  console.log('  create-render — create new Render PostgreSQL instance');
}