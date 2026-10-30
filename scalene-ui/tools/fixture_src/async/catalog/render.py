"""Response rendering: JSON bodies and the HTML search page."""
import html
from typing import Dict, List, Mapping

import orjson

CURRENCY = "EUR"


def _money(value: float) -> str:
    return f"{value:,.2f} {CURRENCY}"


def _stars(rating: float) -> str:
    full = int(rating)
    half = 1 if rating - full >= 0.5 else 0
    return "&#9733;" * full + ("&#189;" if half else "") + "&#9734;" * (5 - full - half)


def render_product(row: Mapping[str, object], price: float) -> bytes:
    doc = {
        "id": row["id"],
        "sku": row["sku"],
        "title": row["title"],
        "description": row["description"],
        "category": row["category_id"],
        "in_stock": int(row["stock"]) > 0,
        "rating": row["rating"],
        "price": {"amount": round(price, 2), "currency": CURRENCY, "display": _money(price)},
        "images": [row["image_url"], str(row["image_url"]).replace(".jpg", "@2x.jpg")],
    }
    return orjson.dumps(doc, option=orjson.OPT_NON_STR_KEYS)


def _card(row: Mapping[str, object], price: float) -> str:
    title = html.escape(str(row["title"]))
    desc = html.escape(str(row["description"])[:180])
    return (
        f'<li class="card" data-id="{row["id"]}">'
        f'<img src="{row["image_url"]}" alt="{title}" loading="lazy">'
        f"<h3>{title}</h3><p>{desc}</p>"
        f'<span class="price">{_money(price)}</span>'
        f'<span class="stars">{_stars(float(row["rating"]))}</span></li>'
    )


def render_search_page(query: str, rows: List[Mapping[str, object]], prices: Dict[int, float]) -> bytes:
    parts = [
        "<!doctype html><html><head><meta charset='utf-8'>",
        f"<title>Search: {html.escape(query)}</title></head><body>",
        f"<h1>{len(rows)} results for &ldquo;{html.escape(query)}&rdquo;</h1><ul class='grid'>",
    ]
    for row in rows:
        parts.append(_card(row, prices.get(int(row["id"]), 0.0)))
    parts.append("</ul></body></html>")
    return "".join(parts).encode("utf-8")
