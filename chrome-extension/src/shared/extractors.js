(function attachProductExtractors(root) {
  const utils = root.ScraperUtils || (typeof require === "function" ? require("./utils.js") : null);
  const adapters = root.ProductAdapters || (typeof require === "function" ? require("./adapters.js") : null);

  function parseJsonLdProducts(document) {
    const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
    const products = [];

    for (const script of scripts) {
      const parsed = utils.safeJsonParse(script.textContent);
      if (!parsed) {
        continue;
      }

      for (const item of utils.flatten(parsed)) {
        if (item && typeof item === "object" && /Product/i.test(String(item["@type"] || ""))) {
          products.push(item);
        }
      }
    }

    return products;
  }

  function getDocumentAdapter(document) {
    return adapters.getAdapter(document.location.hostname);
  }

  function nodeIsInIgnoredRegion(node) {
    return Boolean(node.closest("header, footer, nav, aside, [role='navigation'], [role='banner']"));
  }

  function findCard(anchor) {
    const ownerDocument = anchor.ownerDocument;
    let current = anchor;
    let depth = 0;
    let best = anchor;
    let bestScore = 0;

    while (current && current !== ownerDocument.body && depth < 6) {
      if (nodeIsInIgnoredRegion(current)) {
        break;
      }
      const text = utils.normalizeText(current.textContent);
      const score =
        (current.querySelector("img") ? 3 : 0) +
        (utils.extractPriceStrings(text).length ? 3 : 0) +
        (/product|card|item|tile|grid/i.test(current.className || "") ? 2 : 0) +
        (text.length >= 6 && text.length <= 500 ? 2 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = current;
      }
      current = current.parentElement;
      depth += 1;
    }

    return best;
  }

  function extractTitleFromCard(card, anchor) {
    const candidates = [
      anchor.getAttribute("title"),
      anchor.getAttribute("aria-label"),
      card.querySelector("h1, h2, h3, h4, [itemprop='name'], [data-testid*='title'], [class*='title']")?.textContent,
      anchor.textContent
    ].map((value) => utils.htmlDecode(value)).filter(Boolean);

    for (const candidate of candidates) {
      const normalized = utils.normalizeText(candidate);
      if (normalized.length >= 4 && normalized.length <= 180 && !utils.CURRENCY_RE.test(normalized)) {
        return normalized;
      }
    }

    return null;
  }

  function extractColorFromCard(card, title) {
    const swatches = Array.from(card.querySelectorAll("[aria-label], [title], [data-color], [data-colour]"))
      .map((node) => node.getAttribute("data-color") || node.getAttribute("data-colour") || node.getAttribute("aria-label") || node.getAttribute("title"))
      .map((value) => utils.normalizeText(value))
      .filter((value) => value && value.length < 50);

    if (swatches.length) {
      return swatches[0];
    }

    return utils.splitColorFromTitle(title).color;
  }

  function extractListGeneric(document) {
    const anchors = Array.from((document.querySelector("main") || document.body).querySelectorAll("a[href]"));
    const items = [];

    for (const anchor of anchors) {
      if (nodeIsInIgnoredRegion(anchor)) {
        continue;
      }

      const href = utils.normalizeProductUrl(anchor.getAttribute("href") || anchor.href, document.location.href);
      if (!utils.isProbablyProductUrl(href)) {
        continue;
      }

      const card = findCard(anchor);
      if (!card) {
        continue;
      }

      const title = extractTitleFromCard(card, anchor);
      if (!title) {
        continue;
      }

      const image = card.querySelector("img");
      const imageUrl = utils.cleanImageUrl(
        image?.getAttribute("data-zoom-image") ||
        image?.getAttribute("data-src") ||
        image?.getAttribute("data-lazy-src") ||
        image?.currentSrc ||
        image?.src,
        document.location.href
      );

      const prices = utils.extractPriceStrings(card.textContent);
      const picked = utils.pickCurrentAndOriginalPrice(prices);
      const listColor = extractColorFromCard(card, title);

      items.push({
        title,
        productUrl: href,
        listPrice: picked.currentPrice,
        listColor,
        listImageCandidate: utils.isBlockedImageUrl(imageUrl) ? null : imageUrl
      });
    }

    return utils.dedupeBy(items, (item) => item.productUrl);
  }

  function collectImageCandidates(document, ldProducts) {
    const urls = [];
    const push = (value) => {
      const cleaned = utils.cleanImageUrl(value, document.location.href);
      if (cleaned && !utils.isBlockedImageUrl(cleaned)) {
        urls.push(cleaned);
      }
    };

    for (const product of ldProducts) {
      const images = Array.isArray(product.image) ? product.image : [product.image];
      images.filter(Boolean).forEach(push);
    }

    push(document.querySelector("meta[property='og:image']")?.content);

    const imageNodes = Array.from(document.querySelectorAll("img[src], img[srcset], img[data-src], img[data-zoom-image], source[srcset]"));
    for (const node of imageNodes) {
      const srcset = node.getAttribute("srcset");
      if (srcset) {
        const first = srcset.split(",")[0]?.trim()?.split(" ")[0];
        push(first);
      }
      push(node.getAttribute("data-zoom-image"));
      push(node.getAttribute("data-src"));
      push(node.currentSrc || node.getAttribute("src"));
    }

    return utils.unique(urls);
  }

  function extractColors(document) {
    const candidates = Array.from(document.querySelectorAll("[data-color], [data-colour], [aria-label], [title], button, option, label"))
      .map((node) => node.getAttribute("data-color") || node.getAttribute("data-colour") || node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent)
      .map((value) => utils.normalizeText(value))
      .filter((value) => value && value.length <= 50)
      .filter((value) => !/size|qty|quantity|wishlist|cart|add to/i.test(value))
      .filter((value) => utils.looksLikeColorLabel(value));
    return utils.unique(candidates).slice(0, 20);
  }

  function extractCurrentColor(document, colorOptions) {
    const explicit = Array.from(document.querySelectorAll("[aria-selected='true'], [aria-pressed='true'], .selected, .active"))
      .map((node) => node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent)
      .map((value) => utils.normalizeText(value))
      .find(Boolean);

    if (explicit) {
      return explicit;
    }

    const labelMatch = utils.normalizeText(document.body?.innerText || "").match(/(?:color|colour|カラー|色)[:：]?\s*([^\n|]{2,40})/i);
    if (labelMatch) {
      return utils.normalizeText(labelMatch[1]);
    }

    return colorOptions[0] || null;
  }

  function extractDetailGeneric(document) {
    const ldProducts = parseJsonLdProducts(document);
    const bodyText = utils.normalizeText(document.body?.innerText || "");
    const title = utils.firstNonEmpty([
      ldProducts[0]?.name,
      document.querySelector("meta[property='og:title']")?.content,
      document.querySelector("h1")?.textContent,
      document.title
    ]);

    const priceCandidates = utils.unique([
      ...ldProducts.flatMap((product) => {
        const offers = utils.flatten(product.offers || []);
        return offers.map((offer) => {
          if (!offer || typeof offer !== "object") {
            return null;
          }
          if (offer.priceCurrency && offer.price) {
            return `${offer.priceCurrency} ${offer.price}`;
          }
          return offer.price ? String(offer.price) : null;
        });
      }),
      ...utils.extractPriceStrings(bodyText.slice(0, 4000))
    ].filter(Boolean));

    const picked = utils.pickCurrentAndOriginalPrice(priceCandidates);
    const colorOptions = extractColors(document);
    const mainImageUrls = collectImageCandidates(document, ldProducts);
    const sku = utils.firstNonEmpty([
      ldProducts[0]?.sku,
      document.querySelector("[itemprop='sku']")?.getAttribute("content"),
      document.querySelector("[itemprop='sku']")?.textContent,
      utils.extractSkuFromText(bodyText)
    ]);

    return {
      title,
      sku,
      originalPrice: picked.originalPrice,
      currentPrice: picked.currentPrice,
      colorCurrent: extractCurrentColor(document, colorOptions),
      colorOptions,
      primaryImageUrl: mainImageUrls[0] || null,
      mainImageUrls,
      status: title || picked.currentPrice || mainImageUrls.length ? "complete" : "partial"
    };
  }

  function extractList(document) {
    const adapter = getDocumentAdapter(document);
    const genericItems = extractListGeneric(document);
    const specificItems = adapter.name !== "generic" ? (adapter.extractList(document, utils) || []) : [];
    const items = specificItems.length ? specificItems : genericItems;
    return utils.dedupeBy(items, (item) => item.productUrl).map((item) => ({
      title: utils.normalizeText(item.title),
      productUrl: item.productUrl,
      listPrice: item.listPrice || null,
      listColor: item.listColor || null,
      listImageCandidate: item.listImageCandidate || null
    }));
  }

  function extractDetail(document) {
    const adapter = getDocumentAdapter(document);
    const genericDetail = extractDetailGeneric(document);
    const specificDetail = adapter.name !== "generic" ? (adapter.extractDetail(document, utils) || {}) : {};
    const detail = {
      ...genericDetail,
      ...specificDetail
    };
    detail.mainImageUrls = utils.unique((detail.mainImageUrls || []).map((value) => utils.cleanImageUrl(value, document.location.href)).filter(Boolean));
    detail.primaryImageUrl = adapter.resolvePrimaryImage(detail, document, utils) || detail.primaryImageUrl || detail.mainImageUrls[0] || null;
    detail.colorOptions = utils.unique((detail.colorOptions || []).map((value) => utils.normalizeText(value)).filter(Boolean));
    detail.title = detail.title ? utils.normalizeText(detail.title) : null;
    detail.colorCurrent = detail.colorCurrent ? utils.normalizeText(detail.colorCurrent) : null;
    detail.status = detail.status || "partial";
    return detail;
  }

  const extractors = {
    extractDetail,
    extractList,
    extractDetailGeneric,
    extractListGeneric,
    parseJsonLdProducts
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = extractors;
  }
  root.ProductExtractors = extractors;
})(typeof self !== "undefined" ? self : globalThis);
