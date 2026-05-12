(function contentScriptBootstrap(root) {
  if (root.__productExporterContentInitialized) {
    return;
  }
  root.__productExporterContentInitialized = true;

  const extractors = root.ProductExtractors;
  const adapters = root.ProductAdapters;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    try {
      if (message.type === "SCRAPE_LIST") {
        const adapter = adapters.getAdapter(window.location.hostname);
        sendResponse({
          ok: true,
          adapterName: adapter.name,
          items: extractors.extractList(document)
        });
        return false;
      }

      if (message.type === "SCRAPE_DETAIL") {
        const adapter = adapters.getAdapter(window.location.hostname);
        sendResponse({
          ok: true,
          adapterName: adapter.name,
          detail: extractors.extractDetail(document)
        });
        return false;
      }
    } catch (error) {
      sendResponse({
        ok: false,
        error: error.message
      });
      return false;
    }

    return false;
  });
})(typeof self !== "undefined" ? self : globalThis);
