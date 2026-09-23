"""Write the bot's own record of a conversation from Pipecat's frames.

A pipeline observer sees every frame one processor pushes to the next. It
turns them into the ``egma.pipecat`` spans egma reads as the agent's POV:

- ``pipecat_session``: the root, the whole bot run.
- ``user_turn``: what the user said, from the first speech or text to the
  moment the turn is committed. Voice text is the final transcripts; chat
  text is the user message the bot was sent.
- ``agent_turn``: one LLM response, from its start to its last output,
  with the text the LLM wrote and ``egma.turn.interrupted`` when it was cut.
- ``function_call``: one tool call, from the moment it runs to its result,
  with its name, arguments, and result or error.
- ``user_speaking`` / ``agent_speaking``: when each side's audio ran.

Each span is created with the times the frames were pushed, read off the
pipeline clock, so the record is exact even though observers run behind the
pipeline. A user turn is written once it is committed and holds text; a
voice activity burst that never became a turn leaves no span. An agent turn
is ended when the next turn begins or the session ends.

Nothing here raises into Pipecat: an observer that raises stops receiving
frames, so every failure is logged and swallowed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import OrderedDict
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from opentelemetry import trace
from opentelemetry.trace import Span, Status, StatusCode
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    FunctionCallCancelFrame,
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
    FunctionCallsStartedFrame,
    InterimTranscriptionFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    LLMSetToolsFrame,
    LLMTextFrame,
    StartFrame,
    StopFrame,
    TranscriptionFrame,
    TTSTextFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.processors.frame_processor import FrameDirection

from .export import ROOT_SPAN

logger = logging.getLogger("egma")

USER_TURN = "user_turn"
AGENT_TURN = "agent_turn"
FUNCTION_CALL = "function_call"
USER_SPEAKING = "user_speaking"
AGENT_SPEAKING = "agent_speaking"

TURN_TEXT = "egma.turn.text"
TURN_INTERRUPTED = "egma.turn.interrupted"
TOOL_NAME = "egma.tool.name"
TOOL_CALL_ID = "egma.tool.call_id"
TOOL_ARGUMENTS = "egma.tool.arguments"
TOOL_RESULT = "egma.tool.result"
TOOL_ERROR = "egma.tool.error"
PIPECAT_VERSION = "egma.pipecat.version"
PIPECAT_TRANSPORT = "egma.pipecat.transport"

CANCELLED = "the call was cancelled before it returned a result"
UNFINISHED = "the bot session ended before the call returned a result"

_REMEMBERED_FRAMES = 20_000
"""How many frame ids are kept to tell a frame's first push from its later hops."""


def _pipecat_version() -> str:
    try:
        return version("pipecat-ai")
    except PackageNotFoundError:
        return "unknown"


def _json(value: Any) -> str:
    return json.dumps(value, default=str, ensure_ascii=False)


