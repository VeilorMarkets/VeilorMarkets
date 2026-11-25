# Veilor

Console for prediction (outcome) markets, built on Robinhood Chain. X: [@VeilorAgent](https://x.com/VeilorAgent)

**See the line. Trade the difference.**

## What works today

- Live markets, prices, volume, rules and order books from Polymarket's public APIs
- Quote calculator that walks the live order book (average fill, price impact, cost)
- Model fair lines for BTC, ETH, SOL and gold price questions (lognormal model on Binance spot prices; an estimate, can be wrong)
- Wallet connect (read-only: address and balance) with a switch to Robinhood Chain (chain ID 4663)
- Portfolio lookup for any address: ETH balance, tokens and transactions (Robinhood Chain RPC + Blockscout) and open Polymarket positions
- Price and new-market alerts (stored in the browser, checked while the page is open)
- Live status page, light and dark themes, English and Chinese

## What does not exist yet

- Order execution: Veilor does not place or sign orders. The ticket links to the market on Polymarket.
- Hosted MCP server, datafeed and calendar feeds (they need a backend)
- Alerts while the page is closed (they need a backend)

## Run it

It is one static file. Open `index.html` in a normal browser with internet access. Hosting: GitHub Pages (Settings, Pages, Deploy from a branch, `main` / root).

## Data sources

Polymarket Gamma and CLOB APIs, Binance spot prices, Robinhood Chain RPC and Blockscout. No affiliation with any of them. Nothing here is investment advice.

## Fonts

IBM Plex Mono (SIL Open Font License 1.1) is embedded in `index.html`.
