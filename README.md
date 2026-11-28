# Gen402 — x402 Data Marketplace on GenLayer

**One Intelligent Contract, three pricing models, zero middlemen.**

Gen402 is a paid-data marketplace on GenLayer studionet (chain 61999).
Sellers list a data product (a public JSON/API URL + a price). Buyers pay
the contract in GEN. A gateway speaks x402 (HTTP 402 Payment Required):
no proof → `402` with a machine-readable price; pay on-chain, then prove
you control the buyer account by signing a single-use challenge → `200`
with the data. For metered and subscription listings the data is released
only after one credit has been consumed on-chain and that transaction is
finalized.

What makes it a GenLayer project — not just a paywall — is
`verify_delivery()`: the contract itself fetches the listing's `data_url`
and the validators' LLMs judge whether the fetched content matches the
listing description. The verdict (`MATCH` / `MISMATCH` / `UNREACHABLE`) is
stored on-chain after consensus on the verdict field. A `MISMATCH` /
`UNREACHABLE` verdict lets a paying buyer claim a refund — no separate
dispute court, no human moderator, no off-chain facilitator holding funds.

## Live demo (GitHub Pages)

- **Site:** https://isnoop4.github.io/genlayer-x402-marketplace/
- `docs/index.html` is a standalone static page for Pages. On load it reads the listings and AI verdicts from the live contract (read-only, throwaway in-memory account, no wallet) and falls back to recorded values if that read fails; the status line says which. It also shows the exact HTTP 402 body, built in the browser. Serving paid data needs the gateway running (see below), because Pages cannot run a backend.

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
- **Gateway (first version, 2026-11-19, superseded):** the first gateway
  accepted a purchase transaction hash plus the buyer address as proof and
  recorded metered calls after serving. Both are public values, so that
  flow is gone; see "Paid-request rules" below. Its recorded results stay
  in `deployment.json` under `gatewayVerification` for history only.
  `buy_credits(2, 10)`, 1 GEN: tx
  `0x2301b89ca9b2456f5e979e81c43029b375f117381f6223721e171372ba0342b5`
  (FINALIZED).

## The 3 listings

| # | Title | Model | Price | Source (public, re-fetchable by validators) |
|---|-------|-------|-------|----------------------------------------------|
| 1 | BTC Price Snapshot | 0 paywall | 1 GEN once, permanent | CoinGecko simple price API |
| 2 | Jakarta Weather Now | 1 metered | 0.1 GEN per credit | Open-Meteo forecast API |
| 3 | Top Crypto Market Brief | 2 subscription | 2 GEN per 30-call bundle | CoinGecko markets API (BTC+ETH) |

Prices are `u256` wei (1 GEN = 10¹⁸ wei). All three sources are public
APIs with no API key, so any validator can re-fetch them.

## Paid-request rules (gateway v2)

The contract is unchanged (same address). What changed is how the gateway
decides to release data (`gateway/core.js`, rules in order):

1. **Proof of control of the buyer account, with replay protection.**
   `GET /challenge/<id>?buyer=<address>` returns a message to sign. It
   names the listing, the buyer, this gateway, the contract, the chain, a
   random 32-byte nonce and an expiry (2 minutes). The buyer signs it with
   their wallet (EIP-191 `personal_sign`) and retries `GET /data/<id>` with
   `X-Buyer`, `X-Nonce`, `X-Signature`. The gateway recovers the signer and
   requires it to equal the buyer. Each challenge works once: it is marked
   used the moment a valid signature is seen, so a replay — even one sent
   at the same instant — is rejected. Unknown, expired, wrong-buyer and
   wrong-listing challenges are rejected. A wrong signature does not burn
   the challenge, so a third party cannot cancel the real buyer's request.
   **A transaction hash plus an address is no longer accepted**: both are
   public on the explorer. `X-Payment` is ignored for authorization.
2. **On-chain access.** `has_access(buyer, id)` must be true.
3. **Finalized consumption before release (metered, subscription).** The
   gateway fetches the upstream data and holds it, calls
   `use_call(id, buyer)` from the gateway account, and waits until that
   transaction is `FINALIZED` with execution result `FINISHED_WITH_RETURN`
   and an agreeing consensus result. Only then is the held data sent.
   - No `GATEWAY_PRIVATE_KEY`: the request is refused (`503`), no data.
   - The consumption simulation fails, the transaction reverts, ends with
     an error, or is not finalized before the deadline: no data (`502`, or
     `402` when the buyer simply has no calls left).
   - A dead upstream is detected before the consumption, so it does not
     cost a credit.
