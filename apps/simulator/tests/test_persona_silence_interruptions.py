"""Interrupted follow-ups still have a two-attempt limit and a full reply wait."""

from __future__ import annotations

import asyncio

import test_persona_silence as silence_tests
from pipecat.frames.frames import (
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
)

from egma_simulator.conductor import ConductParameters, VoiceConductor
from egma_simulator.speech import ScriptedSTT, ScriptedTTS, encode_speech, silence


async def test_partial_followups_keep_two_attempt_cap_and_ten_second_reply_wait(
    tmp_path, monkeypatch
):
    transport = None
    active = None
    recorded = {1: asyncio.Event(), 2: asyncio.Event()}
    intervals = []

    create_transport = silence_tests.AgentScript.__init__

    def remember_transport(self, *args, **kwargs):
        nonlocal transport
        create_transport(self, *args, **kwargs)
        transport = self

    will_speak = VoiceConductor.persona_will_speak

    def remember_persona(self, *args, **kwargs):
        nonlocal active
        active = self
        will_speak(self, *args, **kwargs)

    accept_audio = VoiceConductor.persona_audio

    def remember_audio(self, frame, *, recorded_until):
        follow_up = self._pending_silence_follow_up
        accept_audio(self, frame, recorded_until=recorded_until)
        if follow_up:
            intervals.append((self._at(self._persona_began), self._at(recorded_until)))
            recorded[follow_up].set()

    speak = ScriptedTTS._speak

    async def interrupted_speech(self, text):
        assert active is not None
        follow_up = active._pending_silence_follow_up
        if not follow_up:
            await speak(self, text)
            return
        await self.push_frame(TTSStartedFrame())
        await self.push_frame(
            TTSAudioRawFrame(
                audio=encode_speech("Hello", self.sample_rate_hz),
                sample_rate=self.sample_rate_hz,
                num_channels=1,
            )
        )
        await recorded[follow_up].wait()
        assert transport is not None
        transport._queue_words(silence_tests.WORDLESS_AUDIO)
        # A real VAD interruption cancels this partial TTS response. Stock TTS
        # also drops the remaining audio without delivering TTSStoppedFrame.
        await asyncio.Event().wait()

    transcribe = ScriptedSTT.run_stt

    async def omit_noise_words(self, audio):
        async for frame in transcribe(self, audio):
            if (
                isinstance(frame, TranscriptionFrame)
                and frame.text == silence_tests.WORDLESS_AUDIO
            ):
                frame.text = ""
            yield frame

    agent_finished = VoiceConductor.the_agent_finished

    async def finish_noise_before_more_silence(self, said, heard_a_turn):
        due = await agent_finished(self, said, heard_a_turn)
        if heard_a_turn and not said.strip():
            assert transport is not None
            # Continue the media clock after the blank boundary is processed.
            # This prevents fixture audio from racing ahead of its backstop.
            transport._queue_audio(silence(13, transport._input_rate))
        return due

    monkeypatch.setattr(silence_tests.AgentScript, "__init__", remember_transport)
    monkeypatch.setattr(VoiceConductor, "persona_will_speak", remember_persona)
    monkeypatch.setattr(VoiceConductor, "persona_audio", remember_audio)
    monkeypatch.setattr(
        VoiceConductor, "the_agent_finished", finish_noise_before_more_silence
    )
    monkeypatch.setattr(ScriptedTTS, "_speak", interrupted_speech)
    monkeypatch.setattr(ScriptedSTT, "run_stt", omit_noise_words)

    walk = await silence_tests.walk_silence(
        tmp_path, parameters=ConductParameters(agent_turn_backstop_seconds=0.5)
    )

    assert walk.result is not None
    assert (
        walk.result.reason == "the agent did not respond after two persona follow-ups"
    )
    assert len(walk.requests) == 3
    assert len(intervals) == 2
    assert (
        len(walk.persona_turns) == 1
    )  # Partial speech is not invented as a full turn.
    silence_tests.assert_ten_seconds(intervals[1][0] - intervals[0][1])
    silence_tests.assert_ten_seconds(walk.recording_ended - intervals[1][1])
