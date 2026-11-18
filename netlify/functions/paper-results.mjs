
import { getStore } from '@netlify/blobs';

// Read-only paper-testing results.
// No account access or trading.
export default async (request) => {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  };

  if (request.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers }
    );
  }

  try {
    const store = getStore('kalshi-paper-tests');
    const records = [];
    let cursor;
    let more = true;

    while (more && records.length < 500) {
      const options = {
        prefix: 'contract/',
        paginate: true
      };

      if (cursor) options.cursor = cursor;

      const page = await store.list(options);

      for (const item of page.blobs || []) {
        if (records.length >= 500) break;

        const record = await store.get(item.key, {
          type: 'json'
        });

        if (record && record.ticker) {
          records.push(record);
        }
      }

      cursor = page.cursor;
      more = Boolean(cursor);
    }

    records.sort((a, b) =>
      String(b.capturedAt || '').localeCompare(
        String(a.capturedAt || '')
      )
    );

    const settled = records.filter(
      r => r.result === 'yes' || r.result === 'no'
    );

    const matches = settled.filter(r =>
      (r.trend === 'UP' && r.result === 'yes') ||
      (r.trend === 'DOWN' && r.result === 'no')
    ).length;

    const evaluated = settled.filter(r =>
      r.trend === 'UP' || r.trend === 'DOWN'
    );

    const summary = {
      total: records.length,
      settled: settled.length,
      pending: records.length - settled.length,
      evaluated: evaluated.length,
      matches,
      matchRate: evaluated.length
        ? matches / evaluated.length * 100
        : null
    };

    return new Response(
      JSON.stringify({
        summary,
        records,
        truncated: more
      }),
      { status: 200, headers }
    );
  } catch (error) {
    console.error('Paper results error:', error);

    return new Response(
      JSON.stringify({
        error: 'Unable to retrieve paper-test results'
      }),
      { status: 500, headers }
    );
  }
};
