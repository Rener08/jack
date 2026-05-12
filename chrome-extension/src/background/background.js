importScripts("../vendor/exceljs.min.js", "../shared/utils.js", "../shared/adapters.js", "../shared/extractors.js");

const STORAGE_KEYS = {
  rows: "latestExportRows",
  state: "scrapeState"
};

const SCRIPT_FILES = [
  "src/shared/utils.js",
  "src/shared/adapters.js",
  "src/shared/extractors.js",
  "src/content/content-script.js"
];

const MAX_DETAIL_CONCURRENCY = 2;
const MAX_IMAGE_CONCURRENCY = 2;
const MAX_IMAGE_WIDTH = 220;
const MAX_IMAGE_HEIGHT = 220;
const DETAIL_SETTLE_DELAY_MS = 1200;
const DETAIL_RETRY_DELAY_MS = 1000;
const DETAIL_MAX_ATTEMPTS = 3;

let currentJobPromise = null;
let currentJobControl = null;

function getInitialState() {
  return {
    running: false,
    paused: false,
    phase: "idle",
    sourceUrl: null,
    adapterName: null,
    totalProducts: 0,
    detailCompleted: 0,
    imageCompleted: 0,
    failedCount: 0,
    exportedAt: null,
    error: null,
    summary: null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStorageState() {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.state, STORAGE_KEYS.rows]);
  return {
    state: stored[STORAGE_KEYS.state] || getInitialState(),
    rows: stored[STORAGE_KEYS.rows] || []
  };
}

async function patchState(patch) {
  const { state } = await getStorageState();
  const next = {
    ...state,
    ...patch
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.state]: next
  });
  return next;
}

async function setRows(rows) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.rows]: rows
  });
}

async function resetJobState(sourceUrl) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.rows]: [],
    [STORAGE_KEYS.state]: {
      ...getInitialState(),
      running: true,
      phase: "extracting-list",
      sourceUrl
    }
  });
}

function createJobControl() {
  return {
    paused: false,
    cancelled: false
  };
}

async function waitWhilePaused(control) {
  while (control?.paused && !control?.cancelled) {
    await sleep(250);
  }
}

async function ensureScriptsInjected(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: SCRIPT_FILES
  });
}

