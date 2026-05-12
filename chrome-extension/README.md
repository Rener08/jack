# Product Excel Exporter

Chrome extension that scrapes product information from the current list page, opens detail pages in the background, caches one main image per row, and exports a `.xlsx` workbook with embedded images.

## Load in Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select the `chrome-extension` folder.

## What it exports

- Embedded main image
- Title
- SKU
- Original price
- Current price
- Product URL
- Current color
- Color options
- Primary image URL
- All main image URLs
- Status

## Local verification

```bash
npm test
```
