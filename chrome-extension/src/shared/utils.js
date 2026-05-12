(function attachScraperUtils(root) {
  const PRICE_RE = /(?:[$€£¥￥]\s?[\d,.]+|[\d,.]+\s?(?:USD|EUR|GBP|JPY|円))/gi;
  const CURRENCY_RE = /[$€£¥￥]|USD|EUR|GBP|JPY|円/i;
  const BLOCKED_IMAGE_PATTERNS = [
    /logo/i,
    /icon/i,
    /sprite/i,
    /banner/i,
    /placeholder/i,
    /spacer/i,
    /avatar/i,
    /thumb/i,
    /review/i,
    /youtube\.com/i,
    /ytimg\.com/i,
    /doubleclick/i,
    /google-analytics/i,
    /facebook/i
  ];

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function htmlDecode(value) {
    if (!value) {
      return "";
    }
    const text = String(value)
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    return normalizeText(text);
  }

  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function dedupeBy(items, getKey) {
    const seen = new Set();
    return (items || []).filter((item) => {
      const key = getKey(item);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function toAbsoluteUrl(href, baseUrl) {
    try {
      return new URL(href, baseUrl || root.location?.href || "https://example.com").href;
    } catch (error) {
      return null;
    }
  }

  function normalizeProductUrl(href, baseUrl) {
    const absolute = toAbsoluteUrl(href, baseUrl);
    if (!absolute) {
      return null;
    }

    try {
      const url = new URL(absolute);
      url.hash = "";
      ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"].forEach((key) => {
        url.searchParams.delete(key);
      });
      return url.href;
    } catch (error) {
      return absolute;
    }
  }

  function isProbablyProductUrl(href) {
    if (!href) {
      return false;
    }
    const normalized = href.toLowerCase();
    if (
      normalized.startsWith("javascript:") ||
      normalized.startsWith("mailto:") ||
      normalized.startsWith("tel:") ||
      normalized.startsWith("#")
    ) {
      return false;
    }
    return /product|products|prod|item|sku|shop|p\/|dp\//i.test(normalized);
  }

  function extractPriceStrings(text) {
    const matches = normalizeText(text).match(PRICE_RE) || [];
    return unique(matches.map((entry) => normalizeText(entry)));
  }

  function parsePriceNumber(priceText) {
    if (!priceText) {
      return null;
    }
    const normalized = String(priceText).replace(/[^\d.,]/g, "");
    if (!normalized) {
      return null;
    }
    const commaCount = (normalized.match(/,/g) || []).length;
    const dotCount = (normalized.match(/\./g) || []).length;
    let value = normalized;
    if (commaCount > 0 && dotCount > 0) {
      value = normalized.replace(/,/g, "");
    } else if (commaCount > 1 && dotCount === 0) {
      value = normalized.replace(/,/g, "");
    } else if (commaCount === 1 && dotCount === 0) {
      value = normalized.replace(",", ".");
    } else {
      value = normalized.replace(/,/g, "");
    }
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function pickCurrentAndOriginalPrice(values) {
    const candidates = unique(values || []).map((entry) => ({
      raw: entry,
      value: parsePriceNumber(entry)
    })).filter((entry) => entry.value !== null);

    if (!candidates.length) {
      return {
        currentPrice: null,
        originalPrice: null
      };
    }

    candidates.sort((left, right) => left.value - right.value);
    const current = candidates[0]?.raw || null;
    const original = candidates.length > 1 && candidates[candidates.length - 1].value !== candidates[0].value
      ? candidates[candidates.length - 1].raw
      : null;

    return {
      currentPrice: current,
      originalPrice: original
    };
  }

  function firstNonEmpty(values) {
    return (values || []).find((value) => normalizeText(value));
  }

  function isBlockedImageUrl(url) {
    if (!url) {
      return true;
    }
    return BLOCKED_IMAGE_PATTERNS.some((pattern) => pattern.test(url));
  }

  function cleanImageUrl(url, baseUrl) {
    const absolute = toAbsoluteUrl(url, baseUrl);
    if (!absolute) {
      return null;
    }
    try {
      const parsed = new URL(absolute);
      parsed.hash = "";
      return parsed.href;
    } catch (error) {
      return absolute;
    }
  }

  function fitImageWithin(width, height, maxWidth, maxHeight) {
    if (!width || !height) {
      return {
        width: maxWidth,
        height: maxHeight
      };
    }
    const widthRatio = maxWidth / width;
    const heightRatio = maxHeight / height;
    const ratio = Math.min(widthRatio, heightRatio, 1);
    return {
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio))
    };
  }

  function pxToColumnWidth(px) {
    return Math.round((px / 7) * 100) / 100;
  }

  function pxToRowHeight(px) {
    return Math.round((px * 0.75) * 100) / 100;
  }

  function extractSkuFromText(text) {
    const normalized = normalizeText(text);
    const match = normalized.match(/(?:SKU|品番|製品番号|商品番号)[:：#]?\s*([A-Z0-9-]{3,})/i);
    return match ? match[1] : null;
  }

  function looksLikeColorLabel(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }
    if (normalized.length > 50) {
      return false;
    }
    return /color|colour|カラー|色/i.test(normalized) || /^[A-Za-z][A-Za-z0-9\s\-/'&]+$/.test(normalized);
  }

  function splitColorFromTitle(text) {
    const normalized = normalizeText(text);
    const match = normalized.match(/^(.*?)(?:\s+-\s+|\s+\u2013\s+)([^-]{2,40})$/);
    if (!match) {
      return {
        title: normalized,
        color: null
      };
    }
    return {
      title: normalizeText(match[1]),
      color: normalizeText(match[2])
    };
  }

  function safeJsonParse(text) {
    try {
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }

  function flatten(value) {
    if (Array.isArray(value)) {
      return value.flatMap(flatten);
    }
    return [value];
  }

  const utils = {
    CURRENCY_RE,
    cleanImageUrl,
    dedupeBy,
    extractPriceStrings,
    extractSkuFromText,
    firstNonEmpty,
    fitImageWithin,
    flatten,
    htmlDecode,
    isBlockedImageUrl,
    isProbablyProductUrl,
    looksLikeColorLabel,
    normalizeProductUrl,
    normalizeText,
    parsePriceNumber,
    pickCurrentAndOriginalPrice,
    pxToColumnWidth,
    pxToRowHeight,
    safeJsonParse,
    splitColorFromTitle,
    toAbsoluteUrl,
    unique
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = utils;
  }
  root.ScraperUtils = utils;
})(typeof self !== "undefined" ? self : globalThis);
