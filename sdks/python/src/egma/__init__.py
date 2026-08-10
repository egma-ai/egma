"""egma inside your agent: your tools, answered by egma while a test runs.

A **mock tool** answers for one of your agent's tools during a
simulation, so a test never books the real appointment, sends the real
SMS or charges the real card — and so a test can order up the branch it
needs: an empty calendar, a booking that errors, a lookup that takes
three seconds.

This package is the piece that lives in *your* process. One call, after
the agent is built and before the session starts::

    from egma import mockable

    await mockable(agent, ctx, session)

In a room with no egma participant — every production room — it returns
having touched nothing. Your tools are the same objects, called the same
way, with no wrapper between them and the model. That is a test in this
package, not a promise in this docstring.

See ``README.md`` for the whole integration, and :func:`egma.mockable`
for what happens on each call.
"""

from .mockable import mockable

# One verb, and deliberately only one. Everything else here — the wire's
# constants, its shapes, its error codes — is this package's own business
# and stays out of the surface a customer's agent binds itself to.
__all__ = ["mockable"]
