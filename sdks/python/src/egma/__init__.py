"""Egma inside a LiveKit agent for simulations and production monitoring.

A **mock tool** answers for one of your agent's tools during a
simulation, so a test never books the real appointment, sends the real
SMS or charges the real card — and so a test can order up the branch it
needs: an empty calendar, a booking that errors, a lookup that takes
three seconds.

This package is the piece that lives in *your* process. One call, after
the agent is built and before the session starts::

    from egma import mockable

    await mockable(agent, ctx, session)

In a room egma did not name — every production room — it returns having
touched nothing. Your tools are the same objects, called the same way,
with no wrapper between them and the model. That is a test in this
package, not a promise in this docstring.

Production monitoring is a separate explicit call made before the session
starts::

    from egma import monitor_livekit

    monitor_livekit(ctx)

See ``README.md`` for both integrations.
"""

from .mockable import mockable
from .monitoring import monitor_livekit

__all__ = ["mockable", "monitor_livekit"]
