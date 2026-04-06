const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const envText = fs.readFileSync('D:/Code/AutoLinks!/.env.local', 'utf8');
  const m = envText.match(/DATABASE_URL=([^\r\n]+)/);
  const url = m[1].trim().replace(/^"|"$/g, '').replace(':5432/', ':6543/');
  
  const c = new Client({ connectionString: url });
  await c.connect();
  
  try {
    const r1 = await c.query('SELECT provider, app_id, region, user_id FROM api_credentials;');
    console.log('API CRED:', r1.rows);
  } catch(e) {
    console.error(e);
  } finally {
    await c.end();
  }
}
run();