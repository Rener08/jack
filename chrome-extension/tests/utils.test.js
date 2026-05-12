const test = require("node:test");
const assert = require("node:assert/strict");

const ScraperUtils = require("../src/shared/utils.js");
global.self = globalThis;
global.ScraperUtils = ScraperUtils;
const ProductAdapters = require("../src/shared/adapters.js");

test("pickCurrentAndOriginalPrice returns the lowest as current and highest as original", () => {
  const picked = ScraperUtils.pickCurrentAndOriginalPrice(["$79.00", "$59.00"]);
  assert.deepEqual(picked, {
    currentPrice: "$59.00",
    originalPrice: "$79.00"
  });
});

test("fitImageWithin preserves aspect ratio within bounds", () => {
  assert.deepEqual(ScraperUtils.fitImageWithin(1200, 800, 220, 220), {
    width: 220,
    height: 147
  });
  assert.deepEqual(ScraperUtils.fitImageWithin(400, 1200, 220, 220), {
    width: 73,
    height: 220
  });
});

test("normalizeProductUrl removes tracking parameters and keeps product path", () => {
  const normalized = ScraperUtils.normalizeProductUrl(
    "https://shop.example.com/product/alpha-shirt?utm_source=test&color=blue#details"
  );
  assert.equal(normalized, "https://shop.example.com/product/alpha-shirt?color=blue");
});

test("patagonia adapter matches patagonia domains", () => {
  assert.equal(ProductAdapters.getAdapter("www.patagonia.jp").name, "patagonia");
  assert.equal(ProductAdapters.getAdapter("www.patagonia.com").name, "patagonia");
  assert.equal(ProductAdapters.getAdapter("shop.example.com").name, "generic");
});
