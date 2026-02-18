import { Hono } from 'hono'
import { cors } from 'hono/cors'

// 1. Define our secure environment variables and DB connection
type Bindings = {
    DB: D1Database
    GOOGLE_API_KEY: string
    ULTRALINGUA_API_KEY: string
    ADMIN_TOKEN: string
}

const app = new Hono<{ Bindings: Bindings }>()

// 2. Allow your Chrome Extension to talk to this API safely
app.use('/*', cors())

// --- HELPER: RATE LIMITER & ANALYTICS ---
async function enforceRateLimit(db: D1Database, userId: string, apiType: 'google' | 'ultralingua') {
    const today = new Date().toISOString().split('T')[0]; // Gets YYYY-MM-DD
    const limit = 100; // 100 free requests per day per API (You can change this later!)

    // Ensure user exists in the DB (creates them if they don't)
    await db.prepare(`INSERT OR IGNORE INTO gube_users (id) VALUES (?)`).bind(userId).run();

    // Get today's usage for this specific user
    const usageRow = await db.prepare(
        `SELECT google_api_count, ultralingua_api_count FROM gube_usage WHERE user_id = ? AND usage_date = ?`
    ).bind(userId, today).first();

    const currentCount = apiType === 'google'
        ? (usageRow?.google_api_count as number || 0)
        : (usageRow?.ultralingua_api_count as number || 0);

    // If they hit the limit, block the request
    if (currentCount >= limit) {
        return false;
    }

    // If under limit, log the API call (Upsert logic)
    if (apiType === 'google') {
        await db.prepare(`
      INSERT INTO gube_usage (user_id, usage_date, google_api_count, ultralingua_api_count)
      VALUES (?, ?, 1, 0)
      ON CONFLICT(user_id, usage_date) DO UPDATE SET google_api_count = google_api_count + 1
    `).bind(userId, today).run();
    } else {
        await db.prepare(`
      INSERT INTO gube_usage (user_id, usage_date, google_api_count, ultralingua_api_count)
      VALUES (?, ?, 0, 1)
      ON CONFLICT(user_id, usage_date) DO UPDATE SET ultralingua_api_count = ultralingua_api_count + 1
    `).bind(userId, today).run();
    }

    return true; // Allowed!
}

// --- ENDPOINTS ---

// 3. Google Translate Proxy
app.post('/api/translate', async (c) => {
    const userId = c.req.header('x-user-id');
    if (!userId) return c.json({ error: 'Missing User ID' }, 400);

    const isAllowed = await enforceRateLimit(c.env.DB, userId, 'google');
    if (!isAllowed) return c.json({ error: 'Daily translation limit reached.' }, 429);

    const body = await c.req.json();

    const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${c.env.GOOGLE_API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });

    const data = await response.json();
    return c.json(data);
})

// 4. Ultralingua Definitions Proxy
app.get('/api/definitions/:sourceLang/:targetLang/:word', async (c) => {
    const userId = c.req.header('x-user-id');
    if (!userId) return c.json({ error: 'Missing User ID' }, 400);

    const isAllowed = await enforceRateLimit(c.env.DB, userId, 'ultralingua');
    if (!isAllowed) return c.json({ error: 'Daily dictionary limit reached.' }, 429);

    const { sourceLang, targetLang, word } = c.req.param();

    const response = await fetch(`https://api.ultralingua.com/api/2.0/definitions/${sourceLang}/${targetLang}/${encodeURIComponent(word)}?key=${c.env.ULTRALINGUA_API_KEY}`);

    if (!response.ok) return c.json([], response.status as any);

    const data = await response.json();
    return c.json(data);
})

// 5. Ultralingua Conjugations Proxy
app.get('/api/conjugations/:sourceLang/:word', async (c) => {
    const userId = c.req.header('x-user-id');
    if (!userId) return c.json({ error: 'Missing User ID' }, 400);

    const isAllowed = await enforceRateLimit(c.env.DB, userId, 'ultralingua');
    if (!isAllowed) return c.json({ error: 'Daily dictionary limit reached.' }, 429);

    const { sourceLang, word } = c.req.param();

    const response = await fetch(`https://api.ultralingua.com/api/2.0/conjugations/${sourceLang}/${encodeURIComponent(word)}?key=${c.env.ULTRALINGUA_API_KEY}`);

    if (!response.ok) return c.json([], response.status as any);

    const data = await response.json();
    return c.json(data);
})

// 6. Secure Admin Dashboard Endpoint (Upgraded for Charts)
app.get('/admin/stats', async (c) => {
    const token = c.req.header('Authorization');
    if (token !== `Bearer ${c.env.ADMIN_TOKEN}`) {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const today = new Date().toISOString().split('T')[0];

    // 1. Get Top-Level Stats
    const totalUsers = await c.env.DB.prepare(`SELECT COUNT(*) as count FROM gube_users`).first();
    const todaysUsage = await c.env.DB.prepare(`
    SELECT SUM(google_api_count) as google_total, SUM(ultralingua_api_count) as ultra_total 
    FROM gube_usage WHERE usage_date = ?
  `).bind(today).first();

    // 2. Get Last 7 Days of History for the Chart
    const historicalData = await c.env.DB.prepare(`
    SELECT usage_date, SUM(google_api_count) as google, SUM(ultralingua_api_count) as ultralingua
    FROM gube_usage
    GROUP BY usage_date
    ORDER BY usage_date DESC
    LIMIT 7
  `).all();

    // SQLite returns results in an array. We reverse it so the oldest date is on the left of the chart!
    const chartData = historicalData.results.reverse();

    return c.json({
        totalUsers: totalUsers?.count || 0,
        todaysApiCalls: {
            google: todaysUsage?.google_total || 0,
            ultralingua: todaysUsage?.ultra_total || 0
        },
        historicalUsage: chartData
    });
})

export default app

