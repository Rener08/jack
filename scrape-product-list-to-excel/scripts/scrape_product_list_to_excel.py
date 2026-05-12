#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import re
from io import BytesIO
from pathlib import Path
from urllib.parse import urljoin

import requests
import xlsxwriter
from PIL import Image as PILImage
from playwright.async_api import async_playwright


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scrape product listing pages into an Excel workbook with embedded images."
    )
    parser.add_argument("--list-url", required=True, help="Category or listing page URL")
    parser.add_argument("--output", default="products.xlsx", help="Output xlsx file")
    parser.add_argument(
        "--headless",
        action="store_true",
        help="Run the browser headless. Leave off when a site blocks headless mode.",
    )
    parser.add_argument(
        "--max-items",
        type=int,
        default=0,
        help="Limit the number of products to export (0 = no limit).",
    )
    parser.add_argument(
        "--wait-ms",
        type=int,
        default=6000,
        help="Wait time after loading listing/detail pages.",
    )
    return parser.parse_args()


async def collect_products(list_url: str, headless: bool, wait_ms: int, max_items: int):
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        page = await browser.new_page(locale="ja-JP", viewport={"width": 1440, "height": 1600})
        await page.goto(list_url, wait_until="domcontentloaded", timeout=120000)
        await page.wait_for_timeout(wait_ms)

        links = []
        seen = set()
        locator = page.locator('a[href*="/product/"]')
        count = await locator.count()
        for i in range(count):
            item = locator.nth(i)
            text = clean_text(await item.text_content() or "")
            href = await item.get_attribute("href")
            if not href or not text or text.startswith("+"):
                continue
            href = urljoin(list_url, href)
            if href in seen:
                continue
            seen.add(href)
            links.append({"title_hint": text, "url": href})

        if max_items and max_items > 0:
            links = links[:max_items]

        detail = await browser.new_page(locale="ja-JP", viewport={"width": 1440, "height": 1600})
        try:
            for product in links:
                for attempt in range(2):
                    try:
                        await detail.goto(product["url"], wait_until="domcontentloaded", timeout=120000)
                        await detail.wait_for_timeout(wait_ms)

                        h1 = clean_text(await detail.locator("h1").first.text_content() or "")
                        if h1:
                            product["title"] = h1
                        else:
                            product["title"] = clean_text(product["title_hint"])

                        body = clean_text(await detail.text_content("body") or "")
                        price_match = re.search(r"¥\s*[0-9,]+", body)
                        product["price"] = price_match.group(0) if price_match else ""

                        image_url = ""
                        img_count = await detail.locator("img").count()
                        for i in range(img_count):
                            img = detail.locator("img").nth(i)
                            current_src = await img.evaluate("(e) => e.currentSrc || ''")
                            if current_src and "/hi-res/" in current_src:
                                image_url = current_src
                                break
                            if current_src.startswith("https://edge.dis.commercecloud.salesforce.com/dw/image"):
                                image_url = current_src
                                break

                        if not image_url:
                            image_url = await detail.locator("img").first.evaluate("(e) => e.currentSrc || ''")

                        product["image_url"] = image_url
                        break
                    except Exception:
                        if attempt == 1:
                            product["image_url"] = product.get("image_url", "")
                            product["title"] = product.get("title", clean_text(product["title_hint"]))
                            product["price"] = product.get("price", "")
        finally:
            await detail.close()
            await browser.close()

        return links


def add_image(workbook, ws, row_idx: int, image_url: str, session: requests.Session):
    if not image_url:
        ws.write(row_idx, 3, "")
        return

    try:
        resp = session.get(image_url, timeout=60)
        resp.raise_for_status()
        pil = PILImage.open(BytesIO(resp.content)).convert("RGB")
        pil.thumbnail((140, 140))
        bio = BytesIO()
        pil.save(bio, format="PNG")
        bio.seek(0)
        ws.insert_image(row_idx, 3, "image.png", {"image_data": bio, "x_offset": 4, "y_offset": 4})
    except Exception as exc:
        ws.write(row_idx, 3, f"图片抓取失败: {exc}")


def write_workbook(products, output_path: Path):
    workbook = xlsxwriter.Workbook(str(output_path))
    ws = workbook.add_worksheet("Products")

    header_fmt = workbook.add_format(
        {"bold": True, "align": "center", "valign": "vcenter", "bg_color": "#D9EAD3", "border": 1}
    )
    body_fmt = workbook.add_format({"valign": "top", "text_wrap": True, "border": 1})
    link_fmt = workbook.add_format(
        {"font_color": "blue", "underline": 1, "valign": "top", "text_wrap": True, "border": 1}
    )

    headers = ["标题", "价格", "链接", "主图"]
    for col, header in enumerate(headers):
        ws.write(0, col, header, header_fmt)

    ws.set_column("A:A", 42)
    ws.set_column("B:B", 12)
    ws.set_column("C:C", 80)
    ws.set_column("D:D", 18)

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept-Language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
        }
    )

    for idx, product in enumerate(products, start=1):
        ws.set_row(idx, 110)
        ws.write(idx, 0, product.get("title", ""), body_fmt)
        ws.write(idx, 1, product.get("price", ""), body_fmt)
        url = product.get("url", "")
        ws.write_url(idx, 2, url, link_fmt, string=url)
        add_image(workbook, ws, idx, product.get("image_url", ""), session)

    workbook.close()


async def main():
    args = parse_args()
    products = await collect_products(args.list_url, args.headless, args.wait_ms, args.max_items)
    write_workbook(products, Path(args.output))
    print(f"scraped {len(products)} products")
    print(f"saved {Path(args.output).resolve()}")


if __name__ == "__main__":
    asyncio.run(main())