4. **One request at a time per (buyer, listing).** Requests for the same
   buyer and listing are queued inside the gateway. The second of two
   simultaneous requests starts only after the first has finished, and is
   judged on the credits the first one left. The contract's `use_call`
   also refuses when no calls are left, so even two gateway processes
   cannot release more data than there are credits: each release needs
   its own finalized consumption.

Paywall listings need rules 1 and 2 only (nothing to consume).

**Untrusted text.** Listing titles, descriptions, source URLs and verdict
reasons are written by sellers and by validators' LLMs. Both pages render
them through `docs/render.js`, which builds DOM nodes with `textContent`
only — no `innerHTML`, no HTML strings, no inline event handlers. Links
are created only for `http(s)` URLs; a verdict word that is not exactly
`MATCH` / `MISMATCH` / `UNREACHABLE` is shown as `UNKNOWN`; the confidence
is forced to an integer 0–100. The gateway page is served with a
Content-Security-Policy that forbids inline script, and API responses are
`application/json` with `nosniff`. The gateway also refuses to fetch a
`data_url` that is not a public `http(s)` address.

### Focused checks

```bash
npm test              # node --test tests/*.test.mjs — 38 checks, no network needed*
npm run test:browser  # headless Chromium: hostile listing text stays inert
npm run test:contract # the 9 contract tests (unchanged contract)
```

| Area | File | What is checked |
|---|---|---|
| Impersonation | `tests/gateway.test.mjs` | tx hash + address only → 402; challenge signed by another key → 401; attacker's own valid proof does not unlock the buyer's access; a challenge cannot be moved to another buyer or listing; a forgery does not burn the buyer's challenge |
| Replay | `tests/gateway.test.mjs` | same proof twice → second is 401; three simultaneous presentations of one proof → exactly one passes, one credit used; expired and never-issued nonces → 401 |
| Failed consumption | `tests/gateway.test.mjs` | missing gateway key → 503; consumption throws / finalizes with an error / never finalizes / is accepted but not finalized → 502; chain refuses the consumption → 402; in every case no data and the upstream body is dropped; dead upstream → no credit used |
| Concurrent consumption | `tests/gateway.test.mjs` | 2 requests, 1 credit → exactly 1 served; 6 requests, 3 credits → exactly 3 served, never more than one consumption in flight; a failed request does not block the next; different buyers are not serialized |
| Injected markup | `tests/render.test.mjs`, `tests/browser/markup.html` | `<script>`, `<img onerror>`, `<svg onload>`, `<iframe>`, `javascript:` links in title / description / price / source / verdict / reason stay text; no unexpected element, attribute, class or link; page sources contain no HTML-string sinks or inline handlers |
| HTTP surface | `tests/server.test.mjs` | the real server in demo mode: 402 body, tx-only refusal, forged and wrong-listing proofs, CSP without inline script |

\* The gateway tests use a small in-memory chain that behaves like the
contract's `has_access` / `use_call`, and real EIP-191 signatures from
throwaway keys. Run locally on 2026-11-27: 38 passed; the browser check
printed `PASS executed=0 forbiddenElements=0 inlineHandlers=0 badLinks=0
payloadsShownAsText=6/6 cards=6`; lint passed; 9 contract tests passed.

### First live run (2026-11-27): partial, gateway not registered

`deploy/live-check.mjs` runs the rules against the live contract with
throwaway accounts and real gateway processes. One **partial** run exists,
recorded in `live-check-partial.json`. In that run the gateway account was
not registered with `set_gateway`, so no credit could be consumed:

| Check | Result |
|---|---|
| No proof | 402, no data |
| The buyer's real purchase tx hash + the buyer's address, no signature | 402, no data |
| Challenge for the buyer signed by another key | 401, no data, credits unchanged (2 → 2) |
| Metered request to a gateway without a key | 503, no data, credits unchanged |
| Replay of an already used nonce and signature | 401, no data |
| Paywall listing #1, signed request by the buyer | 200 with data |
| Paywall listing #1, attacker signs their own challenge | 402, no data |
| Metered request through an unregistered gateway key | **failed check**: the gateway answered 500 instead of 502 (no data was released, credits unchanged). Cause: RPC error text with line breaks in a response header. Fixed and covered by a test; not re-run live. |

Purchases made by the throwaway buyer `0xD584286A22Bf42d3781F5B75FeE5aa5687Ae95Ee`
in that run (both FINALIZED / MAJORITY_AGREE / FINISHED_WITH_RETURN):
`buy_credits(2, 2)` tx `0xea85b521f12ce02eee8b841c093f91e974755728194179344f177ccd40ae5da4`,
`buy_access(1)` tx `0x9876c3cac457b36487ec5755ca915202915e66092d8aadded8c821aefbd9c48e`.

