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
- **Sign in** – simple no-password name-picker by default, or **Sign in with Google** with private houses joined by an invite code (see below).

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
`claude-haiku-4-5`, a fast and inexpensive vision model — set it to
`claude-opus-4-8` for maximum accuracy) and `HOUSECART_CURRENCY` (the currency
symbol shown when a receipt doesn't specify one, defaults to `$` for New
Zealand dollars — set to e.g. `NZ$`, `£`, or `€` to change it).

## Tech

- **Backend:** Node.js + Express with **Postgres** (`pg`), designed to run
  either as a long-running server or as a serverless function.
- **Storage:** receipt photos go to **Vercel Blob** (optional).
- **Frontend:** a single-page app in plain HTML / CSS / JS (no build tooling),
  mobile-first with light/dark support.

## Run it locally

Requires **Node.js 20+** and a Postgres database.

```bash
npm install
cp .env.example .env          # set POSTGRES_URL at minimum
npm start
```

Then open **http://localhost:3000**. Tables are created automatically on first
request.

No Postgres handy? `docker compose up -d --build` starts the app **and** a
Postgres container together.

## Sign in with Google (optional)

By default the app uses a friendly no-password **name-picker** — fine on a
trusted home network. For a secure, organized setup, turn on **Sign in with
Google**: each roommate signs in with their real Gmail, and houses are private
and joined by an **invite code**.

How it works once enabled:
- The first person signs in and **creates a house** (gets a 6-character invite code).
- They share that code; other roommates **sign in and enter the code** to join.
- Each house's lists and receipts are private to its members.

To enable it:

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth 2.0 Client ID** of type **Web application**.
2. Under **Authorized JavaScript origins**, add the HTTPS URL where your app is
   served (e.g. `https://house.example.com`). Google requires HTTPS — this is
   why the app needs to be deployed (see below) before sign-in works; it won't
   run on a bare IP or plain `http`.
3. Set the resulting Client ID as the `GOOGLE_CLIENT_ID` environment variable
   (in your `.env`) and restart.

Leave `GOOGLE_CLIENT_ID` unset to keep the simple name-picker.

## Deploy — use it from anywhere

### Vercel (recommended)

1. Push this repo to GitHub and **import it** at
   [vercel.com/new](https://vercel.com/new). The included `vercel.json` tells
   Vercel how to build and route it.
2. In the project's **Storage** tab, **create a Postgres database** and connect
   it to the project. Vercel injects `POSTGRES_URL` automatically.
3. *(Optional)* In the same tab, **create a Blob store** to hold receipt
   photos. Vercel injects `BLOB_READ_WRITE_TOKEN` automatically. Skip it and
   receipts still work, just without photos.
4. *(Optional)* Add `GOOGLE_CLIENT_ID` and/or `ANTHROPIC_API_KEY` under
   **Settings → Environment Variables**.
5. **Redeploy** after adding storage so the new variables are picked up.

Database tables are created automatically on the first request — there's no
migration step to run.

> **Why Postgres?** Serverless functions have a read-only, ephemeral
> filesystem, so a file-based database can't persist there. Postgres and Blob
> storage live outside the function, which is what makes the app work on
> Vercel (and any other serverless host).

### Self-host with Docker Compose

On your own server/machine:

```bash
git clone https://github.com/shez4/house-cart.git
cd house-cart
cp .env.example .env        # then edit .env — ANTHROPIC_API_KEY is optional
docker compose up -d --build
```

That starts the app on port `3000` **plus its own Postgres container**, with the
database kept in a named Docker volume (`housecart_db`) so `docker compose down`
and rebuilds don't lose anything. Update later with
`git pull && docker compose up -d --build`.

To point at an existing Postgres instead, set `POSTGRES_URL` in `.env` and
remove the `db` service from `docker-compose.yml`.

### Make it reachable from anywhere

`docker compose up` serves on `http://<server-ip>:3000` — fine on your home
network. To reach it from anywhere **with HTTPS** (and without opening ports),
put a tunnel in front of port 3000:

- **Cloudflare Tunnel** — `cloudflared tunnel --url http://localhost:3000` gives
  a public HTTPS URL; or bind it to a domain you own.
- **Tailscale Funnel** — exposes the port to the internet over HTTPS if your
  server is on Tailscale.

If your server already has a public IP and a domain, a reverse proxy such as
**Caddy** gives automatic HTTPS in a two-line config pointing at `:3000`.

### Or a managed host (Fly.io)

A `fly.toml` is included. Attach a Postgres database (`fly postgres create`,
then `fly postgres attach` — this sets `DATABASE_URL`) and deploy:

```bash
fly launch --no-deploy
fly postgres create && fly postgres attach <db-name>
fly secrets set GOOGLE_CLIENT_ID=...   # optional
fly deploy
```

Fly prints a public `https://<app>.fly.dev` URL. Always set the API key as a
**secret** / host env var — never commit it.

## API

| Method | Path                      | Purpose                                    |
| ------ | ------------------------- | ------------------------------------------ |
| GET    | `/api/session`            | Auth mode + who's signed in + house        |
| POST   | `/auth/google`            | Verify a Google token, start a session     |
| POST   | `/auth/logout`            | End the session                            |
| POST   | `/api/houses`             | Create a house (returns invite code)       |
| POST   | `/api/houses/join`        | Join a house by invite code                |
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
