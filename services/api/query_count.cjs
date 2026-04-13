const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const envText = fs.readFileSync('D:/Code/AutoLinks!/.env.local', 'utf8');
  const m = envText.match(/DATABASE_URL=([^\r\n]+)/);
  const url = m[1].trim().replace(/^"|"$/g, '').replace(':5432/', ':6543/');
  
  const c = new Client({ connectionString: url });
  await c.connect();
  
  try {
    const r1 = await c.query('SELECT count(*) as count FROM meli_sessions;');
    console.log('MELI SESSIONS count:', r1.rows[0].count);
    
    const r2 = await c.query("SELECT count(*) as count FROM api_credentials;");
    console.log('API CREDENTIALS count:', r2.rows[0].count);
  } catch(e) {
    console.error(e);
  } finally {
    await c.end();
  }
}
run();