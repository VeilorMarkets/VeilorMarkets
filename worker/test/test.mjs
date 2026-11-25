import worker, { fairLine, parseFX, quote, buildICS } from '../src/index.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log((c ? 'OK   ' : 'FAIL ') + n + (x ? '  ' + x : '')); };

/* ---- fake network ---- */
const sent = [];
const J = (x, status = 200) => Promise.resolve(new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } }));
const far = new Date(Date.now() + 40 * 86400000).toISOString();
let newEvents = [{ id: 'e0', slug: 'old', title: 'Old event', tags: [{ slug: 'crypto' }], markets: [] }];
let cgDown = false;
globalThis.fetch = async (u, o) => {
  u = String(u);
  if (cgDown && (u.includes('coingecko') || u.includes('binance.com'))) return J({}, 451);
  if (u.includes('api.kraken.com')) return J({ error: [], result: { BNBUSD: { c: ['551.5', '1'] }, PAXGUSD: { c: ['3543.8', '1'] } } });
  if (u.includes('api.coinbase.com')) { const m = /prices\/([A-Z]+)-USD/.exec(u); const v = { BTC: 91000, ETH: 3100, SOL: 141, XRP: 2.4, DOGE: 0.21, BNB: 700, PAXG: 3900 }[m[1]]; return v ? J({ data: { amount: String(v) } }) : J({}, 404); }
  if (u.includes('order=startDate')) return J(newEvents);
  if (u.includes('coingecko')) return J({ bitcoin: { usd: 90000 }, ethereum: { usd: 3000 }, solana: { usd: 140 }, ripple: { usd: 2.5 }, dogecoin: { usd: 0.2 }, binancecoin: { usd: 600 }, 'pax-gold': { usd: 2650 } });
  if (u.includes('/events?')) return J(u.includes('tag_slug') ? [] : [{ id: 'e1', slug: 'btc-dec', title: 'Bitcoin price', tags: [{ slug: 'crypto' }], markets: [
    { id: '11', question: 'Will Bitcoin be above $100,000 on Dec 31?', outcomes: '["Yes","No"]', outcomePrices: '["0.25","0.75"]', clobTokenIds: '["tokA","tokB"]', endDate: far, active: true, closed: false, volume24hr: 5000, liquidityNum: 9000 },
    { id: '12', question: 'Will Sabah FK win on 2026-11-25?', outcomes: '["Yes","No"]', outcomePrices: '["0.03","0.97"]', clobTokenIds: '["tokC","tokD"]', endDate: far, active: true, closed: false, volume24hr: 100 }] }]);
  if (u.includes('/markets/11')) return J({ id: '11', question: 'Will Bitcoin be above $100,000 on Dec 31?', outcomes: '["Yes","No"]', outcomePrices: '["0.25","0.75"]', clobTokenIds: '["tokA","tokB"]', endDate: far, description: 'rules text', slug: 'btc-dec' });
  if (u.includes('clob.polymarket.com/book')) return J({ bids: [{ price: '0.24', size: '100' }, { price: '0.23', size: '200' }], asks: [{ price: '0.26', size: '50' }, { price: '0.27', size: '500' }], tick_size: '0.01', min_order_size: '5' });
  if (u.includes('api.telegram.org')) { sent.push(JSON.parse(o.body)); return J({ ok: true }); }
  return J({}, 404);
};
const kv = new Map();
const env = { TG_TOKEN: 't', TG_SECRET: 's', ALERTS: {
  get: async (k) => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); }, delete: async (k) => { kv.delete(k); },
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) } };
const call = (path, init) => worker.fetch(new Request('https://w.test' + path, init), env, { waitUntil() {} });
const post = (path, body, headers = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/* ---- pure functions ---- */
const t = Date.now() + 30 * 86400000;
ok('fair above in 1..99', fairLine('BTC', 100000, t, 'above', 90000) > 0);
ok('fair above + below ~ 100', Math.abs(fairLine('BTC', 100000, t, 'above', 90000) + fairLine('BTC', 100000, t, 'below', 90000) - 100) < 0.2);
ok('touch >= above', fairLine('BTC', 100000, t, 'touch', 90000) >= fairLine('BTC', 100000, t, 'above', 90000));
ok('fair past date null', fairLine('BTC', 1, Date.now() - 1000, 'above', 90000) === null);
ok('parseFX dip', parseFX('Will Ethereum dip to $2,500 by Dec 31?').kind === 'touchdn');
ok('parseFX k suffix', parseFX('Will BTC hit $150k in 2026?').strike === 150000);
ok('parseFX none', parseFX('Will Sabah FK win?') === null);
const q = quote({ bids: [{ price: .24, size: 100 }], asks: [{ price: .26, size: 50 }, { price: .27, size: 500 }] }, 'buy', 100);
ok('quote avg', Math.abs(q.averagePrice - (50 * .26 + 50 * .27) / 100) < 1e-6, q.averagePrice);
ok('quote unfilled', quote({ bids: [], asks: [{ price: .5, size: 10 }] }, 'buy', 30).unfilledShares === 20);
ok('ics shape', /BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/.test(buildICS([{ id: '1', question: 'A, B; C', endDate: far, yesPrice: 50, url: 'https://x' }], 'T')));

/* ---- http ---- */
let r = await call('/api/health'); ok('health', r.status === 200 && (await r.json()).ok);
r = await call('/api/prices'); let j = await r.json(); ok('prices', j.prices.BTC === 90000 && j.prices.GOLD === 2650);
cgDown = true; r = await call('/api/prices'); j = await r.json();
ok('fallback fills all 7 assets', Object.keys(j.prices).length === 7 && j.missing.length === 0, JSON.stringify(j));
ok('BNB and GOLD come from Kraken, the rest from Coinbase', j.sources.BNB === 'kraken' && j.sources.GOLD === 'kraken' && j.sources.BTC === 'coinbase', JSON.stringify(j.sources));
ok('prices ok when CoinGecko answers', (cgDown = false, (await (await call('/api/prices')).json()).sources.BNB === 'coingecko'));
r = await call('/api/markets'); j = await r.json(); ok('markets', j.markets.length === 2, j.markets.length);
ok('market fair line only for crypto', j.markets.find((m) => m.id === '11').fairLine > 0 && j.markets.find((m) => m.id === '12').fairLine === null);
r = await call('/api/markets?category=Crypto'); j = await r.json(); ok('category filter', j.markets.every((m) => m.category === 'Crypto'));
r = await call('/api/market/11'); j = await r.json(); ok('market by id', j.id === '11' && j.description === 'rules text');
r = await call('/api/book?token_id=tokA&side=buy&shares=100'); j = await r.json(); ok('book + quote', j.quote.filledShares === 100 && j.bestAsk.price === 0.26);
r = await call('/api/book'); ok('book needs token', r.status === 400);
r = await call('/api/fair?asset=ETH&strike=3500&end=' + encodeURIComponent(far)); j = await r.json(); ok('fair endpoint', j.fairLinePercent > 0);
r = await call('/cal/all.ics'); const ics = await r.text(); ok('calendar', r.headers.get('content-type').includes('text/calendar') && ics.includes('BEGIN:VEVENT'));
r = await call('/nope'); ok('404', r.status === 404);
r = await call('/api/prices', { method: 'OPTIONS' }); ok('cors preflight', r.status === 204 && r.headers.get('access-control-allow-origin') === '*');

/* ---- MCP ---- */
r = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }); j = await r.json(); ok('mcp initialize', j.result.serverInfo.name === 'veilor');
r = await post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' }); ok('mcp notification 202', r.status === 202);
r = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' }); j = await r.json(); ok('mcp tools', j.result.tools.length === 5);
r = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_markets', arguments: { category: 'Crypto' } } }); j = await r.json(); ok('mcp list_markets', JSON.parse(j.result.content[0].text).length === 2);
r = await post('/mcp', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_order_book', arguments: { token_id: 'tokA', side: 'sell', shares: 250 } } }); j = await r.json(); ok('mcp book quote', JSON.parse(j.result.content[0].text).quote.filledShares === 250);
r = await post('/mcp', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }); j = await r.json(); ok('mcp tool error flagged', j.result.isError === true);
r = await post('/mcp', { jsonrpc: '2.0', id: 6, method: 'bogus' }); j = await r.json(); ok('mcp unknown method', j.error.code === -32601);
r = await call('/mcp'); ok('mcp GET 405', r.status === 405);

