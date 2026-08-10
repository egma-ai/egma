"""A live line, carried one slice at a time.

A media driver hands over a *stream*: audio arrives in whatever frames the
bridge or the room happens to carry it in, and goes out the same way. A
duplex line is driven in *slices*: the conductor gives it the persona's
audio for one moment and takes the far end's audio for that same moment,
the same number of samples each way. Turning the one into the other is the
same job for every plug over a live line, which is why it lives here
rather than in any one of them.

**Both directions cross in the same call, and neither waits for the
other.** The persona's slice is put on the wire and returned from at once;
whatever the far end said while it was speaking arrives on the next
slices and is handed up like any other audio. That is the whole point: a
line that waited out its own audio and threw away what arrived meanwhile
would be a line where the far end can only ever answer, never interrupt.

**Quiet is audio, and the waiting is the pacing.** A slice waits exactly
its own length for the far end's samples, and hands back quiet for
whatever has not arrived by then. So a live line runs at the speed the
audio really travels — no sleeps anywhere — and a fake one that answers
instantly costs a deterministic test nothing at all.
"""

from __future__ import annotations

from ..media import MediaSession
from ..speech import SAMPLE_WIDTH_BYTES


class MediaLine:
    """One media session, driven as a full-duplex line.

    Built once the far end is on the line and dropped when it goes. It
    holds whatever arrived beyond the slice it was asked for, because a
    bridge's frames are its own size and a slice is the conductor's.
    """

    def __init__(self, session: MediaSession, *, band_hz: int) -> None:
        self._session = session
        self._band_hz = band_hz
        self._heard = bytearray()

    @property
    def measured_band_hz(self) -> int | None:
        """The band the audio on this line really arrived at, or ``None``.

        Straight through from the session, because measuring is the
        driver's — it is the only layer that sees a frame before the line
        has cut it into slices of its own size.
        """
        return self._session.observed_band_hz

    @property
    def far_end_left(self) -> bool:
        """True once the far end is off the line **and** everything it said
        has been handed over.

        The second half is not pedantry: a bridge knows the leg is down as
        soon as the last frame leaves its own queue, which can be a slice
        or two before those samples reach the conductor. A line that
        reported itself down while still holding somebody's last words
        would end the exchange on words that never reached the record.
        """
        return self._session.far_end_left and not self._heard

    async def carry(self, outgoing: bytes) -> bytes:
        """One slice of the line: the persona's audio out, the far end's back.

        Answers with exactly as many samples as it was given, always —
        the count of samples that have crossed the line is the
        conversation's clock, so a slice that came back short would put
        the two speakers on two different clocks.
        """
        await self._session.send(outgoing)
        wanted = len(outgoing)
        # One slice's own length is the whole budget for waiting, so the
        # line advances at the rate audio really travels whether the far
        # end is talking or not.
        budget = wanted / SAMPLE_WIDTH_BYTES / self._band_hz
        while len(self._heard) < wanted:
            arrived = await self._session.receive(budget)
            if not arrived:
                # Nothing came within the slice, or the line is down.
                # Either way this moment carried no far-end voice, which
                # is quiet rather than nothing.
                break
            self._heard += arrived
        carried = bytes(self._heard[:wanted]).ljust(wanted, b"\x00")
        del self._heard[:wanted]
        return carried
