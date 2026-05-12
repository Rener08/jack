---
name: scrape-product-list-to-excel
description: Scrape ecommerce category or product-list pages, follow product links, extract title, price, URL, and main image, then export a formatted Excel workbook with embedded images. Use when the user asks to crawl a shopping page, collect product data, or generate an XLSX catalog from a listing page.
---

# Scrape Product List to Excel

## What This Skill Does

Use this skill when a user wants a product listing or category page turned into an Excel file with:

- title
- price
- link
- main image embedded in the sheet

The default implementation is the bundled script in `scripts/scrape_product_list_to_excel.py`.

## Workflow

1. Open the listing page in a real browser context if the site blocks headless requests.
2. Collect product links from the listing page.
3. Visit each product page and extract:
   - page title from the main `h1`
   - price from visible page text
   - canonical or resolved product URL
   - primary image from `img.currentSrc` or a hi-res gallery image
4. Download images, resize them to fit the sheet, and embed them in the Excel file.
5. Write a clean workbook with one row per product.

## Practical Rules

- Prefer browser-rendered pages over plain `requests` when the site uses dynamic content or anti-bot failover.
- Normalize relative links to absolute URLs before visiting detail pages.
- If the image cannot be downloaded, still keep the text row and preserve the product link.
- If the page has duplicate cards or variant links, keep the first unique product URL.
- Keep the workbook simple: one sheet, clear headers, hyperlink on the URL column, and fixed column widths.

## Expected Output

The result should be an `.xlsx` file containing:

- `title`
- `price`
- `link`
- `main image`

Each row should represent one product, and the image should appear inside the last column cell.

## When To Use The Script

Use `scripts/scrape_product_list_to_excel.py` when the task is a one-off scrape or when you want a repeatable extraction pipeline for similar ecommerce pages.
