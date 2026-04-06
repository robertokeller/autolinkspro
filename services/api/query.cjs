const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const envText = fs.readFileSync('D:/Code/AutoLinks!/.env.local', 'utf8');
  const m = envText.match(/DATABASE_URL=([^\r\n]+)/);
  const url = m[1].trim().replace(/^"|"$/g, '').replace(':5432/', ':6543/');
  
  const c = new Client({ connectionString: url });
  await c.connect();
  
  try {
    const res1 = await c.query('SELECT id, name, status, account_name, (cookies_json IS NULL) as pb_null, length(cookies_json::text) as ck_len FROM meli_sessions;');
    console.log('MELI SESSIONS:', res1.rows);
    
    const res2 = await c.query("SELECT app_id FROM api_credentials WHERE provider='meli_session_cookies';");
    console.log('API CREDENTIALS:', res2.rows);
  } catch(e) {
    console.error(e);
  } finally {
    await c.end();
  }
}
run();