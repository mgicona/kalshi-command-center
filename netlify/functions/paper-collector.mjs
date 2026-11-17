
import { getStore } from '@netlify/blobs';

// Automatic paper testing only. No real trades.
const K = 'https://api.elections.kalshi.com/trade-api/v2';
const OHLC = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=15';
const STORE = 'kalshi-paper-tests';

const num = x =>
  x == null || x === '' ? null :
  Number.isFinite(Number(x)) ? Number(x) : null;

const cents = (m, side) =>
  num(m[side + '_ask_dollars']) != null
    ? num(m[side + '_ask_dollars']) * 100
    : num(m[side + '_ask']);

const closeAt = m => Date.parse(
  m.close_time || m.expiration_time ||
  m.expected_expiration_time || ''
);

async function json(url) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(), 7000
  );

  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal
    });

    if (!res.ok) throw Error('HTTP ' + res.status);

    const value = await res.json();

    if (Array.isArray(value.error) && value.error.length) {
      throw Error(value.error.join(', '));
    }

    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function ema(values, p) {
  if (values.length < p) return null;

  let value = values.slice(0, p)
    .reduce((a, b) => a + b, 0) / p;

  for (let i = p; i < values.length; i++) {
    value = values[i] * 2 / (p + 1) +
      value * (1 - 2 / (p + 1));
  }

  return value;
}

function rsi(values, p = 14) {
  if (values.length <= p) return null;

  let gain = 0, loss = 0;

  for (let i = 1; i <= p; i++) {
    const d = values[i] - values[i - 1];
    gain += Math.max(0, d);
    loss += Math.max(0, -d);
  }

  gain /= p;
  loss /= p;

  for (let i = p + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (p - 1) + Math.max(0, d)) / p;
    loss = (loss * (p - 1) + Math.max(0, -d)) / p;
  }

  return loss === 0
    ? (gain === 0 ? 50 : 100)
    : 100 - 100 / (1 + gain / loss);
}

async function snapshot(m, store, now) {
  const key = 'contract/' + m.ticker;

  if (await store.get(key)) return 'already logged';

  const data = await json(OHLC);
  const pair = Object.keys(data.result || {})
    .find(k => k !== 'last');

  if (!pair) throw Error('Missing Kraken candles');

  const rows = data.result[pair].map(r => ({
    time: +r[0],
    open: +r[1],
    close: +r[4],
    volume: +r[6]
  })).filter(c =>
    c.time + 900 <= now / 1000 - 2
  ).slice(-100);

  if (rows.length < 40) {
    throw Error('Not enough closed candles');
  }

  const last = rows.at(-1);
  const age = now / 1000 - last.time - 900;

  if (age < -60 || age > 960) {
    throw Error('Latest Kraken candle too old');
  }

  const closes = rows.map(r => r.close);
  const a = ema(closes, 9);
  const b = ema(closes, 21);
  const r = rsi(closes);

  const trend = a > b ? 'UP' :
    a < b ? 'DOWN' : 'FLAT';

  const volBase = rows.slice(-21, -1)
    .reduce((s, c) => s + c.volume, 0) / 20;

  const volumeRatio = volBase > 0
    ? last.volume / volBase : null;

  const checks = [
    trend !== 'FLAT',
    trend === 'UP' ? r >= 55 :
      trend === 'DOWN' ? r <= 45 : false,
    volumeRatio !== null && volumeRatio >= 1.2,
    trend === 'UP'
      ? last.close > last.open
      : trend === 'DOWN'
        ? last.close < last.open : false
  ];

  const record = {
    ticker: m.ticker,
    capturedAt: new Date(now).toISOString(),
    closeTime: m.close_time || m.expiration_time,
    candleClosedAt: new Date(
      (last.time + 900) * 1000
    ).toISOString(),
    trend,
    score: checks.filter(Boolean).length,
    rsi: r,
    ema9: a,
    ema21: b,
    volumeRatio,
    yesAskCents: cents(m, 'yes'),
    noAskCents: cents(m, 'no'),
    threshold: num(m.floor_strike) ??
      num(m.functional_strike),
    result: null,
    settledAt: null,
    note: 'Kraken trend only. No real trade.'
  };

  await store.setJSON(key, record);
  return 'saved ' + key;
}

async function settle(store, now) {
  let checked = 0, updated = 0;

  const listing = await store.list({
    prefix: 'contract/'
  });

  for (const item of listing.blobs) {
    const record = await store.get(item.key, {
      type: 'json'
    });

    if (!record || record.result ||
        Date.parse(record.closeTime) >= now) {
      continue;
    }

    if (checked >= 4) break;
    checked++;

    const data = await json(
      K + '/markets/' + encodeURIComponent(record.ticker)
    );

    const market = data.market;
    const result = String(
      market?.result || ''
    ).toLowerCase();

    if (result !== 'yes' && result !== 'no') {
      continue;
    }

    record.result = result;
    record.settledAt =
      market.settlement_ts ||
      market.settled_at ||
      new Date(now).toISOString();

    await store.setJSON(item.key, record);
    updated++;
  }

  return { checked, updated };
}

export default async () => {
  const now = Date.now();
  const store = getStore(STORE);

  const report = {
    at: new Date(now).toISOString(),
    snapshot: 'none',
    settlements: null,
    errors: []
  };

  try {
    const data = await json(
      K + '/markets?series_ticker=KXBTC15M&status=open&limit=100'
    );

    const active = (data.markets || [])
      .filter(m =>
        m.ticker &&
        ['active', 'open'].includes(
          String(m.status).toLowerCase()
        ) &&
        closeAt(m) > now
      )
      .sort((a, b) => closeAt(a) - closeAt(b));

    const market = active.find(m =>
      closeAt(m) - now >= 120000 &&
      closeAt(m) - now <= 300000
    );

    if (market) {
      report.snapshot = await snapshot(
        market, store, now
      );
    }
  } catch (e) {
    report.errors.push(
      'Snapshot: ' + String(e.message || e)
    );
  }

  try {
    report.settlements = await settle(store, now);
  } catch (e) {
    report.errors.push(
      'Settlement: ' + String(e.message || e)
    );
  }

  console.log(JSON.stringify(report));

  if (report.errors.length) {
    throw Error(report.errors.join('; '));
  }
};

// Scheduled every two minutes, UTC.
export const config = {
  schedule: '*/2 * * * *'
};
