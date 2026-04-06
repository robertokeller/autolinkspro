const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const envText = fs.readFileSync('D:/Code/AutoLinks!/.env.local', 'utf8');
  const m = envText.match(/DATABASE_URL=([^\r\n]+)/);
  const url = m[1].trim().replace(/^"|"$/g, '').replace(':5432/', ':6543/');
  
  const c = new Client({ connectionString: url });
  await c.connect();
  
  try {
    const res = await c.query("SELECT event_object_table, trigger_name, action_statement FROM information_schema.triggers WHERE event_object_table = 'meli_sessions';");
    console.log('TRIGGERS:', res.rows);
  } catch(e) {
    console.error(e);
  } finally {
    await c.end();
  }
}
run();