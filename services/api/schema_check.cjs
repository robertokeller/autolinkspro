const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const envText = fs.readFileSync('D:/Code/AutoLinks!/.env.local', 'utf8');
  const m = envText.match(/DATABASE_URL=([^\r\n]+)/);
  const url = m[1].trim().replace(/^"|"$/g, '').replace(':5432/', ':6543/');
  
  const c = new Client({ connectionString: url });
  await c.connect();
  
  try {
    const r1 = await c.query("SELECT column_name, data_type, character_maximum_length FROM information_schema.columns WHERE table_name = 'api_credentials';");
    console.log('API CRED SCHEMA:', r1.rows);
  } catch(e) {
    console.error(e);
  } finally {
    await c.end();
  }
}
run();