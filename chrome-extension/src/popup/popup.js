const stateElements = {
  adapterText: document.getElementById("adapter-text"),
  details: document.getElementById("metric-details"),
  exportButton: document.getElementById("export-button"),
  exportedText: document.getElementById("exported-text"),
  failed: document.getElementById("metric-failed"),
  host: document.getElementById("site-host"),
  images: document.getElementById("metric-images"),
  startButton: document.getElementById("start-button"),
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  summaryText: document.getElementById("summary-text"),
  toggleButton: document.getElementById("toggle-button"),
  total: document.getElementById("metric-total")
};

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

function phaseLabel(phase) {
  switch (phase) {
    case "extracting-list":
      return "Scanning list page";
    case "extracting-details":
      return "Collecting detail pages";
    case "downloading-images":
      return "Caching images";
    case "paused":
      return "Paused";
    case "stopping":
      return "Stopping";
    case "exporting":
      return "Exporting workbook";
    case "ready":
      return "Ready to export";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function renderState(state, activeTab) {
  stateElements.host.textContent = activeTab?.url ? new URL(activeTab.url).hostname : "No active tab";
  stateElements.statusText.textContent = phaseLabel(state.phase);
  stateElements.summaryText.textContent = state.error || state.summary || "Ready to scan the current product page.";
  stateElements.total.textContent = String(state.totalProducts || 0);
  stateElements.details.textContent = String(state.detailCompleted || 0);
  stateElements.images.textContent = String(state.imageCompleted || 0);
  stateElements.failed.textContent = String(state.failedCount || 0);
  stateElements.adapterText.textContent = `Adapter: ${state.adapterName || "generic"}`;
  stateElements.exportedText.textContent = `Last export: ${state.exportedAt ? new Date(state.exportedAt).toLocaleString() : "not yet"}`;

  stateElements.statusDot.className = "status-dot";
  if (state.phase === "ready") {
    stateElements.statusDot.classList.add("ready");
  } else if (state.phase === "error") {
    stateElements.statusDot.classList.add("error");
  } else if (state.running) {
    stateElements.statusDot.classList.add("running");
  }

  stateElements.startButton.textContent = state.running ? "Stop Scrape" : "Start Scrape";
  stateElements.startButton.disabled = !activeTab?.id;
  stateElements.toggleButton.disabled = !state.running;
  stateElements.toggleButton.textContent = state.paused ? "Resume" : "Pause";
  stateElements.exportButton.disabled = state.running || !state.totalProducts;
}

async function refresh() {
  const activeTab = await getActiveTab();
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  renderState(response?.state || {}, activeTab);
}

async function startScrape() {
  const activeTab = await getActiveTab();
  if (!activeTab?.id || !activeTab.url) {
    return;
  }

  stateElements.startButton.disabled = true;
  await chrome.runtime.sendMessage({
    type: "START_SCRAPE",
    tabId: activeTab.id,
    sourceUrl: activeTab.url
  });
  await refresh();
}

async function togglePauseResume() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  const state = response?.state || {};
  const type = state.paused ? "RESUME_SCRAPE" : "PAUSE_SCRAPE";
  await chrome.runtime.sendMessage({ type });
  await refresh();
}

async function stopScrape() {
  await chrome.runtime.sendMessage({ type: "STOP_SCRAPE" });
  await refresh();
}

async function exportExcel() {
  stateElements.exportButton.disabled = true;
  await chrome.runtime.sendMessage({ type: "EXPORT_EXCEL" });
  await refresh();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.scrapeState) {
    refresh().catch(() => {});
  }
});

stateElements.startButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "GET_STATE" }).then((response) => {
    const state = response?.state || {};
    return state.running ? stopScrape() : startScrape();
  }).catch((error) => {
    stateElements.summaryText.textContent = error.message;
  });
});

stateElements.toggleButton.addEventListener("click", () => {
  togglePauseResume().catch((error) => {
    stateElements.summaryText.textContent = error.message;
  });
});

stateElements.exportButton.addEventListener("click", () => {
  exportExcel().catch((error) => {
    stateElements.summaryText.textContent = error.message;
  });
});

refresh().catch((error) => {
  stateElements.summaryText.textContent = error.message;
});