async function sendMessageToTab(tabId, message) {
  await ensureScriptsInjected(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") {
    return tab;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out waiting for tab ${tabId}`));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo, updatedTab) {
      if (updatedTabId !== tabId) {
        return;
      }
      if (changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(updatedTab);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForPageSettled(tabId) {
  await waitForTabComplete(tabId);
  await sleep(DETAIL_SETTLE_DELAY_MS);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => new Promise((resolve) => {
        if (document.readyState === "complete") {
          setTimeout(resolve, 600);
          return;
        }
        window.addEventListener("load", () => setTimeout(resolve, 600), { once: true });
        setTimeout(resolve, 1500);
      })
    });
  } catch (error) {
    // Ignore settle failures and continue with best effort extraction.
  }
}

function mergeSeedAndDetail(seed, detail, fallbackStatus) {
  const mainImageUrls = ScraperUtils.unique([
    ...(detail.mainImageUrls || []),
    seed.listImageCandidate
  ].filter(Boolean));

  return {
    imageEmbedded: null,
    title: detail.title || seed.title || null,
    sku: detail.sku || null,
    original_price: detail.originalPrice || null,
    current_price: detail.currentPrice || seed.listPrice || null,
    product_url: seed.productUrl,
    color_current: detail.colorCurrent || seed.listColor || null,
    color_options: ScraperUtils.unique((detail.colorOptions || []).filter(Boolean)),
    primary_image_url: detail.primaryImageUrl || seed.listImageCandidate || mainImageUrls[0] || null,
    main_image_urls: mainImageUrls,
    status: detail.status || fallbackStatus || "partial"
  };
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  const count = Math.min(concurrency, items.length);
  const workers = [];

  for (let runner = 0; runner < count; runner += 1) {
    workers.push((async () => {
      while (index < items.length) {
        await waitWhilePaused(currentJobControl);
        if (currentJobControl?.cancelled) {
          return;
        }
        const currentIndex = index;
        index += 1;
        await worker(items[currentIndex], currentIndex);
      }
    })());
  }

  await Promise.all(workers);
}

async function scrapeDetailForSeed(seed) {
  let tab = null;
  try {
    if (currentJobControl?.cancelled) {
      return mergeSeedAndDetail(seed, { status: "partial" }, "partial");
    }

    tab = await chrome.tabs.create({
      url: seed.productUrl,
      active: false
    });
    await waitForPageSettled(tab.id);

    let bestDetail = null;
    for (let attempt = 0; attempt < DETAIL_MAX_ATTEMPTS; attempt += 1) {
      await waitWhilePaused(currentJobControl);
      if (currentJobControl?.cancelled) {
        break;
      }

      const response = await sendMessageToTab(tab.id, { type: "SCRAPE_DETAIL" });
      if (response?.ok && response.detail) {
        bestDetail = response.detail;
        if (response.detail.title && (response.detail.currentPrice || response.detail.primaryImageUrl)) {
          break;
        }
      }

      if (attempt < DETAIL_MAX_ATTEMPTS - 1) {
        await sleep(DETAIL_RETRY_DELAY_MS);
      }
    }

    if (!bestDetail) {
      throw new Error("Detail extraction failed");
    }

    return mergeSeedAndDetail(seed, bestDetail, "complete");
  } catch (error) {
    return mergeSeedAndDetail(seed, {
      status: "partial"
    }, "partial");
  } finally {
    if (tab?.id) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch (error) {
        // Ignore cleanup errors.
      }
    }
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

async function blobToPngBase64(blob) {
  const bitmap = await createImageBitmap(blob);
  const fitted = ScraperUtils.fitImageWithin(bitmap.width, bitmap.height, MAX_IMAGE_WIDTH, MAX_IMAGE_HEIGHT);
  const canvas = new OffscreenCanvas(fitted.width, fitted.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, fitted.width, fitted.height);
  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  const arrayBuffer = await pngBlob.arrayBuffer();
  return {
    base64: arrayBufferToBase64(arrayBuffer),
    width: fitted.width,
    height: fitted.height,
    extension: "png"
  };
}

async function fetchEmbeddedImage(url) {
  if (!url) {
    return null;
  }
  const response = await fetch(url, {
    credentials: "include",
    redirect: "follow"
  });
  if (!response.ok) {
    throw new Error(`Image fetch failed with ${response.status}`);
  }
  const blob = await response.blob();
  return blobToPngBase64(blob);
}

async function populateRowImages(rows) {
  await patchState({
    phase: "downloading-images",
    imageCompleted: 0
  });

  await runPool(rows, MAX_IMAGE_CONCURRENCY, async (row, index) => {
    if (currentJobControl?.cancelled) {
      return;
    }
    const imageUrl = row.primary_image_url || row.main_image_urls?.[0] || null;
    try {
      const embedded = await fetchEmbeddedImage(imageUrl);
      rows[index] = {
        ...row,
        imageEmbedded: embedded
      };
    } catch (error) {
      rows[index] = {
        ...row,
        imageEmbedded: null
      };
    } finally {
      const { state } = await getStorageState();
      await patchState({
        imageCompleted: Math.min(state.imageCompleted + 1, rows.length)
      });
      await setRows(rows);
    }
  });
}

async function scrapeCurrentPage(tabId, sourceUrl) {
  await resetJobState(sourceUrl);
  currentJobControl = createJobControl();
  await waitForPageSettled(tabId);
  const listResponse = await sendMessageToTab(tabId, { type: "SCRAPE_LIST" });
  if (!listResponse?.ok || !Array.isArray(listResponse.items) || !listResponse.items.length) {
    throw new Error(listResponse?.error || "No product cards found on the current page.");
  }

  const seeds = ScraperUtils.dedupeBy(listResponse.items, (item) => item.productUrl);
  const rows = new Array(seeds.length);
  await patchState({
    adapterName: listResponse.adapterName || null,
    totalProducts: seeds.length,
    phase: "extracting-details"
  });

  await runPool(seeds, MAX_DETAIL_CONCURRENCY, async (seed, index) => {
    if (currentJobControl?.cancelled) {
      return;
    }
    const row = await scrapeDetailForSeed(seed);
    rows[index] = row;
    const { state } = await getStorageState();
    await patchState({
      detailCompleted: Math.min(state.detailCompleted + 1, seeds.length),
      failedCount: state.failedCount + (row.status === "failed" ? 1 : 0)
    });
    await setRows(rows.filter(Boolean));
  });

  const partialRows = rows.filter(Boolean);
  await setRows(partialRows);

  if (!currentJobControl?.cancelled) {
    await populateRowImages(partialRows);
  }

  const finalRows = (await getStorageState()).rows;
  const wasCancelled = Boolean(currentJobControl?.cancelled);
  const hasRows = finalRows.length > 0;

  await chrome.storage.local.set({
    [STORAGE_KEYS.rows]: finalRows,
    [STORAGE_KEYS.state]: {
      ...(await getStorageState()).state,
      running: false,
      paused: false,
      phase: hasRows ? "ready" : "idle",
      summary: wasCancelled
        ? `Stopped. ${finalRows.length} products collected so far.`
        : `${finalRows.length} products ready for export.`
    }
  });
  currentJobControl = null;
}

function buildWorkbook() {
  return new ExcelJS.Workbook();
}

function joinList(values) {
  return (values || []).filter(Boolean).join("\n");
}

async function exportRowsToExcel(rows) {
  const workbook = buildWorkbook();
  workbook.creator = "Product Excel Exporter";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Products", {
    views: [{ state: "frozen", ySplit: 1 }]
  });

  worksheet.columns = [
    { header: "image", key: "image", width: ScraperUtils.pxToColumnWidth(MAX_IMAGE_WIDTH + 20) },
    { header: "title", key: "title", width: 36 },
    { header: "sku", key: "sku", width: 18 },
    { header: "original_price", key: "original_price", width: 16 },
    { header: "current_price", key: "current_price", width: 16 },
    { header: "product_url", key: "product_url", width: 48 },
    { header: "color_current", key: "color_current", width: 18 },
    { header: "color_options", key: "color_options", width: 28 },
    { header: "primary_image_url", key: "primary_image_url", width: 48 },
    { header: "main_image_urls", key: "main_image_urls", width: 56 },
    { header: "status", key: "status", width: 12 }
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.getRow(1).height = 24;
  worksheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };

  rows.forEach((row) => {
    worksheet.addRow({
      image: "",
      title: row.title || "",
      sku: row.sku || "",
      original_price: row.original_price || "",
      current_price: row.current_price || "",
      product_url: row.product_url || "",
      color_current: row.color_current || "",
      color_options: joinList(row.color_options).replace(/\n/g, ", "),
      primary_image_url: row.primary_image_url || "",
      main_image_urls: joinList(row.main_image_urls),
      status: row.status || "partial"
    });
  });

  for (let rowIndex = 2; rowIndex <= rows.length + 1; rowIndex += 1) {
    const row = rows[rowIndex - 2];
    const excelRow = worksheet.getRow(rowIndex);
    const urlCell = worksheet.getCell(`F${rowIndex}`);
    const primaryImageCell = worksheet.getCell(`I${rowIndex}`);
    const galleryCell = worksheet.getCell(`J${rowIndex}`);

    if (row.product_url) {
      urlCell.value = { text: row.product_url, hyperlink: row.product_url };
      urlCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
    if (row.primary_image_url) {
      primaryImageCell.value = { text: row.primary_image_url, hyperlink: row.primary_image_url };
      primaryImageCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
    if (row.main_image_urls?.length) {
      galleryCell.alignment = { wrapText: true, vertical: "top" };
    }

    if (row.imageEmbedded?.base64) {
      const imageId = workbook.addImage({
        base64: `data:image/png;base64,${row.imageEmbedded.base64}`,
        extension: row.imageEmbedded.extension || "png"
      });
      worksheet.addImage(imageId, {
        tl: { col: 0.15, row: rowIndex - 0.85 },
        ext: {
          width: row.imageEmbedded.width,
          height: row.imageEmbedded.height
        }
      });
      excelRow.height = ScraperUtils.pxToRowHeight(row.imageEmbedded.height + 12);
    } else {
      excelRow.height = 36;
    }
  }

  return workbook.xlsx.writeBuffer();
}

function toDownloadDataUrl(buffer) {
  const base64 = arrayBufferToBase64(buffer);
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${base64}`;
}

async function exportLatestRows() {
  const { rows } = await getStorageState();
  if (!rows.length) {
    throw new Error("No rows available for export.");
  }

  await patchState({
    phase: "exporting",
    running: true
  });

  const refreshedRows = await Promise.all(rows.map(async (row) => {
    if (row.imageEmbedded || !row.primary_image_url) {
      return row;
    }
    try {
      return {
        ...row,
        imageEmbedded: await fetchEmbeddedImage(row.primary_image_url)
      };
    } catch (error) {
      return row;
    }
  }));

  await setRows(refreshedRows);

  const buffer = await exportRowsToExcel(refreshedRows);
  const url = toDownloadDataUrl(buffer);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  await chrome.downloads.download({
    url,
    filename: `product-export-${timestamp}.xlsx`,
    saveAs: true
  });

  await patchState({
    running: false,
    paused: false,
    phase: "ready",
    exportedAt: new Date().toISOString(),
    summary: `Exported ${refreshedRows.length} products to Excel.`
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { state } = await getStorageState();
  if (!state || !state.phase) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.state]: getInitialState()
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) {
    return false;
  }

  if (message.type === "START_SCRAPE") {
    if (currentJobPromise) {
      sendResponse({ ok: false, error: "A scrape job is already running." });
      return false;
    }

    currentJobPromise = scrapeCurrentPage(message.tabId, message.sourceUrl)
      .catch(async (error) => {
        await patchState({
          running: false,
          phase: "error",
          error: error.message,
          summary: null,
          exportedAt: null
        });
      })
      .finally(() => {
        currentJobPromise = null;
      });
    sendResponse({ ok: true, accepted: true });
    return false;
  }

  if (message.type === "PAUSE_SCRAPE") {
    if (currentJobControl) {
      currentJobControl.paused = true;
      patchState({
        paused: true,
        running: true,
        phase: "paused",
        summary: "Scrape paused."
      }).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false, error: "No scrape job is running." });
    return false;
  }

  if (message.type === "RESUME_SCRAPE") {
    if (currentJobControl) {
      currentJobControl.paused = false;
      patchState({
        paused: false,
        running: true,
        phase: "extracting-details",
        summary: "Scrape resumed."
      }).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false, error: "No paused scrape job found." });
    return false;
  }

  if (message.type === "STOP_SCRAPE") {
    if (currentJobControl) {
      currentJobControl.cancelled = true;
      currentJobControl.paused = false;
      patchState({
        paused: false,
        running: true,
        phase: "stopping",
        summary: "Stopping after current work finishes..."
      }).then(() => sendResponse({ ok: true }));
      return true;
    }
    sendResponse({ ok: false, error: "No scrape job is running." });
    return false;
  }

  if (message.type === "EXPORT_EXCEL") {
    exportLatestRows()
      .catch(async (error) => {
        await patchState({
          running: false,
          phase: "error",
          error: error.message
        });
      });
    sendResponse({ ok: true, accepted: true });
    return false;
  }

  if (message.type === "GET_STATE") {
    getStorageState().then(({ state, rows }) => {
      sendResponse({
        ok: true,
        state,
        rows
      });
    });
    return true;
  }

  return false;
});
