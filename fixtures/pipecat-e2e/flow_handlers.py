"""The Python behind flow.yaml: Flows direct functions, one per tool it names."""

from __future__ import annotations

from pipecat.flows import TRANSITION_IN_YAML, FlowManager

import store


async def check_store_hours(flow_manager: FlowManager, day: str):
    """Look up when the store is open on one day of the week.

    Args:
        day: The day of the week the caller asks about, for example "Saturday".
    """
    return store.check_store_hours(day), TRANSITION_IN_YAML


async def begin_return(flow_manager: FlowManager, item: str):
    """Start a return for an item the caller bought.

    Args:
        item: The item the caller wants to return.
    """
    store.log_real_tool("begin_return", {"item": item}, {"started": True})
    return {"started": True, "item": item}, TRANSITION_IN_YAML


async def record_return(flow_manager: FlowManager, order_id: str, reason: str):
    """Record a return and create its return label.

    Args:
        order_id: The order number the item came from, for example "A100".
        reason: Why the caller is returning the item.
    """
    return store.record_return(order_id, reason), TRANSITION_IN_YAML
