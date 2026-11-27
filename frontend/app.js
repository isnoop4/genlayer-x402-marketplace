// Gen402 gateway page. All listing / verdict text is rendered by
// Gen402Render (docs/render.js) with textContent only.
(function () {
  "use strict";
  var R = window.Gen402Render;
  var out = document.getElementById("out");

  function show(label, status, value) {
    var body = typeof value === "string" ? value.slice(0, 4000) : JSON.stringify(value, null, 2);
    out.textContent = label + " — HTTP " + status + "\n" + body;
  }
  async function readBody(r) {
    var t = await r.text();
    try { return JSON.parse(t); } catch (e) { return t; }
  }
  function reason(r) {
    var why = r.headers.get("X-Gen402-Reason");
    return why ? "\nreason: " + why : "";
  }

  async function reqNoProof(id) {
    var r = await fetch("/data/" + id);
    show("GET /data/" + id + " (no proof)" + reason(r), r.status, await readBody(r));
  }

  async function reqTxOnly(id) {
    var tx = document.getElementById("tx").value.trim();
    var buyer = document.getElementById("buyer").value.trim();
    var r = await fetch("/data/" + id, { headers: { "X-Payment": tx, "X-Buyer": buyer } });
    show("GET /data/" + id + " (tx hash + address only)" + reason(r), r.status, await readBody(r));
  }

  async function reqWithProof(id) {
    if (!window.ethereum) {
      out.textContent = "No browser wallet found. Run the same flow from a terminal:\n"
        + "  BUYER_PRIVATE_KEY=0x… node gateway/client.mjs " + location.origin + " " + id;
      return;
    }
    try {
      var accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      var buyer = String(accounts[0]);
      document.getElementById("buyer").value = buyer;
      out.textContent = "Requesting a challenge…";
      var c = await fetch("/challenge/" + id + "?buyer=" + encodeURIComponent(buyer));
      var challenge = await readBody(c);
      if (!c.ok) return show("GET /challenge/" + id, c.status, challenge);
      out.textContent = "Sign the challenge in your wallet…\n\n" + challenge.message;
      var signature = await window.ethereum.request({ method: "personal_sign", params: [challenge.message, buyer] });
      out.textContent = "Proof sent. For metered and subscription listings the gateway now waits for the credit consumption to finalize on-chain…";
      var r = await fetch("/data/" + id, { headers: { "X-Buyer": buyer, "X-Nonce": challenge.nonce, "X-Signature": signature } });
      var used = r.headers.get("X-Gen402-Consumption");
      show("GET /data/" + id + " (signed proof)" + reason(r) + (used ? "\nconsumption tx: " + used : ""), r.status, await readBody(r));
    } catch (e) {
      out.textContent = "Stopped: " + (e && e.message ? e.message : String(e));
    }
  }

  async function load() {
    var r = await fetch("/listings");
    var j = await r.json();
    R.renderMeta(document, document.getElementById("meta"), j);
    R.renderListings(document, document.getElementById("listings"), j.listings, [
      { label: "Request without proof", onClick: reqNoProof },
      { label: "Request with wallet proof", onClick: reqWithProof },
      { label: "Send tx hash only", onClick: reqTxOnly },
    ]);
  }
  load().catch(function (e) { out.textContent = "Could not load listings: " + (e && e.message ? e.message : String(e)); });
})();
