/**
 * Veilor backend (Cloudflare Worker)
 *
 *   GET  /api/health
 *   GET  /api/prices                       spot prices
 *   GET  /api/markets?category=&q=&limit=  live Polymarket markets (+ model fair line)
 *   GET  /api/market/:id                   one market
 *   GET  /api/book?token_id=&side=&shares= order book (+ quote when side and shares are given)
 *   GET  /api/fair?asset=&strike=&end=&kind=
 *   GET  /cal/:category.ics                settlement dates as a calendar feed
 *   POST /mcp                              MCP server (JSON-RPC over HTTP)
 *   POST /tg/webhook                       Telegram bot (spot, market and new-market alerts)
 *   cron (every minute)                    checks alerts and messages Telegram
 *
 * It is read-only: it never signs, routes or places orders and holds no funds.
 * Fair lines are a simple lognormal estimate and can be wrong.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const SITE = 'https://veilormarkets.github.io/VeilorMarkets/';

const ASSETS = {
  BTC: { vol: 0.45, cg: 'bitcoin', bn: 'BTCUSDT', cb: 'BTC' },
  ETH: { vol: 0.62, cg: 'ethereum', bn: 'ETHUSDT', cb: 'ETH' },
  SOL: { vol: 0.85, cg: 'solana', bn: 'SOLUSDT', cb: 'SOL' },
  XRP: { vol: 0.75, cg: 'ripple', bn: 'XRPUSDT', cb: 'XRP' },
  DOGE: { vol: 0.95, cg: 'dogecoin', bn: 'DOGEUSDT', cb: 'DOGE' },
  BNB: { vol: 0.5, cg: 'binancecoin', bn: 'BNBUSDT', cb: null },
  GOLD: { vol: 0.16, cg: 'pax-gold', bn: 'PAXGUSDT', cb: null },
};
const NAMES = { bitcoin: 'BTC', btc: 'BTC', ethereum: 'ETH', eth: 'ETH', solana: 'SOL', sol: 'SOL', xrp: 'XRP', ripple: 'XRP', dogecoin: 'DOGE', doge: 'DOGE', bnb: 'BNB', gold: 'GOLD' };

const CATMAP = [
  ['Sports', /sport|nba|nfl|nhl|mlb|soccer|epl|premier|champions|world-cup|tennis|golf|f1|ufc|mma|olympic|cricket|basketball|football|baseball/],
  ['Crypto', /crypto|bitcoin|ethereum|solana|defi|btc|eth\b/],
  ['Commodities', /commodit|gold|silver|oil|crude/],
  ['IPO', /ipo/],
  ['Equities', /stock|equit|earnings|nasdaq|s-p|tech|finance/],
  ['Macro', /econom|fed|inflation|cpi|rate|recession|jobs|gdp|tariff/],
  ['Awards', /award|oscar|grammy|emmy|culture|movie|music|celebrity|pop/],
  ['Politics', /politic|election|trump|president|congress|senate|geopolit|world|war|china|russia|ukraine|israel/],
];

/* ---------- helpers ---------- */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,mcp-session-id,mcp-protocol-version,authorization',
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=10', ...CORS, ...extra },
  });
}

async function getJSON(url, ttl = 30) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'veilor-worker' }, cf: { cacheTtl: ttl, cacheEverything: true } });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

