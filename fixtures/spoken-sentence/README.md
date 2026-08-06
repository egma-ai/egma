# One sentence, spoken

A single short sentence in a synthesized human voice:

> Move my Tuesday cleaning to Thursday, please.

It exists so that a speech-to-text integration can be tested against real
speech rather than against a tone the test itself invented. A transcriber that
reads this file and answers with that sentence has been proved end to end; one
fed a synthetic waveform has been proved against nothing.

Recorded by running egma's own text-to-speech leg once and keeping what came
back, then trimming to the words and a short pause each side. Nothing about it
is secret and nothing in it identifies anybody: it is a machine reading a
sentence about a cleaning appointment.

## What is in it

| File | What it is |
| --- | --- |
| `one-sentence.wav` | The sentence: mono, 16 kHz, 16-bit signed little-endian PCM, 2.4 seconds |
| `.gitattributes` | Marks the audio as binary so nothing normalises the samples |

## Who reads it

`apps/simulator/tests/test_live_deepgram.py` — the opt-in test that hands this
file to a real transcriber and checks the words that come back. That test skips
unless a provider key is in the environment, so nothing in CI reads this file
over a network; CI reads it not at all.
