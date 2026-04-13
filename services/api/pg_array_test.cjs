const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const envText = fs.readFileSync('D:/Code/AutoLinks!/.env.local', 'utf8');
  const m = envText.match(/DATABASE_URL=([^\r\n]+)/);
  const url = m[1].trim().replace(/^"|"$/g, '').replace(':5432/', ':6543/');
  
  const c = new Client({ connectionString: url });
  await c.connect();
  
  try {
    // Array of objects (simulating Mercado Livre cookies payload)
    const payload = [ { name: "test", value: "abc" }, { name: "test2", value: "def" } ];
    
    console.log("Saving array of objects...");
    const res = await c.query('UPDATE meli_sessions SET cookies_json = $1 RETURNING id', [payload]);
    
    console.log('Update result row count:', res.rowCount);
  } catch(e) {
    console.error('ERROR CAUGHT:', e.message);
  } finally {
    await c.end();
  }
}
run();