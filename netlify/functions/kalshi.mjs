// Read-only, tightly scoped Kalshi public market-data proxy.
// No credentials, user account access, or trade endpoints.
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
export default async (request) => {
  const cors = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' };
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });
  const u = new URL(request.url);
  const suffix = u.pathname.split('/.netlify/functions/kalshi')[1] || '';
  const validList = suffix === '/markets' && u.searchParams.get('series_ticker') === 'KXBTC15M';
  const validDetail = /^\/markets\/KXBTC15M-[A-Za-z0-9-]+$/.test(suffix);
  if (!validList && !validDetail) return new Response(JSON.stringify({ error: 'Only BTC 15-minute market reads are allowed' }), { status: 400, headers: cors });
  const target = validList ? `${BASE}/markets?series_ticker=KXBTC15M&status=open&limit=100` : BASE + suffix;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let upstream;
    try { upstream = await fetch(target, { headers: { accept: 'application/json' }, signal: ctrl.signal }); }
    finally { clearTimeout(timer); }
    if (!upstream.ok) return new Response(JSON.stringify({ error: `Kalshi returned HTTP ${upstream.status}` }), { status: 502, headers: cors });
    const data = await upstream.json();
    return new Response(JSON.stringify(data), { status: 200, headers: cors });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Kalshi API request failed', detail: String(e?.message || e) }), { status: 502, headers: cors });
  }
};
export const config = { path: '/.netlify/functions/kalshi/*' };
