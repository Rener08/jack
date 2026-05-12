(function attachProductAdapters(root) {
  const utils = root.ScraperUtils || (typeof require === "function" ? require("./utils.js") : null);

  function getPatagoniaJsonLd(document) {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    for (const script of scripts) {
      const parsed = utils.safeJsonParse(script.textContent);
      if (!parsed) {
        continue;
      }
      const items = utils.flatten(parsed);
      const product = items.find((entry) => entry && typeof entry === "object" && /Product/i.test(String(entry["@type"] || "")));
      if (product) {
        return product;
      }
    }
    return null;
  }

  const genericAdapter = {
    name: "generic",
    match() {
      return true;
    },
    extractList() {
      return [];
    },
    extractDetail() {
      return {};
    },
    resolvePrimaryImage(detail) {
      return detail.primaryImageUrl || detail.mainImageUrls?.[0] || null;
    }
  };

  const patagoniaAdapter = {
    name: "patagonia",
    match(hostname) {
      return /(^|\.)patagonia\.(com|jp|com\.au|ca)$/i.test(hostname);
    },
    extractList(document) {
      const items = [];
      const anchors = Array.from(document.querySelectorAll('a[href*="/product/"]'));

      for (const anchor of anchors) {
        const href = utils.normalizeProductUrl(anchor.href || anchor.getAttribute("href"), document.location.href);
        if (!href) {
          continue;
        }
        const titleCandidate = anchor.getAttribute("title") || anchor.getAttribute("aria-label") || anchor.textContent;
        const parts = utils.splitColorFromTitle(utils.htmlDecode(titleCandidate));
        const image = anchor.querySelector("img");
        const cardText = anchor.closest("article, li, div, section")?.textContent || anchor.textContent;
        const prices = utils.extractPriceStrings(cardText);
        const picked = utils.pickCurrentAndOriginalPrice(prices);
        items.push({
          title: parts.title,
          productUrl: href,
          listPrice: picked.currentPrice,
          listColor: parts.color,
          listImageCandidate: image ? utils.cleanImageUrl(image.currentSrc || image.src, document.location.href) : null
        });
      }

      return utils.dedupeBy(items, (item) => item.productUrl);
    },
    extractDetail(document) {
      const ld = getPatagoniaJsonLd(document);
      const pageText = utils.normalizeText(document.body?.innerText || "");
      const images = utils.unique([
        ...(Array.isArray(ld?.image) ? ld.image : [ld?.image]),
        ...Array.from(document.querySelectorAll("img[data-zoom-image], img[srcset], img[src]"))
          .map((img) => img.getAttribute("data-zoom-image") || img.currentSrc || img.src)
      ].map((url) => utils.cleanImageUrl(url, document.location.href)).filter((url) => url && !utils.isBlockedImageUrl(url)));

      const colorOptions = utils.unique(Array.from(document.querySelectorAll("[aria-label], [title], button, label"))
        .map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent)
        .map((text) => utils.normalizeText(text))
        .filter((text) => text && text.length < 60 && !/サイズ|size|add to cart|カート|wishlist/i.test(text))
        .filter((text) => /black|blue|grey|gray|red|green|white|yellow|orange|pink|navy|feather|shore|stone|sage|カラー|色/i.test(text)));

      const prices = utils.unique([
        ld?.offers?.price ? `¥ ${ld.offers.price}` : null,
        ...utils.extractPriceStrings(pageText.slice(0, 5000))
      ].filter(Boolean));
      const picked = utils.pickCurrentAndOriginalPrice(prices);

      return {
        title: utils.firstNonEmpty([
          ld?.name,
          document.querySelector("meta[property='og:title']")?.content,
          document.querySelector("h1")?.textContent
        ]),
        sku: utils.firstNonEmpty([
          ld?.sku,
          utils.extractSkuFromText(pageText)
        ]),
        originalPrice: picked.originalPrice,
        currentPrice: picked.currentPrice,
        colorCurrent: utils.firstNonEmpty([
          document.querySelector("[aria-current='true']")?.getAttribute("aria-label"),
          colorOptions[0]
        ]),
        colorOptions,
        primaryImageUrl: images[0] || null,
        mainImageUrls: images,
        status: "complete"
      };
    },
    resolvePrimaryImage(detail) {
      return detail.primaryImageUrl || detail.mainImageUrls?.[0] || null;
    }
  };

  const adapters = {
    getAdapter(hostname) {
      return [patagoniaAdapter, genericAdapter].find((adapter) => adapter.match(hostname)) || genericAdapter;
    },
    genericAdapter,
    patagoniaAdapter
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = adapters;
  }
  root.ProductAdapters = adapters;
})(typeof self !== "undefined" ? self : globalThis);