**Not yet shown live:** a metered request served after a finalized
`use_call`, two concurrent requests with one credit left, and a request
with zero credits. They need the owner to register a gateway account
(`set_gateway`) and a full run of `deploy/live-check.mjs`. The run above
stopped being repeatable when Studio's public RPC answered "Rate limit
exceeded: 30 requests per minute"; the gateway now caches the catalogue
and the script paces its checks.

### Second live run (2026-11-28): gateway registered, stopped early

After a fix to how the scripts pass `Address` arguments (they must be sent
as a calldata address, not as a hex string; an earlier `set_gateway` attempt,
tx `0x899e509b6685faca4425abe488ebec877a6b3d270b26b72b4d79aa179754cff1`,
finished with an error for that reason), `deploy/live-check.mjs` was run
again. Recorded in `live-check-2026-11-28.json`. All three transactions are
FINALIZED / MAJORITY_AGREE / FINISHED_WITH_RETURN:

- `set_gateway` by the owner: tx `0x5b42da8a06446720d9dcde5ac60e58dcedbb719c928b18791ed911200928d32b`
- `buy_credits(2, 2)` by the throwaway buyer `0x23f99BF8063B1019Bb1807926fCeAafA0A0bDafe`: tx `0x5a291694445c2eea5e2cdcb3fa488ea1664caa37e24c83b4aef960bc242d18ba`
- `buy_access(1)` by the same buyer: tx `0xa3735421cbfc1222fee5ca2036054da10f67edf6ca249d0f2894421f0f4d6ae7`

| Check | Result |
|---|---|
| No proof | 402, no data |
| The buyer's real purchase tx hash + the buyer's address, no signature | 402, no data |
| Challenge for the buyer signed by another key | 401, no data, credits unchanged (2 → 2) |
| Metered request to a gateway without a key | 503, no data, credits unchanged (2 → 2) |
| Metered request through a gateway key the contract does not recognise | 502, no data, credits unchanged (2 → 2). This is the check that failed with 500 in the first run. |
| Signed metered request #1, expected 200 after a finalized consumption | **not shown**: the listing's data source (Open-Meteo) answered HTTP 429, so the gateway refused with 502 before consuming a credit (credits 2 → 2, no data). The run was stopped here and not retried. |

**Still not shown live:** a metered request served after a finalized
`use_call`, replay of a used proof against the registered gateway, two
concurrent requests with one credit left, a request with zero credits, and
the signed paywall flow in this run (the paywall flow and replay were shown
in the first run above). These are covered by the local tests listed under
"Focused checks".

The contract's registered gateway is now the throwaway account
`0x1Fe81E8148Ba54e5b70E8C4DF2bAfAF9Cd0D7673`, whose key was discarded. The
owner must call `set_gateway` again before running a real gateway. The
throwaway buyer still holds 2 unused credits on listing #2.

### Known limits

- Challenges and the per-buyer queue live in the memory of one gateway
  process. A restart drops open challenges (clients ask for a new one).
  Several gateway processes each keep their own; credits are still safe
  because every release needs its own finalized `use_call`, but ordering
  between processes is not guaranteed.
- The gateway is trusted for consumption: the account registered with
  `set_gateway` can call `use_call` for any buyer. The contract has no
  getter for the registered gateway address.
- A buyer can also call `use_call` for themselves; that only spends their
  own credits.
- If the gateway process dies after a consumption is finalized but before
  the response is sent, the credit is spent and the data is not delivered.
- A metered request waits for finalization (about half a minute per
  transaction when measured on 2026-11-27, longer under load).
- Studio's public RPC is rate-limited (about 30 requests a minute). Under
  that limit a request fails closed (no data).
- The upstream URL guard blocks private and loopback addresses written as
  literals; it does not resolve DNS names first.
- The wallet button on the gateway page (`personal_sign` through a browser
  wallet) and the Pages live read have not been exercised in a real
  browser yet.
- `contracts/marketplace.py` is byte-identical to the deployed contract,
  so its docstring still describes the first gateway flow.
- `deploy/deploy.mjs`, `deploy/interact.mjs` and `deploy/buy_credits.mjs`
  predate Studionet's protocol fees and do not send a fee yet; use
  `deploy/live-check.mjs` as the pattern for fee-aware writes.

## Architecture