def _message_text(content: Any) -> str:
    """The text of an LLM message's content: a string or a list of parts."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, Mapping) and part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return " ".join(parts)
    return ""


class _Text:
    """Streamed text, joined the way Pipecat joins it."""

    def __init__(self) -> None:
        self._parts: list[str] = []

    def add(self, text: str, spaced: bool) -> None:
        if not text:
            return
        if spaced or not self._parts:
            self._parts.append(text)
        else:
            self._parts.append(" " + text.lstrip())

    def value(self) -> str:
        return " ".join("".join(self._parts).split())


@dataclass
class _HumanTurn:
    started_at: int
    last_at: int
    text: list[str] = field(default_factory=list)
    speech: list[tuple[int, int]] = field(default_factory=list)
    speech_open_at: int | None = None
    committed_at: int | None = None


@dataclass
class _AgentTurn:
    span: Span
    ended_at: int
    text: _Text = field(default_factory=_Text)
    spoken_text: _Text = field(default_factory=_Text)
    responding: bool = True
    speaking_since: int | None = None
    awaiting_speech: bool = False
    superseded: bool = False
    interrupted: bool = False
    closed: bool = False


class Recorder:
    """Turns conversation events, with their times, into spans."""

    def __init__(
        self,
        tracer: Callable[[], trace.Tracer],
        failures: dict[str, str],
        transport: str,
    ) -> None:
        self._tracer = tracer
        self._failures = failures
        self._transport = transport
        self._root: Span | None = None
        self._human: _HumanTurn | None = None
        self._agents: list[_AgentTurn] = []
        self._requested_by: dict[str, _AgentTurn] = {}
        self._calls: dict[str, Span] = {}
        self.finished = False

    @property
    def started(self) -> bool:
        return self._root is not None

    # --- spans ---------------------------------------------------------

    def _span(
        self,
        name: str,
        at: int,
        parent: Span | None,
        attributes: dict[str, Any] | None = None,
    ) -> Span:
        # Always an explicit parent, so a customer's own current span never
        # adopts egma's spans.
        context = trace.set_span_in_context(
            parent if parent is not None else trace.INVALID_SPAN
        )
        return self._tracer().start_span(
            name, context=context, start_time=at, attributes=attributes or {}
        )

    def start(self, at: int) -> Span:
        if self._root is None:
            attributes = {PIPECAT_VERSION: _pipecat_version()}
            if self._transport:
                attributes[PIPECAT_TRANSPORT] = self._transport
            # The root has no parent, even inside a customer's own span.
            self._root = self._tracer().start_span(
                ROOT_SPAN,
                context=trace.set_span_in_context(trace.INVALID_SPAN),
                start_time=at,
                attributes=attributes,
            )
        return self._root

    # --- the user ------------------------------------------------------

    def _human_at(self, at: int) -> _HumanTurn:
        """The human turn in progress, opening one where none is."""
        if self._human is not None and self._human.committed_at is not None:
            self._write_human()
        if self._human is None:
            self._human = _HumanTurn(started_at=at, last_at=at)
        return self._human

    def user_speech_started(self, at: int) -> None:
        human = self._human_at(at)
        if human.speech_open_at is None:
            human.speech_open_at = at

    def user_speech_stopped(self, at: int) -> None:
        human = self._human
        if human is None or human.speech_open_at is None:
            return
        human.speech.append((human.speech_open_at, at))
        human.speech_open_at = None
        human.last_at = max(human.last_at, at)

    def user_turn_started(self, at: int) -> None:
        self._human_at(at)

    def user_turn_stopped(self, at: int) -> None:
        if self._human is not None and self._human.committed_at is None:
            self._human.committed_at = at

    def transcript(self, at: int, text: str, final: bool) -> None:
        if self._human is None:
            self._human = _HumanTurn(started_at=at, last_at=at)
        if final and text.strip():
            self._human.text.append(text.strip())
            self._human.last_at = max(self._human.last_at, at)

    def user_text(self, at: int, text: str) -> None:
        """A user message the bot was sent as text: a turn with no duration."""
        self._write_human()
        self._supersede_agents()
        span = self._span(USER_TURN, at, self.start(at), {TURN_TEXT: text})
        span.end(end_time=at)

    def _write_human(self) -> None:
        human, self._human = self._human, None
        if human is None:
            return
        text = " ".join(human.text).strip()
        if not text:
            return
        ended_at = human.committed_at
        if ended_at is None:
            ended_at = max([human.last_at, *(end for _, end in human.speech)])
        self._supersede_agents()
        span = self._span(USER_TURN, human.started_at, self.start(human.started_at))
        span.set_attribute(TURN_TEXT, text)
        speech = list(human.speech)
        if human.speech_open_at is not None:
            speech.append((human.speech_open_at, max(ended_at, human.speech_open_at)))
        for started_at, stopped_at in speech:
            spoke = self._span(USER_SPEAKING, started_at, span)
            spoke.end(end_time=stopped_at)
        span.end(end_time=max(ended_at, human.started_at))

    # --- the agent -----------------------------------------------------

    def _supersede_agents(self) -> None:
        for turn in self._agents:
            turn.superseded = True
            self._close_if_done(turn)

    def _open_agent(self, at: int) -> _AgentTurn:
        self._write_human()
        self._supersede_agents()
        turn = _AgentTurn(span=self._span(AGENT_TURN, at, self.start(at)), ended_at=at)
        self._agents.append(turn)
        return turn

    def _responding(self) -> _AgentTurn | None:
        for turn in reversed(self._agents):
            if turn.responding and not turn.closed:
                return turn
        return None

    def response_started(self, at: int) -> None:
        self._open_agent(at)

    def response_text(self, at: int, text: str, spaced: bool, spoken: bool) -> None:
        turn = self._responding() or self._open_agent(at)
        turn.text.add(text, spaced)
        turn.ended_at = max(turn.ended_at, at)
        if spoken and turn.speaking_since is None and not turn.spoken_text.value():
            turn.awaiting_speech = True

    def response_ended(self, at: int) -> None:
        turn = self._responding()
        if turn is None:
            return
        turn.responding = False
        turn.ended_at = max(turn.ended_at, at)
        self._close_if_done(turn)

    def _speaker(self) -> _AgentTurn | None:
        for turn in self._agents:
            if turn.speaking_since is not None and not turn.closed:
                return turn
        return None

    def bot_speech_started(self, at: int) -> None:
        if self._speaker() is not None:
            return
        turn = next(
            (t for t in self._agents if t.awaiting_speech and not t.closed), None
        )
        if turn is None:
            turn = next((t for t in reversed(self._agents) if not t.closed), None)
        if turn is None:
            # Speech with no LLM response, such as a fixed greeting.
            turn = self._open_agent(at)
            turn.responding = False
        turn.awaiting_speech = False
        turn.speaking_since = at

    def spoken_text(self, at: int, text: str, spaced: bool) -> None:
        turn = self._speaker() or next(
            (t for t in reversed(self._agents) if not t.closed), None
        )
        if turn is not None:
            turn.spoken_text.add(text, spaced)

    def bot_speech_stopped(self, at: int) -> None:
        turn = self._speaker()
        if turn is None or turn.speaking_since is None:
            return
        spoke = self._span(AGENT_SPEAKING, turn.speaking_since, turn.span)
        spoke.end(end_time=max(at, turn.speaking_since))
        turn.speaking_since = None
        turn.ended_at = max(turn.ended_at, at)
        self._close_if_done(turn)

    def interrupted(self, at: int) -> None:
        for turn in self._agents:
            if not turn.closed and (turn.responding or turn.speaking_since is not None):
                turn.interrupted = True

    def _close_if_done(self, turn: _AgentTurn, *, now: int | None = None) -> None:
        if turn.closed:
            return
        if now is None and (
            not turn.superseded or turn.responding or turn.speaking_since is not None
        ):
            return
        if turn.speaking_since is not None:
            end = max(now or turn.ended_at, turn.speaking_since)
            spoke = self._span(AGENT_SPEAKING, turn.speaking_since, turn.span)
            spoke.end(end_time=end)
            turn.ended_at = max(turn.ended_at, end)
            turn.speaking_since = None
        turn.closed = True
        turn.span.set_attribute(
            TURN_TEXT, turn.text.value() or turn.spoken_text.value()
        )
        if turn.interrupted:
            turn.span.set_attribute(TURN_INTERRUPTED, True)
        turn.span.end(end_time=turn.ended_at)

    # --- tools ---------------------------------------------------------

    def calls_started(self, tool_call_ids: list[str]) -> None:
        turn = self._responding() or next(
            (t for t in reversed(self._agents) if not t.closed), None
        )
        if turn is None:
            return
        for tool_call_id in tool_call_ids:
            self._requested_by[tool_call_id] = turn

    def call_in_progress(
        self, at: int, tool_call_id: str, name: str, arguments: Any
    ) -> None:
        if tool_call_id in self._calls:
            return
        turn = self._requested_by.pop(tool_call_id, None) or next(
            (t for t in reversed(self._agents) if not t.closed), None
        )
        parent = turn.span if turn is not None else self.start(at)
        self._calls[tool_call_id] = self._span(
            FUNCTION_CALL,
            at,
            parent,
            {
                TOOL_NAME: name,
                TOOL_CALL_ID: tool_call_id,
                TOOL_ARGUMENTS: _json(arguments),
            },
        )

    def call_result(
        self,
        at: int,
        tool_call_id: str,
        name: str,
        arguments: Any,
        result: Any,
        error: str | None,
    ) -> None:
        span = self._calls.pop(tool_call_id, None)
        if span is None:
            self.call_in_progress(at, tool_call_id, name, arguments)
            span = self._calls.pop(tool_call_id)
        failure = self._failures.pop(tool_call_id, None) or error
        if failure:
            span.set_attribute(TOOL_ERROR, failure)
            span.set_status(Status(StatusCode.ERROR, failure))
        else:
            span.set_attribute(TOOL_RESULT, _json(result))
        span.end(end_time=at)

    def call_cancelled(self, at: int, tool_call_id: str, why: str = CANCELLED) -> None:
        span = self._calls.pop(tool_call_id, None)
        if span is None:
            return
        span.set_attribute(TOOL_ERROR, why)
        span.set_status(Status(StatusCode.ERROR, why))
        span.end(end_time=at)

    # --- the end -------------------------------------------------------

    def finish(self, at: int) -> None:
        """End every open span, the root last. Safe to call more than once."""
        if self.finished:
            return
        self.finished = True
        self._write_human()
        for turn in self._agents:
            turn.superseded = True
            turn.responding = False
            self._close_if_done(turn, now=at)
        for tool_call_id in list(self._calls):
            self.call_cancelled(at, tool_call_id, UNFINISHED)
        root = self.start(at)
        root.end(end_time=at)


class EgmaObserver(BaseObserver):
    """Feeds a ``Recorder`` from the frames a Pipecat worker pushes.

    ``on_tools`` is handed each new tool set the pipeline carries (an
    ``LLMSetToolsFrame``, or the tools of an ``LLMContextFrame``), which is
    how a simulation learns Pipecat Flows functions as nodes are entered.
    """

    def __init__(
        self,
        recorder: Recorder,
        *,
        sink: Any = None,
        on_cleanup: Callable[[], Any] | None = None,
        on_tools: Callable[[Any], None] | None = None,
    ) -> None:
        super().__init__()
        self._recorder = recorder
        self._sink = sink
        self._on_cleanup = on_cleanup
        self._on_tools = on_tools
        self._last_tools: Any = None
        self._seen: OrderedDict[int, None] = OrderedDict()
        self._offset: int | None = None
        self._complained = False
        self.ended = asyncio.Event()

    def _wall(self, data: FramePushed) -> int:
        """The frame's push time as Unix nanoseconds."""
        timestamp = getattr(data, "timestamp", None)
        if self._offset is None:
            try:
                clock_now = data.source.get_clock().get_time()
            except Exception:
                return time.time_ns()
            self._offset = time.time_ns() - clock_now
        if not isinstance(timestamp, int) or timestamp <= 0:
            return time.time_ns()
        return timestamp + self._offset

    def _first_sighting(self, data: FramePushed) -> bool:
        frame = data.frame
        if (
            getattr(frame, "broadcast_sibling_id", None) is not None
            and data.direction != FrameDirection.DOWNSTREAM
        ):
            return False
        if frame.id in self._seen:
            return False
        self._seen[frame.id] = None
        if len(self._seen) > _REMEMBERED_FRAMES:
            self._seen.popitem(last=False)
        return True

    async def on_pipeline_started(self) -> None:
        try:
            self._recorder.start(time.time_ns())
        except Exception:
            self._complain()

    async def on_push_frame(self, data: FramePushed) -> None:
        try:
            self._handle(data)
        except Exception:
            self._complain()

    def _complain(self) -> None:
        if not self._complained:
            self._complained = True
            logger.exception("Egma could not record a Pipecat frame")

    def _handle(self, data: FramePushed) -> None:
        frame = data.frame
        if isinstance(frame, (EndFrame, CancelFrame, StopFrame)):
            if self._sink is None or data.destination is self._sink:
                self.ended.set()
            return
        if self._on_tools is not None and isinstance(
            frame, (LLMSetToolsFrame, LLMContextFrame)
        ):
            tools = (
                frame.tools
                if isinstance(frame, LLMSetToolsFrame)
                else getattr(frame.context, "tools", None)
            )
            if tools is not None and tools is not self._last_tools:
                self._last_tools = tools
                self._on_tools(tools)
            return
        if not isinstance(frame, _RECORDED):
            return
        if not self._first_sighting(data):
            return
        at = self._wall(data)
        recorder = self._recorder

        if isinstance(frame, StartFrame):
            recorder.start(at)
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            recorder.user_speech_started(at)
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            recorder.user_speech_stopped(at)
        elif isinstance(frame, UserStartedSpeakingFrame):
            recorder.user_turn_started(at)
        elif isinstance(frame, UserStoppedSpeakingFrame):
            recorder.user_turn_stopped(at)
        elif isinstance(frame, TranscriptionFrame):
            recorder.transcript(at, frame.text, final=True)
        elif isinstance(frame, InterimTranscriptionFrame):
            recorder.transcript(at, frame.text, final=False)
        elif isinstance(frame, LLMMessagesAppendFrame):
            if data.direction == FrameDirection.DOWNSTREAM:
                for message in frame.messages:
                    if isinstance(message, Mapping) and message.get("role") == "user":
                        text = _message_text(message.get("content"))
                        if text:
                            recorder.user_text(at, text)
        elif isinstance(frame, LLMFullResponseStartFrame):
            recorder.response_started(at)
        elif isinstance(frame, LLMFullResponseEndFrame):
            recorder.response_ended(at)
        elif isinstance(frame, LLMTextFrame):
            recorder.response_text(
                at,
                frame.text,
                spaced=bool(getattr(frame, "includes_inter_frame_spaces", False)),
                spoken=not getattr(frame, "skip_tts", False),
            )
        elif isinstance(frame, TTSTextFrame):
            recorder.spoken_text(
                at,
                frame.text,
                spaced=bool(getattr(frame, "includes_inter_frame_spaces", False)),
            )
        elif isinstance(frame, BotStartedSpeakingFrame):
            recorder.bot_speech_started(at)
        elif isinstance(frame, BotStoppedSpeakingFrame):
            recorder.bot_speech_stopped(at)
        elif isinstance(frame, InterruptionFrame):
            recorder.interrupted(at)
        elif isinstance(frame, FunctionCallsStartedFrame):
            recorder.calls_started([call.tool_call_id for call in frame.function_calls])
        elif isinstance(frame, FunctionCallInProgressFrame):
            recorder.call_in_progress(
                at, frame.tool_call_id, frame.function_name, frame.arguments
            )
        elif isinstance(frame, FunctionCallResultFrame):
            properties = getattr(frame, "properties", None)
            if (
                properties is not None
                and getattr(properties, "is_final", True) is False
            ):
                return
            recorder.call_result(
                at,
                frame.tool_call_id,
                frame.function_name,
                frame.arguments,
                frame.result,
                getattr(frame, "error", None),
            )
        elif isinstance(frame, FunctionCallCancelFrame):
            recorder.call_cancelled(at, frame.tool_call_id)

    async def cleanup(self) -> None:
        await super().cleanup()
        if self._on_cleanup is not None:
            try:
                await self._on_cleanup()
            except Exception:
                logger.exception("Egma could not finish this bot session's record")


_RECORDED = (
    StartFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    TranscriptionFrame,
    InterimTranscriptionFrame,
    LLMMessagesAppendFrame,
    LLMFullResponseStartFrame,
    LLMFullResponseEndFrame,
    LLMTextFrame,
    TTSTextFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    FunctionCallsStartedFrame,
    FunctionCallInProgressFrame,
    FunctionCallResultFrame,
    FunctionCallCancelFrame,
)
