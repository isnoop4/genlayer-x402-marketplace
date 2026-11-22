# Gen402 — x402 Data Marketplace on GenLayer

**One Intelligent Contract, three pricing models, zero middlemen.**

Gen402 is a paid-data marketplace on GenLayer studionet (chain 61999).
Sellers list a data product (a public JSON/API URL + a price). Buyers pay
the contract in GEN. A gateway speaks x402 (HTTP 402 Payment Required):
no payment → `402` with a machine-readable price; pay on-chain, retry with
`X-Payment: <txHash>` → `200` with the data.

What makes it a GenLayer project — not just a paywall — is
`verify_delivery()`: the contract itself fetches the listing's `data_url`
and the validators' LLMs judge whether the fetched content matches the
listing description. The verdict (`MATCH` / `MISMATCH` / `UNREACHABLE`) is
stored on-chain after consensus on the verdict field. A `MISMATCH` /
`UNREACHABLE` verdict lets a paying buyer claim a refund — no separate
dispute court, no human moderator, no off-chain facilitator holding funds.

## Live demo (GitHub Pages)

- **Site:** https://isnoop4.github.io/genlayer-x402-marketplace/
- `docs/index.html` is a standalone static version of the frontend for Pages: real listings, prices and the on-chain AI verdict from the live deployment, plus the exact HTTP 402 challenge simulated in the browser. Serving the paid data itself still needs the gateway running locally (see below), because Pages cannot run the payment-verification backend.

## Live deployment (studionet, chain 61999)

- **Contract:** `0x3B0850628992B0F322D1Af7196a9337AdF7655B4`
- **Explorer:** https://explorer-studio.genlayer.com/address/0x3B0850628992B0F322D1Af7196a9337AdF7655B4
- **Deploy tx:** `0xe18938185a0a0473a79346f2cd3f9328732d92414ce4f1ed8f0c9d891e3c5f4d`
  (deployed with `deploy/deploy.mjs` via genlayer-js; consensus ACCEPTED)
- **Deployer:** `0xfD7d408f5Cc0A4d507bDc41c48B4A00A8C9Fc399`
- **Seed listings** (`deploy/seed.sh`, `genlayer write create_listing`):
  - #1 BTC Price Snapshot — tx `0x90f99a436d6a0673971a1cc8b744cbdd4359653db8ed3000037ba639aa47e37f`
  - #2 Jakarta Weather Now — tx `0x7f14dad098ea07056a3218ce39d8f6a5f4b4c2bb8f1ceddb775146fd143cc490`
  - #3 Top Crypto Market Brief — tx `0x5643b101b3d1ac9c551f99fd26f7ee212ca3e42e07ddbfd5c9918f82db7eac68`
