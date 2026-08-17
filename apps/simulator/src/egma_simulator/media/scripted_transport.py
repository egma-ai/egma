"""A deterministic Pipecat transport for local voice simulations.

This is a transport fixture, not a second voice conductor. It produces and
consumes ordinary Pipecat audio frames at the rates in the pipeline start
frame. Input stays active while model and speech processors work because
Pipecat carries input audio as system frames.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from ..speech import decode_speech, encode_speech, silence
from . import VoiceMedia

FRAME_SECONDS = 0.02
TRAILING_SILENCE_SECONDS = 0.6
HANGUP_SILENCE_SECONDS = 0.1
OPENING_SILENCE_SECONDS = 11.0
IDLE_SILENCE_SECONDS = 13.0


@dataclass(frozen=True)
class _InputChunk:
    audio: bytes
    hang_up_after: bool = False


class ScriptedTransport:
    """One scripted far end expressed as Pipecat transport processors."""

    def __init__(
        self,
        *,
        greeting: str | None,
        replies: list[str],
        answer_delay_seconds: float,
        ends_after_replies: bool,
        fallback_reply: str | None = None,
        echoes_what_it_hears: bool = False,
        hangup_silence_seconds: float = HANGUP_SILENCE_SECONDS,
    ) -> None:
        self._greeting = greeting
        self._replies = list(replies)
        self._delay = answer_delay_seconds
        self._ends_after_replies = ends_after_replies
        self._fallback_reply = fallback_reply
        self._echoes = echoes_what_it_hears
        self._hangup_silence_seconds = hangup_silence_seconds
        self._delivered = 0

        self._input_rate = 0
        self._output_rate = 0
        self._rates_ready = asyncio.Event()
        self._active = asyncio.Event()
        self._pending: asyncio.Queue[_InputChunk] = asyncio.Queue()
        self._acks: dict[int, asyncio.Event] = {}
        self.ended = asyncio.Event()

        self.heard: list[bytes] = []
        """Each complete persona utterance accepted by the transport."""
        self.input_frames = 0
        """How many incoming media frames entered the pipeline."""
        self._hearing = bytearray()

        self._input = _ScriptedInput(self)
        self._output = _ScriptedOutput(self)

    @property
    def media(self) -> VoiceMedia:
        return VoiceMedia(
            input=(self._input,),
            output=(self._output,),
            ended=self.ended,
            input_recorded=self.acknowledge,
        )

    async def activate(self) -> None:
        """Let the far end enter the already-running pipeline."""
        self._active.set()
        await self._rates_ready.wait()
        if self._greeting is None:
            self._queue_audio(silence(OPENING_SILENCE_SECONDS, self._input_rate))
            return
        self._queue_words(
            self._greeting,
            hang_up_after=self._ends_after_replies and not self._replies,
        )

    def started(
        self,
        *,
        input_rate: int | None = None,
        output_rate: int | None = None,
    ) -> None:
        if input_rate is not None:
            self._input_rate = input_rate
        if output_rate is not None:
            self._output_rate = output_rate
        if self._input_rate and self._output_rate:
            self._rates_ready.set()

    async def next_input(self) -> _InputChunk:
        await self._active.wait()
        return await self._pending.get()

    def wait_for_ack(self, frame: InputAudioRawFrame) -> asyncio.Event:
        acknowledged = asyncio.Event()
        self._acks[frame.id] = acknowledged
        return acknowledged

    def acknowledge(self, frame: InputAudioRawFrame) -> None:
        acknowledged = self._acks.pop(frame.id, None)
        if acknowledged is not None:
            acknowledged.set()

    async def accepted_output(self, frame: OutputAudioRawFrame) -> None:
        self._hearing.extend(frame.audio)

    def carry_output_time(self, frame: OutputAudioRawFrame) -> None:
        """Carry far-end quiet while Pipecat accepts persona output."""
        seconds = frame.num_frames / frame.sample_rate
        self._queue_audio(silence(seconds, self._input_rate))

    async def persona_stopped(self) -> None:
        spoken = bytes(self._hearing)
        self._hearing.clear()
        if spoken:
            self.heard.append(spoken)

        position = self._delivered
        self._delivered += 1
        if self._echoes and spoken:
            words = decode_speech(spoken, self._output_rate)
            self._queue_words(words)
            return
        if position < len(self._replies):
            self._queue_words(
                self._replies[position],
                hang_up_after=(
                    self._ends_after_replies and position == len(self._replies) - 1
                ),
            )
            return
        if self._ends_after_replies:
            self.ended.set()
            return
        if self._fallback_reply is not None:
            self._queue_words(self._fallback_reply)
            return
        self._queue_audio(silence(IDLE_SILENCE_SECONDS, self._input_rate))

    def stop(self) -> None:
        self.ended.set()

    def _queue_words(self, words: str, *, hang_up_after: bool = False) -> None:
        trailing = (
            self._hangup_silence_seconds
            if hang_up_after
            else TRAILING_SILENCE_SECONDS
        )
        audio = (
            silence(self._delay, self._input_rate)
            + encode_speech(words, self._input_rate)
            + silence(trailing, self._input_rate)
        )
        self._queue_audio(audio, hang_up_after=hang_up_after)

    def _queue_audio(
        self,
        audio: bytes,
        *,
        hang_up_after: bool = False,
    ) -> None:
        frame_bytes = max(2, round(FRAME_SECONDS * self._input_rate) * 2)
        pieces = [
            audio[offset : offset + frame_bytes]
            for offset in range(0, len(audio), frame_bytes)
        ]
        if not pieces and hang_up_after:
            self.ended.set()
            return
        for position, piece in enumerate(pieces):
            self._pending.put_nowait(
                _InputChunk(
                    audio=piece,
                    hang_up_after=hang_up_after and position == len(pieces) - 1,
                )
            )


class _ScriptedInput(FrameProcessor):
    def __init__(self, transport: ScriptedTransport) -> None:
        super().__init__()
        self._transport = transport
        self._pump: asyncio.Task | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self._transport.started(input_rate=frame.audio_in_sample_rate)
            self._pump = self.create_task(self._run(), name="scripted-input")
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self._transport.stop()
            if self._pump is not None and not self._pump.done():
                self._pump.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._pump

    async def _run(self) -> None:
        while True:
            chunk = await self._transport.next_input()
            frame = InputAudioRawFrame(
                audio=chunk.audio,
                sample_rate=self._transport._input_rate,
                num_channels=1,
            )
            acknowledged = self._transport.wait_for_ack(frame)
            self._transport.input_frames += 1
            await self.push_frame(frame)
            await acknowledged.wait()
            if chunk.hang_up_after:
                # Participant departure follows the final accepted media,
                # which is the ordering a live room exposes to the pipeline.
                self._transport.stop()
                return


class _ScriptedOutput(FrameProcessor):
    def __init__(self, transport: ScriptedTransport) -> None:
        super().__init__()
        self._transport = transport

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self._transport.started(output_rate=frame.audio_out_sample_rate)
        elif isinstance(frame, OutputAudioRawFrame):
            await self._transport.accepted_output(frame)

        await self.push_frame(frame, direction)

        if isinstance(frame, OutputAudioRawFrame):
            self._transport.carry_output_time(frame)
        elif isinstance(frame, TTSStoppedFrame):
            await self._transport.persona_stopped()
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self._transport.stop()
