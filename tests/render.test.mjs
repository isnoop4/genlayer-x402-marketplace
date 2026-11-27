// Focused checks for injected markup in listing and verdict text.
// docs/render.js is the only code that turns untrusted text into DOM. These
// tests run it against a strict fake DOM: setting innerHTML / outerHTML or
// calling insertAdjacentHTML throws, so any HTML-string path fails the test.
//   node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "../docs/render.js";

const R = globalThis.Gen402Render;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class FakeNode {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.className = ""; this._text = null; }
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return (this._text || "") + this.children.map((c) => c.textContent).join(""); }
  set innerHTML(_) { throw new Error("innerHTML is forbidden"); }
  set outerHTML(_) { throw new Error("outerHTML is forbidden"); }
  insertAdjacentHTML() { throw new Error("insertAdjacentHTML is forbidden"); }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  get firstChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
}
const doc = {
  created: [],
  createElement(tag) { const n = new FakeNode(String(tag).toLowerCase()); this.created.push(n); return n; },
  createTextNode(t) { const n = new FakeNode("#text"); n._text = String(t); return n; },
};
const all = (node) => [node, ...node.children.flatMap(all)];

const PAYLOADS = [
  '<script>window.__pwned=1</script>',
  '<img src=x onerror="window.__pwned=1">',
  '"><svg onload=alert(1)>',
  "</small></p><iframe src=javascript:alert(1)>",
  '<a href="javascript:alert(1)">click</a>',
];
const ALLOWED_TAGS = new Set(["div", "h3", "span", "p", "b", "small", "a", "button", "#text"]);
const ALLOWED_ATTRS = new Set(["href", "target", "rel", "type"]);

function hostileListing(payload) {
  return {
    id: 7, title: "T " + payload, description: "D " + payload, data_url: "javascript:alert(1)//" + payload,
    model: 1, price_wei: "100000000000000000", price_human: "P " + payload,
    verdict: { verdict: "MATCH" + payload, confidence: '99"><script>', reason: "R " + payload },
  };
}

test("injected markup in title, description, price, source and verdict stays inert text", () => {
  for (const payload of PAYLOADS) {
    const card = R.renderListingCard(doc, hostileListing(payload), [{ label: "Go", onClick() {} }]);
    const nodes = all(card);
    for (const n of nodes) {
      assert.ok(ALLOWED_TAGS.has(n.tagName), `unexpected element <${n.tagName}>`);
      for (const k of Object.keys(n.attributes)) {
        assert.ok(ALLOWED_ATTRS.has(k), `unexpected attribute ${k}`);
        assert.ok(!/^on/i.test(k));
      }
      if (n.attributes.href !== undefined) assert.match(n.attributes.href, /^https?:\/\//);
    }
    // The hostile text is present, verbatim, as text.
    const text = card.textContent;
    for (const field of ["T ", "D ", "P ", "R "]) assert.ok(text.includes(field + payload), field);
    // The hostile source is shown as plain text, not as a link.
    assert.equal(nodes.filter((n) => n.tagName === "a").length, 0);
    // A verdict word that is not exactly MATCH / MISMATCH / UNREACHABLE is not shown as one.
    const stamp = nodes.find((n) => n.className.startsWith("stamp"));
    assert.equal(stamp.textContent, "UNKNOWN");
    assert.equal(stamp.className, "stamp unreach");
  }
});

test("class names never contain untrusted text", () => {
  const card = R.renderListingCard(doc, hostileListing('x" onmouseover="alert(1)'), []);
  const classes = new Set(all(card).map((n) => n.className));
  for (const c of classes) assert.ok(["", "card", "head-row", "badge", "stamp unreach"].includes(c), c);
});

test("a clean listing renders with a real link, a known verdict and a clamped confidence", () => {
  const card = R.renderListingCard(doc, {
    id: 1, title: "BTC Price Snapshot", description: "Live Bitcoin price", data_url: "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
    model: 0, price_wei: "1000000000000000000", verdict: { verdict: "match", confidence: 250, reason: "ok" },
  }, []);
  const nodes = all(card);
  const a = nodes.find((n) => n.tagName === "a");
  assert.equal(a.attributes.href, "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd");
  assert.equal(a.attributes.rel, "noopener noreferrer");
  assert.equal(nodes.find((n) => n.className === "stamp").textContent, "MATCH · 100%");
  assert.ok(card.textContent.includes("1 GEN, one-time, permanent access"));
});

test("safeHttpUrl accepts only http(s)", () => {
  assert.equal(R.safeHttpUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "//example.com", "/relative", "", null, 42, {}]) {
    assert.equal(R.safeHttpUrl(bad), null, String(bad));
  }
});

test("buttons use addEventListener with a numeric id, never an inline handler", () => {
  let got = null;
  const card = R.renderListingCard(doc, { id: "3); alert(1); (", title: "x", description: "y", data_url: "https://e.com", model: 2, price_wei: "1" }, [{ label: "Go", onClick(id) { got = id; } }]);
  const button = all(card).find((n) => n.tagName === "button");
  assert.deepEqual(Object.keys(button.attributes), ["type"]);
  button.listeners.click[0]();
  assert.ok(Number.isNaN(got)); // the hostile id never becomes code
});

test("renderMeta links only a well-formed contract address", () => {
  const box = new FakeNode("p");
  R.renderMeta(doc, box, { contract: '0x3B0850628992B0F322D1Af7196a9337AdF7655B4', chainId: 61999 });
  assert.equal(all(box).find((n) => n.tagName === "a").attributes.href, "https://explorer-studio.genlayer.com/address/0x3B0850628992B0F322D1Af7196a9337AdF7655B4");
  const bad = new FakeNode("p");
  R.renderMeta(doc, bad, { contract: '"><script>alert(1)</script>', explorer: "javascript:alert(1)", chainId: "<b>" });
  assert.equal(all(bad).filter((n) => n.tagName === "a").length, 0);
  assert.ok(bad.textContent.includes("chain ?"));
});

test("page sources contain no HTML-string sinks and no inline event handlers", async () => {
  for (const file of ["docs/index.html", "docs/render.js", "frontend/index.html", "frontend/app.js"]) {
    const src = await readFile(path.join(ROOT, file), "utf-8");
    // Comments may name the sinks; code must not use them.
    const code = src.split("\n").filter((line) => !/^\s*(\/\/|\*|<!--)/.test(line)).join("\n");
    for (const sink of [/\.innerHTML\s*[+]?=/, /\.outerHTML\s*[+]?=/, /insertAdjacentHTML\s*\(/, /document\.write(ln)?\s*\(/, /\beval\s*\(/, /new Function\s*\(/]) {
      assert.ok(!sink.test(code), `${file} uses ${sink}`);
    }
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(code), `${file} has an inline event handler`);
  }
});