- **Buy + AI verify:** see `deployment.json` (written by `deploy/interact.mjs`).
  - `buy_access(1)`, 1 GEN: tx `0xe9dcb85e4e6194b0683ea9312253d33678561c4b930c7c4ae9e3f2b236a78f14` (FINALIZED)
  - `verify_delivery(1)`: tx `0x6796a5c338f810d0b5089215b7bb59faa357aa8ebe308e8d2512028ff83636e3` (FINALIZED)
  - On-chain read-back: `has_access = true`, verdict **MATCH, 99%**
    ("The source contains valid JSON with a Bitcoin price in USD, matching
    the listing's promised BTC/USD price data."), seller balance 2 GEN.
- **Gateway:** run `node gateway/server.js` with `CONTRACT_ADDRESS` set
  (see below) — it reads listings and access from this contract.
  Live-tested 2026-11-19 against this contract:
  - real `buy_access(1)` tx → **200** `{"bitcoin":{"usd":62594}}`
  - real `buy_credits(2, 10)` tx → **200**, live Open-Meteo Jakarta JSON;
    `buy_credits(2, 10)`, 1 GEN: tx
    `0x2301b89ca9b2456f5e979e81c43029b375f117381f6223721e171372ba0342b5`
    (FINALIZED); the gateway's `use_call` then deducted one credit
    on-chain (`calls_left` 10 → 9)
  - deploy tx as payment → **402**; seed tx #2 as payment for listing #1
    → **402**; `buy_access` tx as payment for listing #2 → **402**
  - Caveat: the gateway's very first request after startup takes ~2–3
    min (genlayer-js cold start); later requests answer in seconds.

## The 3 listings

| # | Title | Model | Price | Source (public, re-fetchable by validators) |
|---|-------|-------|-------|----------------------------------------------|
| 1 | BTC Price Snapshot | 0 paywall | 1 GEN once, permanent | CoinGecko simple price API |
| 2 | Jakarta Weather Now | 1 metered | 0.1 GEN per credit | Open-Meteo forecast API |
| 3 | Top Crypto Market Brief | 2 subscription | 2 GEN per 30-call bundle | CoinGecko markets API (BTC+ETH) |

Prices are `u256` wei (1 GEN = 10¹⁸ wei). All three sources are public
APIs with no API key, so any validator can re-fetch them.

## Architecture

```
buyer ──GET /data/1──────────► gateway (Node, no framework)
                                  │ 402 { accepts: [{ scheme: "exact",
                                  │   network: "eip155:61999", asset: "GEN",
                                  │   amount, payTo: <contract> }] }
buyer ──buy_access(1) [1 GEN]──► Gen402Marketplace (GenLayer, Python)
                                  │ on-chain access record
buyer ──GET /data/1────────────► gateway ──has_access(buyer, 1)?──► contract
   X-Payment: <txHash>              │ yes → fetch data_url → 200 + data
   X-Buyer: <address>               │     → use_call(1, buyer) if metered/sub
                                    │
anyone ──verify_delivery(1)─────► contract ──gl.nondet.web.get(data_url)
                                                + gl.nondet.exec_prompt(judge)
                                                → run_nondet_unsafe leader/
                                                  validator (verdict must
                                                  match; confidence ±20)
                                                → verdict stored on-chain
```

Money flow: payments sit in the contract, credited to the seller's
internal balance. Sellers call `withdraw()`; buyers call
`request_refund()` only after a `MISMATCH`/`UNREACHABLE` verdict and only
before the seller has withdrawn. Payouts use
`gl.get_contract_at(addr).emit_transfer(value=...)` — the value-transfer
primitive in the pinned runner's std lib.

## Contract API (`contracts/marketplace.py`, 367 lines)

| Method | Type | What it does |
|---|---|---|
| `create_listing(title, description, data_url, model, price_wei)` | write | List a product. model 0 paywall, 1 metered, 2 subscription. |
| `get_listing(id)` / `list_listings()` / `listing_count()` | view | Catalogue reads. |
| `buy_access(id)` | write payable | Paywall + subscription. Value must equal price exactly. Subscription = 30 calls. |
| `buy_credits(id, credits)` | write payable | Metered. Value must equal credits × price-per-credit. |
| `has_access(buyer, id)` / `get_access(buyer, id)` | view | Access check used by the gateway. |
| `use_call(id, buyer)` | write | Buyer or gateway records one consumed call (metered/subscription). |
| `verify_delivery(id)` | write | AI verdict on the live source. Returns `MATCH`/`MISMATCH`/`UNREACHABLE`. |
| `get_verdict(id)` | view | Last stored verdict. |
| `request_refund(id)` | write | Refund after a bad verdict, before seller withdrawal. |
| `withdraw()` / `seller_balance(seller)` | write / view | Seller payout. |
| `set_gateway(addr)` | write | Owner-only; who may call `use_call` on a buyer's behalf. |

Design notes (learned the hard way — see `tests/`):

- Storage is `TreeMap`/`DynArray` + JSON strings, never `dict`/`list`.
  Addresses are keyed by canonical lowercase hex of the 20 raw bytes
  (`_addr_key`), because the same address can arrive as an SDK `Address`,
  raw bytes, or a `0x...` string and all three must hit the same key.
- `gl.nondet.*` calls live only inside the `evaluate()` leader function
  passed to `gl.vm.run_nondet_unsafe`; storage writes happen after
  consensus returns. The validator re-runs the same task and must agree
  on the verdict (confidence may drift ±20).
- `_Recipient` (seen in newer docs) does **not** exist in the pinned
  runner's std lib — payouts use `gl.get_contract_at(...).emit_transfer()`.

## Run it

### 1. Tests + lint

```bash
python3 -m venv .venv && .venv/bin/pip install genlayer-test genvm-linter
.venv/bin/genvm-lint check contracts/marketplace.py   # ✓ 3 checks, validation passed
.venv/bin/python -m pytest tests/ -v                  # 9 passed
```

Notes: `genlayer-test` 0.29.2's direct mode downloads the GenVM runner
from GitHub on first use; if that download 404s (it did for v0.3.0-rc7),
copy the linter's cached tarball into `~/.cache/gltest-direct/` —
`cp ~/.cache/genvm-linter/genvm-universal-v0.2.16.tar.xz ~/.cache/gltest-direct/`.
Also: deploy **and** exercise the contract inside a single
`vm.activate()` block per test — `activate()` evicts the SDK modules on
exit, which silently breaks `vm.value` refresh and lazy `gl.nondet`
imports in a second block.

### 2. Gateway (demo mode, no contract needed)

```bash
npm install
node gateway/server.js   # http://localhost:8787
curl -s http://localhost:8787/data/1            # 402 + x402 price
curl -s -H "X-Payment: demo" -H "X-Buyer: 0x0000000000000000000000000000000000000001" http://localhost:8787/data/1
# 200 {"bitcoin":{"usd":...}}  — demo shortcut, labelled as such
```

With a contract: `CONTRACT_ADDRESS=0x... node gateway/server.js` — then
`X-Payment` must be a real tx hash and the gateway checks `has_access`
on-chain. With `GATEWAY_PRIVATE_KEY` (throwaway studionet key) it also
records metered calls via `use_call()` and serves `POST /verify/:id`.

Payment verification is exact, not just "any tx from this buyer": the
gateway loads the presented tx with genlayer-js and requires
`from == buyer`, `to == the contract`, and the decoded call to be
`buy_access`/`buy_credits` for *this* listing with the right value
(decoded from `tx.data.calldata.readable`, a Python-style repr — parsed
tolerantly, since it is not strict JSON). A deploy tx, a `create_listing`
tx, or a purchase of another listing all return 402.

### 3. Frontend demo

The gateway serves `frontend/index.html` at `/` — a single static page
(no build step): lists products, shows the 402 body, lets you retry with
a tx hash + buyer address, and shows the last AI verdict.

### 4. Deploy to studionet (CLI path — what was actually done)

Studionet transactions are free: a fresh account starts at 0 GEN and
that is fine. No faucet needed for studionet (the faucet at
testnet-faucet.genlayer.foundation is for Bradbury/Asimov).

```bash
npm install -g genlayer
genlayer network set studionet
genlayer account create --name gen402-deploy --password "<throwaway>"
# headless containers have no OS keychain, so pipe the password to every
# signing command:
cat ~/.genlayer/gen402-deploy.password | genlayer deploy --contract contracts/marketplace.py
CONTRACT=0x... bash deploy/seed.sh        # create the 3 listings
```

Payable calls have no `--value` flag on `genlayer write`, so buying and
verifying go through genlayer-js:

```bash
CONTRACT=0x... PRIVATE_KEY=0x<throwaway> node deploy/interact.mjs
# buys access to #1, runs verify_delivery(1), writes deployment.json
```

Or deploy entirely from Studio web (no private key needed):
open studio.genlayer.com → New Contract → paste
`contracts/marketplace.py` → Deploy → copy the address → run
`deploy/seed.sh` with `CONTRACT` set (CLI path) or call
`create_listing` from Studio's Run panel.

## x402 note

Standard x402 (Coinbase spec) pays USDC via EIP-3009 through a
facilitator. Gen402 adapts it to GenLayer: the asset is GEN on
`eip155:61999`, the payee is the marketplace contract itself, and the
payment proof is the on-chain transaction hash — the gateway verifies
access by reading the contract, so there is no facilitator to trust and
no API key anywhere. The 402 body keeps the standard shape
(`x402Version`, `accepts[]` with `scheme: "exact"`) so x402 clients can
parse it.

## Submission notes (GenLayer Portal)

- Category: Builder → Projects (Intelligent Contract + dApp).
- Evidence to attach: this repo, `deployment.json` (contract address +
  tx hashes), gateway demo (402 → 200), and the 9 passing direct-mode
  tests + lint output.
- Differentiator vs the `genlayer-x402` PyPI library: that is 4 separate
  single-model contracts; Gen402 is **one unified marketplace** with all
  three models plus the on-chain AI delivery verdict + verdict-gated
  refund, which only GenLayer can do.
- Not a dispute court: refunds are a narrow, automatic consequence of
  a bad AI verdict — no judges, no appeals, no generic arbitration.

## Repo layout

```
contracts/marketplace.py   Gen402Marketplace (the whole product)
gateway/server.js          x402 gateway (plain Node http + genlayer-js)
frontend/index.html        single static demo page (served by the gateway)
deploy/deploy.mjs          full deploy + seed + buy + verify via genlayer-js
deploy/interact.mjs        buy + verify against an existing deployment
deploy/seed.sh             create the 3 listings via the CLI
data/listings.json         the 3 seeded listings (source of truth)
data/sample-report.json    human-readable sample of the listing-#3 payload shape
tests/test_marketplace.py  9 direct-mode tests (gltest)
deployment.json            live deployment record (addresses + tx hashes)
```