/* ---- Telegram ---- */
const tg = (text, chat = 42) => post('/tg/webhook', { message: { text, chat: { id: chat } } }, { 'x-telegram-bot-api-secret-token': 's' });
r = await post('/tg/webhook', { message: { text: '/start', chat: { id: 1 } } }); ok('webhook rejects no secret', r.status === 403);
await tg('/start'); ok('start sends help', sent.at(-1).text.includes('/alert BTC above'));
await tg('/alert BTC above 80000'); ok('alert stored', JSON.parse(kv.get('al:42')).length === 1);
await tg('/alert BTC sideways 1'); ok('bad alert rejected', sent.at(-1).text.startsWith('Use:'));
await tg('/alert ETH below 1000'); await tg('/alerts'); ok('alerts listed', sent.at(-1).text.includes('2. ETH below $1000'));
sent.length = 0;
let pending; await worker.scheduled({}, env, { waitUntil: (p) => { pending = p; } }); await pending;
ok('cron fired the BTC alert only', sent.length === 1 && sent[0].text.includes('BTC'), JSON.stringify(sent.map((x) => x.text)));
ok('fired alert removed, other kept', JSON.parse(kv.get('al:42')).length === 1 && JSON.parse(kv.get('al:42'))[0].sym === 'ETH');
await tg('/clear'); ok('clear', !kv.has('al:42'));
ok('index tracks chats', JSON.parse(kv.get('idx')).al.length === 0);

