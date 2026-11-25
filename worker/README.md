# Veilor Worker

The small backend behind Veilor, as one Cloudflare Worker.

| Feature | Address | Notes |
|---|---|---|
| Health | `GET /api/health` | Lists the endpoints |
| Spot prices | `GET /api/prices` | BTC, ETH, SOL, XRP, DOGE, BNB, gold (CoinGecko, falling back to Binance and Coinbase) |
| Markets | `GET /api/markets?category=Crypto&q=bitcoin&limit=25` | Live Polymarket markets, with a model fair line for crypto and gold price questions |
| One market | `GET /api/market/:id` | Includes the rules text |
| Order book and quote | `GET /api/book?token_id=...&side=buy&shares=100` | Walks the visible book |
| Fair line | `GET /api/fair?asset=BTC&strike=100000&end=2026-12-31&kind=above` | `kind`: above, below, touch, touchdn |
| Calendar feed | `GET /cal/all.ics`, `/cal/crypto.ics`, `/cal/sports.ics` ... | Settlement dates; subscribe to the URL in any calendar app |
| MCP server | `POST /mcp` | Tools: `list_markets`, `get_market`, `get_order_book`, `get_prices`, `fair_line` |
| Telegram alerts | `POST /tg/webhook` plus a cron every minute | Spot, market-price and new-market alerts that run while the website is closed |

It is **read-only**. It never signs, routes or places orders and holds no funds. Fair lines are a simple lognormal estimate with a fixed volatility and can be wrong. Nothing here is investment advice.

---

## Deploy from a phone (no tools to install)

You need a free Cloudflare account and, for alerts, a Telegram account.

### 1. Create the Worker
1. Sign up or log in at <https://dash.cloudflare.com>.
2. Open **Workers & Pages** → **Create** → **Create Worker**. Name it `veilor-worker`. Press **Deploy** (the Hello World version).
3. Press **Edit code**. Select everything in the editor and delete it.
4. In GitHub, open `worker/src/index.js` in your repository, tap **Raw**, select all, copy, and paste it into the Cloudflare editor.
5. Press **Deploy**.
6. Open `https://veilor-worker.<your-subdomain>.workers.dev/api/health`. You should see `"ok": true`. Then try `/api/prices` and `/api/markets`.

(Alternative for later: **Workers & Pages → Create → Import a repository**, choose this repository, set the **Root directory** to `worker`, and the deploy command to `npx wrangler deploy`. Every push then redeploys the Worker.)

### 2. Turn on the minute-by-minute check (for alerts)
1. Open the Worker → **Settings** → **Triggers** → **Cron Triggers** → **Add**.
2. Enter `* * * * *` (every minute) and save.

### 3. Create storage for alerts
1. In the dashboard open **Storage & databases** → **KV** → **Create a namespace**. Name it `veilor-alerts`.
2. Open your Worker → **Settings** → **Bindings** → **Add** → **KV namespace**.
3. Variable name: `ALERTS`. Namespace: `veilor-alerts`. Save and deploy.

### 4. Create the Telegram bot
1. In Telegram, open **@BotFather** and send `/newbot`. Choose a name and a username ending in `bot`.
2. Copy the token it gives you. Treat it like a password.
3. In your Worker → **Settings** → **Variables and Secrets** → **Add**, create two **Secrets**:
   - `TG_TOKEN`: the bot token.
   - `TG_SECRET`: any long random string (for example 30 random letters and digits). Remember it for the next step.
4. Deploy again so the secrets take effect.

### 5. Connect Telegram to the Worker
Open this address once in your browser (replace the three parts):

```
https://api.telegram.org/bot<TG_TOKEN>/setWebhook?url=https://veilor-worker.<your-subdomain>.workers.dev/tg/webhook&secret_token=<TG_SECRET>
```

You should see `"ok": true`. Now open your bot in Telegram and send `/start`.

### 6. Use it
In Telegram:

```
/alert BTC above 100000        spot price
/alert ETH below 2500
/markets bitcoin               find a market id
/alert market 12345 above 60   market Yes price in cents
/watch Crypto                  new markets (All, Sports, Crypto, Commodities, IPO, Equities, Macro, Awards, Politics, Other)
/unwatch Crypto
/alerts
/clear                         deletes all alerts and watches
```

Each price alert fires once and is then removed. The Worker checks every minute. Limits: 10 alerts and 5 watches per chat; market alerts are checked for at most 20 distinct markets per run. The first run after you enable watches only remembers current events, so you are told about markets that appear afterwards.

---

## Use the MCP server

Add the Worker's `/mcp` address to any MCP client that supports remote (HTTP) servers:

```
https://veilor-worker.<your-subdomain>.workers.dev/mcp
```

It speaks JSON-RPC over HTTP (`initialize`, `tools/list`, `tools/call`). It is public and read-only, so there is nothing to log in to.

Quick check from a terminal:

```
curl -s https://veilor-worker.<your-subdomain>.workers.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Subscribe to the calendar

In your calendar app choose "Subscribe to calendar" (or "Add from URL") and paste:

```
https://veilor-worker.<your-subdomain>.workers.dev/cal/crypto.ics
```

Replace `crypto` with `all`, `sports`, `politics`, `macro`, `equities`, `commodities`, `ipo`, `awards` or `other`.

---

## Run the tests

```
cd worker
node test/test.mjs
```

The tests use a fake network and a fake KV store (no internet needed). They cover the fair-line model, the quote walker, every endpoint, the MCP methods and the Telegram alert flow.

## Limits and honest notes

- The public endpoints have no login and no rate limit of their own. Cloudflare's free plan caps daily requests. Responses are cached for a few seconds to protect the upstream APIs.
- CoinGecko's free API is rate limited. If it fails, the Worker falls back to Binance (which blocks some data-centre regions) and Coinbase.
- Alerts are per Telegram chat, at most 10 alerts and 5 watches per chat.
- The KV free plan allows 1,000 writes and 1,000 list calls per day. The Worker keeps an index key so the cron makes no list calls, and writes only when you add, clear or trigger an alert or new markets appear.
- Never commit your bot token or secret. They belong in **Variables and Secrets** only.
- Not affiliated with Polymarket, CoinGecko, Binance, Coinbase, Telegram or Cloudflare.