```
buyer ──GET /data/2────────────► gateway (Node, no framework)
                                   │ 402 { accepts: [{ scheme: "exact",
                                   │   network: "eip155:61999", asset: "GEN",
                                   │   amount, payTo: <contract> }] }
buyer ──buy_credits(2, n) [GEN]─► Gen402Marketplace (GenLayer, Python)
                                   │ on-chain access record
buyer ──GET /challenge/2?buyer=──► gateway → { nonce, message, expiresAt }
buyer   signs message (personal_sign)
buyer ──GET /data/2────────────► gateway
   X-Buyer, X-Nonce, X-Signature    │ 1. signer == buyer, nonce unused + unexpired
                                    │ 2. has_access(buyer, 2)?  ──────► contract
                                    │ 3. fetch data_url, hold it
                                    │ 4. use_call(2, buyer) ──────────► contract
                                    │    wait FINALIZED + successful result
                                    │ 5. 200 + data   (anything else: no data)
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

## Contract API (`contracts/marketplace.py`, 381 lines, unchanged)

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

### 2. Gateway

Dependencies: `genlayer-js` 2.x (Studionet charges protocol fees; 1.x can
no longer write there) and `viem` for signature recovery — `npm install`.

Demo mode (no contract; the signature is still required, nothing on-chain
is checked, labelled as demo):

```bash
node gateway/server.js                      # http://localhost:8787
curl -s http://localhost:8787/data/1        # 402 + x402 price
BUYER_PRIVATE_KEY=0x<any throwaway key> node gateway/client.mjs http://localhost:8787 1
# 200 {"bitcoin":{"usd":...}}
```

Against the contract:

```bash
CONTRACT_ADDRESS=0x3B0850628992B0F322D1Af7196a9337AdF7655B4 \
GATEWAY_PRIVATE_KEY=0x<throwaway key of the account registered with set_gateway> \
GATEWAY_ID=https://your-gateway.example \
  node gateway/server.js

BUYER_PRIVATE_KEY=0x<key of the account that bought access> \
  node gateway/client.mjs http://localhost:8787 2
```

- The contract owner registers the gateway account once with
  `set_gateway(<address>)`. The gateway account needs a little GEN for
  protocol fees.
- Without `GATEWAY_PRIVATE_KEY` the gateway still serves paywall listings
  and refuses metered and subscription requests.
- `gateway/client.mjs` asks for a challenge, signs it locally and sends the
  three proof headers. The buyer key never leaves the process.
- Keys are read from the environment only. Never commit one.

Routes: `GET /` (page), `GET /listings`, `GET /challenge/:id?buyer=0x…`,
`GET /data/:id`, `POST /verify/:id` (the gateway pays for a
`verify_delivery` call), `GET /health`.

### 3. Frontend

The gateway serves `frontend/index.html` at `/` (no build step) with
`frontend/app.js` and `docs/render.js`: it lists products, shows the 402
body, runs the signed flow through a browser wallet when one is present,
and shows that a tx hash alone is refused.

### 4. Deploy to studionet (CLI path — what was actually done)

This is the path used on 2026-11-19, when Studionet transactions were
free. Studionet now charges protocol fees (Consensus v0.6): every write
needs a fee and a funded account, and these older scripts do not send one
yet (see "Known limits").

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
facilitator, and the payment payload is itself a signed authorization.
Gen402 adapts it to GenLayer: the asset is GEN on `eip155:61999`, the
payee is the marketplace contract itself, and payment happens as an
ordinary contract call. Because that call is public, the proof presented
to the gateway is not the transaction hash but a fresh signature from the
paying account over a gateway challenge; the gateway then reads access
from the contract. There is no facilitator and no API key. The 402 body
keeps the standard shape (`x402Version`, `accepts[]` with
`scheme: "exact"`) so x402 clients can parse it.

## Repo layout

```
contracts/marketplace.py   Gen402Marketplace (unchanged)
gateway/core.js            the access decision: proof, replay, consumption, queue
gateway/chain.js           studionet adapter (genlayer-js 2.x, fee-aware writes)
gateway/server.js          HTTP server (plain Node http)
gateway/client.mjs         signed request from a terminal
frontend/index.html        gateway page; frontend/app.js its script
docs/index.html            static Pages demo (live read, recorded fallback)
docs/render.js             the only code that renders untrusted text
tests/gateway.test.mjs     impersonation, replay, failed + concurrent consumption
tests/render.test.mjs      injected markup (strict fake DOM + source scan)
tests/server.test.mjs      HTTP-level checks against the real server
tests/browser/             real-browser injected-markup check
tests/test_marketplace.py  9 direct-mode contract tests (gltest)
deploy/live-check.mjs      live run of the gateway rules on studionet
live-check-partial.json    the partial live run of 2026-11-27 (public data only)
live-check-2026-11-28.json the second, incomplete live run of 2026-11-28 (public data only)
deploy/deploy.mjs          full deploy + seed + buy + verify (pre-fee, see limits)
deploy/interact.mjs        buy + verify against an existing deployment (pre-fee)
deploy/seed.sh             create the 3 listings via the CLI
data/listings.json         the 3 seeded listings (demo-mode catalogue)
data/sample-report.json    human-readable sample of the listing-#3 payload shape
deployment.json            original deployment record (addresses + tx hashes)
```
