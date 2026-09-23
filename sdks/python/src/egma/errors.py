"""Errors shared by every framework integration."""

from __future__ import annotations


class NotReported(RuntimeError):
    """Reporting failed in a simulation; do not start the agent.

    Raised by ``simulation`` when the hello exchange with Egma cannot
    complete. Never raised outside a simulation.
    """