/* ---- market alerts ---- */
await tg('/markets bitcoin'); ok('markets search', sent.at(-1).text.includes('11 · Yes 25¢'), sent.at(-1).text);
await tg('/alert market 11 above 20'); ok('market alert stored', JSON.parse(kv.get('al:42'))[0].kind === 'market', sent.at(-1).text);
await tg('/alert market 11 above 20'); ok('market alert dedupe', sent.at(-1).text.startsWith('You already have'));
await tg('/alert market 11 below 10');
await tg('/alert market 999 above 50'); ok('unknown market rejected', sent.at(-1).text.startsWith('Market not found'));
await tg('/alert market 11 above 150'); ok('bad level rejected', sent.at(-1).text.startsWith('Use:'));
await tg('/alert BTC above 80000');
await tg('/alerts'); ok('alerts list mixes kinds', sent.at(-1).text.includes('Yes above 20¢') && sent.at(-1).text.includes('BTC above $80000'), sent.at(-1).text);
sent.length = 0;
await worker.scheduled({}, env, { waitUntil: (p) => { pending = p; } }); await pending;
ok('cron fired market + spot alert', sent.length === 2 && sent.some((x) => x.text.includes('Yes is 25¢')) && sent.some((x) => x.text.startsWith('BTC is')), JSON.stringify(sent.map((x) => x.text)));
ok('only the below-10 alert remains', JSON.parse(kv.get('al:42')).length === 1 && JSON.parse(kv.get('al:42'))[0].dir === 'below');

/* ---- new market watches ---- */
await tg('/watch Nope'); ok('unknown category', sent.at(-1).text.startsWith('Unknown category'));
await tg('/watch crypto'); ok('watch stored', JSON.parse(kv.get('wl:42')).join() === 'Crypto', sent.at(-1).text);
await tg('/watch Crypto'); ok('watch dedupe', sent.at(-1).text.startsWith('You already watch'));
await tg('/watch Sports', 43);
sent.length = 0;
await worker.scheduled({}, env, { waitUntil: (p) => { pending = p; } }); await pending;
ok('first run only remembers events', sent.length === 0 && JSON.parse(kv.get('seen:v1')).includes('e0'));
newEvents = [{ id: 'e9', slug: 'btc-new', title: 'Bitcoin new market', tags: [{ slug: 'crypto' }], markets: [] }, ...newEvents];
await worker.scheduled({}, env, { waitUntil: (p) => { pending = p; } }); await pending;
ok('new Crypto market notified once, to the right chat', sent.length === 1 && String(sent[0].chat_id) === '42' && sent[0].text.includes('Bitcoin new market'), JSON.stringify(sent.map((x) => [x.chat_id, x.text])));
sent.length = 0;
await worker.scheduled({}, env, { waitUntil: (p) => { pending = p; } }); await pending;
ok('not notified twice', sent.length === 0);
await tg('/unwatch crypto'); ok('unwatch', !kv.has('wl:42') && sent.at(-1).text.startsWith('Stopped'));
await tg('/clear'); await tg('/clear', 43);
ok('clear wipes alerts and watches', !kv.has('al:42') && !kv.has('wl:42') && !kv.has('wl:43'));
ok('index emptied', JSON.parse(kv.get('idx')).al.length === 0 && JSON.parse(kv.get('idx')).wl.length === 0);
const listCalls = []; const origList = env.ALERTS.list; env.ALERTS.list = async (o) => { listCalls.push(o); return origList(o); };
await worker.scheduled({}, env, { waitUntil: (p) => { pending = p; } }); await pending;
ok('cron makes no KV list calls once indexed', listCalls.length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
