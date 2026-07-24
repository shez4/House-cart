# 🛒 House-cart

A shared grocery list for roommates. Keep one **house list** for shared
household stuff (milk, toilet paper, bin bags) and give **each roommate a
personal list** for their own things. Whoever's out shopping opens the app and
sees everything that needs buying — the house list *plus* everyone's personal
requests — so they can grab other people's stuff too.

It's a web app, so it works on any phone or laptop through the browser. Lists
live on a small server and sync across everyone's devices.

## Features

- **House list** – shared items anyone can add.
- **Personal lists** – each roommate's own items, all visible to whoever's shopping.
- **Shopping view** – one combined list of everything still to buy, grouped by house / person.
- **"I'll get it"** – claim an item so two people don't buy the same thing.
- **Mark as bought** – tap to check items off; see who bought what.
- **Quantity & notes** – e.g. "2L milk, semi-skimmed".
- **Bought tab** – review recent purchases and clear them out.
- **No passwords** – everyone just picks their name to join the house.

Lists refresh automatically every few seconds, so changes from other roommates
show up on their own.

### 🧾 Receipts & splitting

After a shop, snap a photo of the receipt on the **Split** tab. If a Claude API
key is configured, the app reads the receipt and pulls out each line item and
price automatically; otherwise you add the items by hand. Then assign each item
to a roommate — or mark it **Shared** to split it evenly — and the app shows
**who owes the person who paid, and how much**. The receipt photo is kept so
you can check it later.

Auto-reading is powered by Claude's vision model via the official Anthropic
SDK. Set `ANTHROPIC_API_KEY` to turn it on:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # enables auto-scan of receipts
npm start
```

Without a key, everything still works — you just type the line items in
yourself. Optional overrides: `HOUSECART_PARSE_MODEL` (defaults to
`claude-opus-4-8`) and `HOUSECART_CURRENCY` (the currency symbol shown when a
receipt doesn't specify one, defaults to `£`).

## Tech

- **Backend:** Node.js + Express, with a SQLite database via the built-in
  `node:sqlite` module (no native build step, one dependency).
- **Frontend:** a single-page app in plain HTML / CSS / JS (no build tooling),
  mobile-first with light/dark support.

## Run it

Requires **Node.js 22.5+**.

```bash
npm install
npm start
```

Then open **http://localhost:3000** in a browser. To let roommates on other
devices reach it, run it on a machine/host they can access and share the URL
(set `PORT` to change the port).

The database is stored at `data/house-cart.db` (created automatically, ignored
by git). Set `HOUSECART_DATA_DIR` to store it elsewhere — useful for
deployment with a persistent volume.

## API

| Method | Path                      | Purpose                                    |
| ------ | ------------------------- | ------------------------------------------ |
| GET    | `/api/state`              | Roommates + items + config in one call     |
| GET    | `/api/roommates`          | List roommates                             |
| POST   | `/api/roommates`          | Add / join by name (idempotent)            |
| DELETE | `/api/roommates/:id`      | Remove a roommate                          |
| GET    | `/api/items`              | List all items                             |
| POST   | `/api/items`              | Add an item (house or personal)            |
| PATCH  | `/api/items/:id`          | Edit, claim/unclaim, mark bought           |
| DELETE | `/api/items/:id`          | Delete an item                             |
| GET    | `/api/receipts`           | List receipts (with their line items)      |
| POST   | `/api/receipts`           | Upload a receipt photo; auto-parse if on   |
| GET    | `/api/receipts/:id`       | One receipt with its items                 |
| GET    | `/api/receipts/:id/image` | The stored receipt photo                   |
| PATCH  | `/api/receipts/:id`       | Edit store / buyer / total / date          |
| DELETE | `/api/receipts/:id`       | Delete a receipt                           |
| POST   | `/api/receipts/:id/items` | Add a line item                            |
| PATCH  | `/api/receipt-items/:id`  | Edit / assign / mark shared a line item    |
| DELETE | `/api/receipt-items/:id`  | Delete a line item                         |

## Ideas for later

Categories/aisles, running "who owes whom" balances across many receipts,
recurring staples, and multiple houses via a shared join code.
