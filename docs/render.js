// Gen402 — safe rendering of listing and verdict text.
//
// Everything a seller or a validator's LLM wrote (title, description, source
// URL, verdict reason, …) is UNTRUSTED. This file is the only place the pages
// turn that text into DOM, and it does so with createElement + textContent
// only: no innerHTML, no HTML strings, no inline event handlers. Links are
// created only for http(s) URLs.
//
// Classic script on purpose (works from file://, GitHub Pages and the
// gateway): it defines globalThis.Gen402Render. Node tests import it for the
// same global (tests/render.test.mjs).
(function (root) {
  "use strict";

  var MODEL_NAMES = ["paywall", "metered", "subscription"];
  var VERDICT_CLASS = { MATCH: "", MISMATCH: "mismatch", UNREACHABLE: "unreach" };

  function text(value, max) {
    var s = value === null || value === undefined ? "" : String(value);
    return max && s.length > max ? s.slice(0, max) + "…" : s;
  }

  // Returns a normalised http(s) URL string, or null for anything else
  // (javascript:, data:, vbscript:, relative paths, garbage).
  function safeHttpUrl(value) {
    if (typeof value !== "string") return null;
    var u;
    try { u = new URL(value.trim()); } catch (e) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  }

  function el(doc, tag, className, content) {
    var node = doc.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = text(content);
    return node;
  }

  function link(doc, href, label) {
    var safe = safeHttpUrl(href);
    if (!safe) return el(doc, "span", "", label);
    var a = el(doc, "a", "", label);
    a.setAttribute("href", safe);
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
    return a;
  }

  // Only a known verdict word reaches the page as a verdict; anything else is
  // shown as UNKNOWN. The confidence is forced to an integer 0-100.
  function normaliseVerdict(v) {
    if (!v || typeof v !== "object") return null;
    var word = text(v.verdict).trim().toUpperCase();
    var known = Object.prototype.hasOwnProperty.call(VERDICT_CLASS, word);
    var conf = Number(v.confidence);
    conf = Number.isFinite(conf) ? Math.max(0, Math.min(100, Math.round(conf))) : null;
    return {
      word: known ? word : "UNKNOWN",
      cls: known ? VERDICT_CLASS[word] : "unreach",
      confidence: conf,
      reason: text(v.reason, 400),
    };
  }

  function modelName(listing) {
    var idx = Number(listing.model);
    if (Number.isInteger(idx) && idx >= 0 && idx < MODEL_NAMES.length) return MODEL_NAMES[idx];
    return "unknown";
  }

  function priceText(listing) {
    if (listing.price_human) return text(listing.price_human, 120);
    var wei = text(listing.price_wei);
    if (!/^\d{1,40}$/.test(wei)) return "price unavailable";
    var padded = wei.padStart(19, "0");
    var whole = padded.slice(0, -18).replace(/^0+(?=\d)/, "");
    var frac = padded.slice(-18).replace(/0+$/, "");
    var gen = whole + (frac ? "." + frac : "") + " GEN";
    var idx = Number(listing.model);
    if (idx === 1) return gen + " per credit (1 credit = 1 call)";
    if (idx === 2) return gen + " per bundle of 30 calls";
    return gen + ", one-time, permanent access";
  }

  // actions: [{ label, onClick(listingId) }]
  function renderListingCard(doc, listing, actions) {
    var id = Number(listing.id);
    var card = el(doc, "div", "card");

    var head = el(doc, "div", "head-row");
    head.appendChild(el(doc, "h3", "", "#" + (Number.isInteger(id) ? id : "?") + " " + text(listing.title, 160)));
    var v = normaliseVerdict(listing.verdict);
    if (v) {
      head.appendChild(el(doc, "span", "stamp" + (v.cls ? " " + v.cls : ""),
        v.word + (v.confidence === null ? "" : " · " + v.confidence + "%")));
    }
    card.appendChild(head);

    card.appendChild(el(doc, "p", "", text(listing.description, 800)));

    var price = el(doc, "p");
    price.appendChild(el(doc, "span", "badge", modelName(listing)));
    price.appendChild(doc.createTextNode(" "));
    price.appendChild(el(doc, "b", "", priceText(listing)));
    card.appendChild(price);

    var src = el(doc, "p");
    var srcSmall = el(doc, "small", "", "Source: ");
    srcSmall.appendChild(link(doc, listing.data_url, text(listing.data_url, 300)));
    src.appendChild(srcSmall);
    card.appendChild(src);

    var note = el(doc, "p");
    note.appendChild(el(doc, "small", "", v
      ? "Last AI verdict: " + v.reason
      : "No delivery verdict yet — anyone can call verify_delivery() on-chain."));
    card.appendChild(note);

    (actions || []).forEach(function (action) {
      var button = el(doc, "button", "", action.label);
      button.setAttribute("type", "button");
      button.addEventListener("click", function () { action.onClick(id); });
      card.appendChild(button);
      card.appendChild(doc.createTextNode(" "));
    });
    return card;
  }

  function renderListings(doc, container, listings, actions) {
    while (container.firstChild) container.removeChild(container.firstChild);
    (Array.isArray(listings) ? listings : []).forEach(function (l) {
      if (l && typeof l === "object") container.appendChild(renderListingCard(doc, l, actions));
    });
  }

  // "Contract: <link> · chain N · …" line of the gateway page.
  function renderMeta(doc, container, info) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(doc.createTextNode("Contract: "));
    var address = text(info && info.contract);
    if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
      container.appendChild(link(doc, "https://explorer-studio.genlayer.com/address/" + address, address));
    } else {
      container.appendChild(el(doc, "b", "", "not configured — DEMO mode"));
    }
    var chain = Number(info && info.chainId);
    container.appendChild(doc.createTextNode(" · chain " + (Number.isInteger(chain) ? chain : "?")
      + (info && info.demoMode ? " · demo mode" : "")
      + (info && info.meteredEnabled === false && !info.demoMode ? " · metered/subscription refused (gateway has no key)" : "")));
  }

  root.Gen402Render = {
    safeHttpUrl: safeHttpUrl,
    normaliseVerdict: normaliseVerdict,
    priceText: priceText,
    renderListingCard: renderListingCard,
    renderListings: renderListings,
    renderMeta: renderMeta,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
