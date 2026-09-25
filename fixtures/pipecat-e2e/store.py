"""The shop behind the bot's tools: fixed answers, no clock, no network, no disk.

Every real tool run logs one `E2E_REAL_TOOL` line, so a proof can tell a tool
the bot ran from one Egma answered with a mock.
"""

from __future__ import annotations

import json

from loguru import logger

SHOP_NAME = "Maple Street Hardware"

ORDERS = {
    "A100": {"status": "shipped", "carrier": "UPS", "arrives": "Thursday"},
    "B200": {"status": "processing", "carrier": None, "arrives": "next week"},
    "C300": {"status": "delivered", "carrier": "USPS", "arrives": "already delivered on Monday"},
}

HOURS = {
    "monday": "8 AM to 6 PM",
    "tuesday": "8 AM to 6 PM",
    "wednesday": "8 AM to 6 PM",
    "thursday": "8 AM to 8 PM",
    "friday": "8 AM to 8 PM",
    "saturday": "9 AM to 5 PM",
    "sunday": "closed",
}


def log_real_tool(name: str, arguments: dict, result: object) -> None:
    logger.info(
        "E2E_REAL_TOOL "
        + json.dumps({"tool": name, "arguments": arguments, "result": result}, sort_keys=True)
    )


def lookup_order(order_id: str) -> dict:
    key = order_id.strip().upper().replace(" ", "").replace("-", "")
    order = ORDERS.get(key)
    result = {"order_id": key, "found": False} if order is None else {"order_id": key, **order}
    if order is not None:
        result["found"] = True
    log_real_tool("lookup_order", {"order_id": order_id}, result)
    return result


def check_store_hours(day: str) -> dict:
    key = day.strip().lower()
    hours = HOURS.get(key)
    result = {"day": key, "hours": hours if hours is not None else "unknown day"}
    log_real_tool("check_store_hours", {"day": day}, result)
    return result


def record_return(order_id: str, reason: str) -> dict:
    key = order_id.strip().upper()
    result = {"order_id": key, "return_label": "RET-" + key}
    log_real_tool("record_return", {"order_id": order_id, "reason": reason}, result)
    return result
