const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const envText = fs.readFileSync('D:/Code/AutoLinks!/.env.local', 'utf8');
  const m = envText.match(/DATABASE_URL=([^\r\n]+)/);
  const url = m[1].trim().replace(/^"|"$/g, '').replace(':5432/', ':6543/');
  
  const c = new Client({ connectionString: url });
  await c.connect();
  
  try {
    const payload = JSON.stringify([{ name: "test", value: "abc" }]);
    const query = `
        INSERT INTO api_credentials (id, user_id, provider, app_id, secret_key, region)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)
        ON CONFLICT (user_id, provider) DO UPDATE
        SET app_id = EXCLUDED.app_id,
            secret_key = EXCLUDED.secret_key,
            region = EXCLUDED.region,
            updated_at = NOW()
    `;
    
    // using user_id from the meli_sessions table to be sure
    const userIdRes = await c.query('SELECT user_id FROM meli_sessions LIMIT 1');
    const uId = userIdRes.rows[0].user_id;

    console.log("Saving api_credentials...");
    const res = await c.query(query, [uId, 'meli_session_cookies', 'dummy_app_id', payload, 'internal']);
    
    console.log('Update result row count:', res.rowCount);
  } catch(e) {
    console.error('ERROR CAUGHT for INSERT:', e.message);
  } finally {
    await c.end();
  }
}
run();