const num = (v, d = null) => { if (v === null || v === undefined || v === '') return d; const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ---------- fair line model (same as the website) ---------- */

function Phi(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function pAbove(S, K, endMs, vol, now = Date.now()) {
  const t = Math.max((endMs - now) / 31557600000, 1 / 365 / 24);
  const sd = vol * Math.sqrt(t);
  return Phi(Math.log(S / K) / sd - sd / 2);
}
/** kind: above | below | touch | touchdn. Returns a percentage 1..99 or null. */
function fairLine(asset, K, endMs, kind, S, now = Date.now()) {
  const c = ASSETS[asset];
  if (!c || !S || !K || !endMs || endMs < now) return null;
  const pa = pAbove(S, K, endMs, c.vol, now) * 100;
  let f;
  if (kind === 'above') f = pa;
  else if (kind === 'below') f = 100 - pa;
  else if (kind === 'touch') f = S >= K ? 99 : Math.min(99, pa * 2);
  else f = S <= K ? 99 : Math.min(99, (100 - pa) * 2);
  return Math.max(1, Math.min(99, +f.toFixed(1)));
}
function parseFX(q) {
  const m = /\b(bitcoin|btc|ethereum|eth|solana|sol|xrp|ripple|dogecoin|doge|bnb|gold)\b[^$0-9]{0,40}?(above|over|exceed|reach|hit|touch|climb to|rise to|dip to|fall to|drop to|below|under)[^$0-9]{0,20}\$?([\d,]+(?:\.\d+)?)\s*(k|m)?/i.exec(q || '');
  if (!m) return null;
  let K = parseFloat(m[3].replace(/,/g, ''));
  if (/^k$/i.test(m[4] || '')) K *= 1000;
  if (/^m$/i.test(m[4] || '')) K *= 1e6;
  if (!isFinite(K) || K <= 0) return null;
  if (/\b(between|range)\b/i.test(q)) return null;
  const w = m[2].toLowerCase();
  const kind = /above|over|exceed/.test(w) ? 'above' : /below|under/.test(w) ? 'below' : /dip|fall|drop/.test(w) ? 'touchdn' : 'touch';
  return { asset: NAMES[m[1].toLowerCase()], strike: K, kind };
}

/* ---------- prices ---------- */

async function getPrices() {
  const out = {};
  // CoinGecko first, because Binance blocks some data-centre regions.
  try {
    const ids = Object.values(ASSETS).map((a) => a.cg).join(',');
    const a = await getJSON(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`, 20);
    for (const [k, c] of Object.entries(ASSETS)) if (a[c.cg] && a[c.cg].usd) out[k] = a[c.cg].usd;
  } catch (e) { /* fall through */ }
  const missing = Object.keys(ASSETS).filter((k) => out[k] == null);
  if (missing.length) {
    try {
      const syms = missing.map((k) => ASSETS[k].bn);
      const a = await getJSON('https://api.binance.com/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(syms)), 10);
      for (const k of missing) { const x = a.find((y) => y.symbol === ASSETS[k].bn); if (x) out[k] = +x.price; }
    } catch (e) { /* fall through */ }
  }
  for (const k of Object.keys(ASSETS)) {
    if (out[k] != null || !ASSETS[k].cb) continue;
    try { out[k] = +(await getJSON(`https://api.coinbase.com/v2/prices/${ASSETS[k].cb}-USD/spot`, 10)).data.amount; } catch (e) { /* ignore */ }
  }
  return out;
}

/* ---------- markets ---------- */

function catOf(ev) {
  const t = ((ev.tags || []).map((x) => x.slug || x.label || '').join(' ') + ' ' + (ev.title || '')).toLowerCase();
  for (const [c, r] of CATMAP) if (r.test(t)) return c;
  return 'Other';
}
function parseArr(v) { if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } } return v; }

function mapMarket(ev, x, prices) {
  const o = parseArr(x.outcomes), p = parseArr(x.outcomePrices), tk = parseArr(x.clobTokenIds);
  if (!o || !p || o[0] !== 'Yes') return null;
  const end = Date.parse(x.endDate);
  const fx = parseFX(x.question);
  const yes = +(parseFloat(p[0]) * 100).toFixed(2);
  const m = {
    id: String(x.id),
    question: x.question,
    category: catOf(ev),
    yesPrice: yes,
    noPrice: +(100 - yes).toFixed(2),
    volume24h: num(x.volume24hr, 0),
    liquidity: num(x.liquidityNum, num(x.liquidity, 0)),
    bestBid: x.bestBid != null ? num(x.bestBid) : null,
    bestAsk: x.bestAsk != null ? num(x.bestAsk) : null,
    endDate: x.endDate || null,
    negRisk: !!x.negRisk,
    feesEnabled: !!x.feesEnabled,
    resolutionSource: x.resolutionSource || '',
    url: 'https://polymarket.com/event/' + (ev.slug || x.slug),
    yesTokenId: tk && tk[0] ? String(tk[0]) : null,
    fairLine: null,
    fairLineNote: 'Model estimate for crypto and gold price questions only. Can be wrong.',
  };
  if (fx && prices && prices[fx.asset]) m.fairLine = fairLine(fx.asset, fx.strike, end, fx.kind, prices[fx.asset]);
  return m;
}

async function listMarkets({ category, q, limit = 50 } = {}) {
  const G = `${GAMMA}/events?active=true&closed=false&order=volume24hr&ascending=false`;
  const [a, b, prices] = await Promise.all([
    getJSON(G + '&limit=80', 30),
    getJSON(G + '&limit=40&tag_slug=crypto', 30).catch(() => []),
    getPrices().catch(() => ({})),
  ]);
  const seen = new Set();
  const evs = [...a, ...(Array.isArray(b) ? b : [])].filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
  let list = [];
  for (const ev of evs) {
    const ms = (ev.markets || []).filter((x) => x.active && !x.closed)
      .sort((x, y) => num(y.volume24hr, 0) - num(x.volume24hr, 0))
      .slice(0, (ev.markets || []).length > 6 ? 6 : 3);
    for (const x of ms) { const m = mapMarket(ev, x, prices); if (m) list.push(m); }
  }
  if (category && category.toLowerCase() !== 'all') list = list.filter((m) => m.category.toLowerCase() === category.toLowerCase());
  if (q) { const s = q.toLowerCase(); list = list.filter((m) => m.question.toLowerCase().includes(s)); }
  list.sort((x, y) => y.volume24h - x.volume24h);
  return list.slice(0, Math.max(1, Math.min(200, limit)));
}

async function getMarket(id) {
  const x = await getJSON(`${GAMMA}/markets/${encodeURIComponent(id)}`, 30);
  const prices = await getPrices().catch(() => ({}));
  const m = mapMarket({ slug: (x.events && x.events[0] && x.events[0].slug) || x.slug, tags: [], title: x.question }, x, prices);
  if (!m) throw new Error('Not a Yes/No market');
  m.description = x.description || '';
  return m;
}

/* ---------- order book and quote ---------- */

async function getBook(tokenId) {
  const b = await getJSON(`${CLOB}/book?token_id=${encodeURIComponent(tokenId)}`, 3);
  const norm = (l) => (l || []).map((x) => ({ price: +x.price, size: +x.size })).filter((x) => x.size > 0);
  return {
    bids: norm(b.bids).sort((x, y) => y.price - x.price),
    asks: norm(b.asks).sort((x, y) => x.price - y.price),
    tickSize: num(b.tick_size), minOrderSize: num(b.min_order_size),
  };
}
/** Walks the visible book. side: buy | sell. Returns shares that fill now, average price, impact and cost. */
function quote(book, side, shares) {
  const levels = side === 'sell' ? book.bids : book.asks;
  let left = shares, cost = 0, filled = 0;
  for (const l of levels) { if (left <= 0) break; const t = Math.min(left, l.size); cost += t * l.price; filled += t; left -= t; }
  const best = levels.length ? levels[0].price : null;
  const avg = filled ? cost / filled : null;
  return {
    side, requestedShares: shares, filledShares: +filled.toFixed(4), unfilledShares: +Math.max(0, shares - filled).toFixed(4),
    bestPrice: best, averagePrice: avg == null ? null : +avg.toFixed(5),
    priceImpactPoints: avg == null || best == null ? null : +(Math.abs(avg - best) * 100).toFixed(3),
    notional: +cost.toFixed(4),
    note: 'Visible book only, venue fees not included. A real order may fill differently.',
  };
}

/* ---------- calendar feed ---------- */

const icsEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function buildICS(markets, name) {
  const now = icsDate(Date.now());
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Veilor//Markets//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEsc(name)}`];
  for (const m of markets) {
    const end = Date.parse(m.endDate);
    if (!isFinite(end)) continue;
    lines.push('BEGIN:VEVENT', `UID:veilor-${m.id}@veilormarkets`, `DTSTAMP:${now}`, `DTSTART:${icsDate(end)}`, `DTEND:${icsDate(end + 3600000)}`,
      `SUMMARY:${icsEsc('Settles: ' + m.question)}`,
      `DESCRIPTION:${icsEsc(`Yes ${m.yesPrice}% at ${new Date().toISOString().slice(0, 10)}. Read the rules on the venue before you trade. ${m.url}`)}`,
      `URL:${m.url}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/* ---------- MCP server (JSON-RPC over HTTP) ---------- */

const TOOLS = [
  { name: 'list_markets', description: 'List live Polymarket markets with prices, volume, settlement date and, for crypto/gold price questions, a model fair line.',
    inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'All, Sports, Crypto, Politics, Macro, Equities, Commodities, IPO, Awards or Other' }, query: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'get_market', description: 'Get one market by its Polymarket market id, with its rules text.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_order_book', description: 'Live order book for a Yes token id, with an optional quote for a buy or sell of N shares.',
    inputSchema: { type: 'object', properties: { token_id: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, shares: { type: 'number' } }, required: ['token_id'] } },
  { name: 'get_prices', description: 'Spot prices in USD for BTC, ETH, SOL, XRP, DOGE, BNB and gold.', inputSchema: { type: 'object', properties: {} } },
  { name: 'fair_line', description: 'Model probability (percent) that an asset price is above/below/reaches a strike by a date. A simple lognormal estimate that can be wrong.',
    inputSchema: { type: 'object', properties: { asset: { type: 'string', enum: Object.keys(ASSETS) }, strike: { type: 'number' }, end: { type: 'string', description: 'ISO date or time' }, kind: { type: 'string', enum: ['above', 'below', 'touch', 'touchdn'] } }, required: ['asset', 'strike', 'end'] } },
];

async function callTool(name, a = {}) {
  switch (name) {
    case 'list_markets': return listMarkets({ category: a.category, q: a.query, limit: num(a.limit, 25) });
    case 'get_market': if (!a.id) throw new Error('id is required'); return getMarket(a.id);
    case 'get_order_book': {
      if (!a.token_id) throw new Error('token_id is required');
      const b = await getBook(a.token_id);
      const out = { bestBid: b.bids[0] || null, bestAsk: b.asks[0] || null, bids: b.bids.slice(0, 15), asks: b.asks.slice(0, 15) };
      if (a.side && a.shares) out.quote = quote(b, a.side === 'sell' ? 'sell' : 'buy', num(a.shares, 0));
      return out;
    }
    case 'get_prices': return getPrices();
    case 'fair_line': {
      const prices = await getPrices();
      const end = Date.parse(a.end);
      if (!ASSETS[a.asset]) throw new Error('unknown asset');
      if (!isFinite(end)) throw new Error('end must be a valid date');
      return { asset: a.asset, spot: prices[a.asset] ?? null, strike: a.strike, kind: a.kind || 'above', fairLinePercent: fairLine(a.asset, num(a.strike), end, a.kind || 'above', prices[a.asset]),
        note: 'Simple lognormal estimate with a fixed volatility. It can be wrong.' };
    }
    default: throw new Error('Unknown tool ' + name);
  }
}

async function rpcOne(msg) {
  const id = msg.id;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (msg.id === undefined) return null; // notification
  try {
    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-03-26', capabilities: { tools: {} },
          serverInfo: { name: 'veilor', version: '1.0.0' },
          instructions: 'Read-only prediction market data. It cannot place orders. Fair lines are simple model estimates and can be wrong.' });
      case 'ping': return ok({});
      case 'tools/list': return ok({ tools: TOOLS });
      case 'tools/call': {
        const p = msg.params || {};
        try { const r = await callTool(p.name, p.arguments || {}); return ok({ content: [{ type: 'text', text: JSON.stringify(r) }] }); }
        catch (e) { return ok({ isError: true, content: [{ type: 'text', text: String(e.message || e) }] }); }
      }
      default: return err(-32601, 'Method not found: ' + msg.method);
    }
  } catch (e) { return err(-32603, String(e.message || e)); }
}

async function handleMCP(request) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  if (Array.isArray(body)) {
    const res = (await Promise.all(body.map(rpcOne))).filter(Boolean);
    return res.length ? json(res, 200, { 'cache-control': 'no-store' }) : new Response(null, { status: 202, headers: CORS });
  }
  const r = await rpcOne(body);
  return r ? json(r, 200, { 'cache-control': 'no-store' }) : new Response(null, { status: 202, headers: CORS });
}

/* ---------- Telegram alerts ---------- */

const WATCH_CATS = ['All', 'Sports', 'Crypto', 'Commodities', 'IPO', 'Equities', 'Macro', 'Awards', 'Politics', 'Other'];
const HELP = [
  'Veilor alerts (read-only, never trades for you)',
  '',
  'Spot price:',
  '/alert BTC above 100000',
  '/alert ETH below 2500',
  '',
  'Market Yes price (in cents):',
  '/markets bitcoin  - find a market id',
  '/alert market 12345 above 60',
  '',
  'New markets:',
  '/watch Crypto  - tell me when a new Crypto market appears',
  '/unwatch Crypto',
  '',
  '/alerts  - list everything',
  '/clear  - delete all alerts and watches',
  '',
  'Spot assets: ' + Object.keys(ASSETS).join(', '),
  'Categories: ' + WATCH_CATS.join(', '),
  'Checked every minute. Alerts fire once. Not financial advice.',
].join('\n');

async function tgSend(env, chatId, text) {
  if (!env.TG_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
}

const alKey = (chatId) => 'al:' + chatId;
const wlKey = (chatId) => 'wl:' + chatId;
async function kvJSON(env, k, d) { const v = await env.ALERTS.get(k); try { return v ? JSON.parse(v) : d; } catch (e) { return d; } }
const loadAlerts = (env, chat) => kvJSON(env, alKey(chat), []);
const loadWatches = (env, chat) => kvJSON(env, wlKey(chat), []);

/* An index of chat ids avoids KV list calls every minute (the free plan allows only 1,000 list calls a day). */
async function loadIdx(env) {
  const i = await kvJSON(env, 'idx', null);
  if (i && Array.isArray(i.al) && Array.isArray(i.wl)) return i;
  const built = { al: [], wl: [] };
  for (const [t, prefix] of [['al', 'al:'], ['wl', 'wl:']]) {
    let cursor;
    do { const r = await env.ALERTS.list({ prefix, cursor }); built[t].push(...r.keys.map((k) => k.name.slice(3))); cursor = r.list_complete ? undefined : r.cursor; } while (cursor);
  }
  await env.ALERTS.put('idx', JSON.stringify(built));
  return built;
}
async function idxSet(env, type, chat, on) {
  const i = await loadIdx(env), c = String(chat), has = i[type].includes(c);
  if (on === has) return;
  i[type] = on ? [...i[type], c] : i[type].filter((x) => x !== c);
  await env.ALERTS.put('idx', JSON.stringify(i));
}
async function saveAlerts(env, chat, a) {
  if (a.length) { await env.ALERTS.put(alKey(chat), JSON.stringify(a)); await idxSet(env, 'al', chat, true); }
  else { await env.ALERTS.delete(alKey(chat)); await idxSet(env, 'al', chat, false); }
}
async function saveWatches(env, chat, w) {
  if (w.length) { await env.ALERTS.put(wlKey(chat), JSON.stringify(w)); await idxSet(env, 'wl', chat, true); }
  else { await env.ALERTS.delete(wlKey(chat)); await idxSet(env, 'wl', chat, false); }
}

const fmtAlert = (x) => (x.kind === 'market' ? `Market ${x.id}: "${x.q}" Yes ${x.dir} ${x.level}¢` : `${x.sym} ${x.dir} $${x.level}`);
const sameAlert = (x, y) => (x.kind || 'spot') === (y.kind || 'spot') && x.dir === y.dir && x.level === y.level && x.sym === y.sym && x.id === y.id;
const cleanLevel = (v) => num(String(v || '').replace(/[$,¢%]/g, ''));
const catName = (v) => WATCH_CATS.find((c) => c.toLowerCase() === String(v || '').toLowerCase());

async function handleTelegram(request, env) {
  if (!env.TG_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });
  if (!env.ALERTS) return new Response('KV binding ALERTS missing', { status: 500 });
  let up; try { up = await request.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
  const msg = up.message || up.edited_message;
  if (!msg || !msg.text) return new Response('ok');
  const chat = msg.chat.id, text = msg.text.trim();
  const [cmdRaw, ...args] = text.split(/\s+/);
  const cmd = cmdRaw.split('@')[0].toLowerCase();
  const say = async (t) => { await tgSend(env, chat, t); return new Response('ok'); };

  if (cmd === '/start' || cmd === '/help') return say(HELP);

  if (cmd === '/alerts') {
    const a = await loadAlerts(env, chat), w = await loadWatches(env, chat);
    const lines = a.map((x, i) => `${i + 1}. ${fmtAlert(x)}`);
    if (w.length) lines.push('', 'Watching new markets: ' + w.join(', '));
    return say(lines.length ? lines.join('\n') : 'Nothing yet. Try: /alert BTC above 100000');
  }

  if (cmd === '/clear') {
    await saveAlerts(env, chat, []); await saveWatches(env, chat, []);
    return say('All alerts and watches deleted.');
  }

  if (cmd === '/markets') {
    const q = args.join(' ').trim();
    if (!q) return say('Use: /markets bitcoin');
    const list = await listMarkets({ q, limit: 5 }).catch(() => null);
    if (!list) return say('Could not reach the market source. Try again in a minute.');
    if (!list.length) return say('No match among the most active markets. Try another word.');
    return say(list.map((m) => `${m.id} · Yes ${m.yesPrice}¢ · ${m.question}`).join('\n') + '\n\nSet an alert: /alert market <id> above 60');
  }

  if (cmd === '/watch') {
    const c = catName(args[0]);
    const w = await loadWatches(env, chat);
    if (!args[0]) return say((w.length ? 'Watching: ' + w.join(', ') + '\n\n' : '') + 'Use: /watch Crypto\nCategories: ' + WATCH_CATS.join(', '));
    if (!c) return say('Unknown category. Choose: ' + WATCH_CATS.join(', '));
    if (w.includes(c)) return say(`You already watch ${c}.`);
    if (w.length >= 5) return say('You can watch at most 5 categories. Use /unwatch first.');
    w.push(c); await saveWatches(env, chat, w);
    return say(`Watching new ${c} markets. I will message you when one appears.`);
  }

  if (cmd === '/unwatch') {
    const w = await loadWatches(env, chat);
    if ((args[0] || '').toLowerCase() === 'all') { await saveWatches(env, chat, []); return say('Stopped watching all categories.'); }
    const c = catName(args[0]);
    if (!c || !w.includes(c)) return say('Use: /unwatch Crypto  (or /unwatch all)');
    await saveWatches(env, chat, w.filter((x) => x !== c));
    return say(`Stopped watching ${c}.`);
  }

  if (cmd === '/alert') {
    const a = await loadAlerts(env, chat);
    let item;
    if ((args[0] || '').toLowerCase() === 'market') {
      const id = (args[1] || '').replace(/\D/g, ''), dir = (args[2] || '').toLowerCase(), level = cleanLevel(args[3]);
      if (!id || !['above', 'below'].includes(dir) || !(level > 0 && level < 100)) return say('Use: /alert market 12345 above 60  (price in cents, 1 to 99)');
      let x; try { x = await getJSON(`${GAMMA}/markets/${id}`, 10); } catch (e) { return say('Market not found. Find an id with /markets bitcoin'); }
      const o = parseArr(x.outcomes), p = parseArr(x.outcomePrices);
      if (!o || !p || o[0] !== 'Yes') return say('That market is not a Yes/No market.');
      if (x.closed) return say('That market is already closed.');
      item = { kind: 'market', id, q: String(x.question || '').slice(0, 70), dir, level, created: Date.now() };
      if (a.length >= 10) return say('You can have at most 10 alerts. Use /clear first.');
      if (a.some((y) => sameAlert(y, item))) return say(`You already have this alert: ${fmtAlert(item)}`);
      a.push(item); await saveAlerts(env, chat, a);
      return say(`Alert set: "${item.q}" Yes ${dir} ${level}¢ (now ${+(parseFloat(p[0]) * 100).toFixed(2)}¢)`);
    }
    const sym = (args[0] || '').toUpperCase(), dir = (args[1] || '').toLowerCase(), level = cleanLevel(args[2]);
    if (!ASSETS[sym] || !['above', 'below'].includes(dir) || !(level > 0)) return say('Use: /alert BTC above 100000\nor: /alert market 12345 above 60');
    item = { sym, dir, level, created: Date.now() };
    if (a.length >= 10) return say('You can have at most 10 alerts. Use /clear first.');
    if (a.some((y) => sameAlert(y, item))) return say(`You already have this alert: ${fmtAlert(item)}`);
    a.push(item); await saveAlerts(env, chat, a);
    return say(`Alert set: ${fmtAlert(item)}`);
  }
  return say(HELP);
}

const hitDir = (dir, v, level) => (dir === 'above' ? v >= level : v <= level);

async function checkNewMarkets(env, chats) {
  const evs = await getJSON(`${GAMMA}/events?active=true&closed=false&order=startDate&ascending=false&limit=30`, 30).catch(() => null);
  if (!Array.isArray(evs) || !evs.length) return 0;
  const ids = evs.map((e) => String(e.id));
  const seen = await kvJSON(env, 'seen:v1', null);
  if (!Array.isArray(seen)) { await env.ALERTS.put('seen:v1', JSON.stringify(ids)); return 0; } // first run: remember, do not notify
  const known = new Set(seen);
  const fresh = evs.filter((e) => !known.has(String(e.id)));
  if (!fresh.length) return 0;
  await env.ALERTS.put('seen:v1', JSON.stringify([...new Set([...ids, ...seen])].slice(0, 300)));
  const subs = {};
  for (const c of chats) subs[c] = await loadWatches(env, c);
  let n = 0;
  for (const ev of fresh.slice(0, 5)) {
    const cat = catOf(ev);
    for (const c of chats) {
      if (subs[c].includes('All') || subs[c].includes(cat)) { await tgSend(env, c, `New market (${cat}): ${ev.title}\nhttps://polymarket.com/event/${ev.slug}`); n++; }
    }
  }
  return n;
}

async function checkAlerts(env) {
  if (!env.ALERTS || !env.TG_TOKEN) return { checked: 0, fired: 0, newMarkets: 0 };
  const idx = await loadIdx(env);
  let fired = 0, newMarkets = 0;
  if (idx.al.length) {
    const lists = {};
    for (const c of idx.al) lists[c] = await loadAlerts(env, c);
    const all = Object.values(lists).flat();
    const prices = all.some((x) => (x.kind || 'spot') === 'spot') ? await getPrices().catch(() => ({})) : {};
    const mids = [...new Set(all.filter((x) => x.kind === 'market').map((x) => x.id))].slice(0, 20);
    const mk = {};
    await Promise.all(mids.map(async (id) => {
      try { const x = await getJSON(`${GAMMA}/markets/${id}`, 15), p = parseArr(x.outcomePrices); mk[id] = { yes: p ? +(parseFloat(p[0]) * 100).toFixed(2) : null, closed: !!x.closed }; } catch (e) { /* skip this round */ }
    }));
    for (const c of idx.al) {
      const a = lists[c], keep = [];
      for (const x of a) {
        if (x.kind === 'market') {
          const m = mk[x.id];
          if (m && m.closed) { fired++; await tgSend(env, c, `Market closed: "${x.q}". Alert removed.`); continue; }
          if (m && m.yes != null && hitDir(x.dir, m.yes, x.level)) { fired++; await tgSend(env, c, `"${x.q}": Yes is ${m.yes}¢ (${x.dir} your ${x.level}¢).`); continue; }
          keep.push(x);
        } else {
          const S = prices[x.sym];
          if (S != null && hitDir(x.dir, S, x.level)) { fired++; await tgSend(env, c, `${x.sym} is $${S} (${x.dir} your $${x.level}).`); } else keep.push(x);
        }
      }
      if (keep.length !== a.length) await saveAlerts(env, c, keep);
    }
  }
  if (idx.wl.length) newMarkets = await checkNewMarkets(env, idx.wl);
  return { checked: idx.al.length, fired, newMarkets };
}

/* ---------- router ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      if (path === '/' || path === '/api/health') return json({ ok: true, service: 'veilor-worker', site: SITE, time: new Date().toISOString(),
        endpoints: ['/api/prices', '/api/markets', '/api/market/:id', '/api/book', '/api/fair', '/cal/all.ics', 'POST /mcp', 'POST /tg/webhook'] });
      if (path === '/api/prices') return json({ prices: await getPrices(), source: 'CoinGecko, falling back to Binance and Coinbase', ts: Date.now() });
      if (path === '/api/markets') return json({ markets: await listMarkets({ category: url.searchParams.get('category'), q: url.searchParams.get('q'), limit: num(url.searchParams.get('limit'), 50) }) });
      if (path.startsWith('/api/market/')) return json(await getMarket(decodeURIComponent(path.slice(12))));
      if (path === '/api/book') {
        const t = url.searchParams.get('token_id');
        if (!t) return json({ error: 'token_id is required' }, 400);
        const b = await getBook(t);
        const out = { bestBid: b.bids[0] || null, bestAsk: b.asks[0] || null, bids: b.bids.slice(0, 20), asks: b.asks.slice(0, 20) };
        const side = url.searchParams.get('side'), shares = num(url.searchParams.get('shares'));
        if (side && shares > 0) out.quote = quote(b, side === 'sell' ? 'sell' : 'buy', shares);
        return json(out);
      }
      if (path === '/api/fair') {
        const asset = (url.searchParams.get('asset') || '').toUpperCase(), K = num(url.searchParams.get('strike')), end = Date.parse(url.searchParams.get('end') || '');
        if (!ASSETS[asset] || !(K > 0) || !isFinite(end)) return json({ error: 'asset, strike and end (ISO date) are required' }, 400);
        const prices = await getPrices();
        return json({ asset, spot: prices[asset] ?? null, strike: K, fairLinePercent: fairLine(asset, K, end, url.searchParams.get('kind') || 'above', prices[asset]), note: 'Simple lognormal estimate. Can be wrong.' });
      }
      const cal = /^\/cal\/([A-Za-z]+)\.ics$/.exec(path);
      if (cal) {
        const ms = await listMarkets({ category: cal[1], limit: 100 });
        return new Response(buildICS(ms, 'Veilor · ' + cal[1]), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'public, max-age=300', ...CORS } });
      }
      if (path === '/mcp') {
        if (request.method !== 'POST') return json({ error: 'POST JSON-RPC to this endpoint' }, 405, { allow: 'POST' });
        return handleMCP(request);
      }
      if (path === '/tg/webhook' && request.method === 'POST') return handleTelegram(request, env);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, { 'cache-control': 'no-store' });
    }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(checkAlerts(env)); },
};

export { fairLine, parseFX, quote, buildICS, mapMarket, checkAlerts, pAbove };
