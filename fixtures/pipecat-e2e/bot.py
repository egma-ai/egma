"""A Pipecat bot for Egma to simulate against.

Shaped like Pipecat's generated quickstart: Daily transport, Deepgram speech
recognition, OpenAI (gpt-4.1, Responses API), Cartesia speech, RTVI on, a
greeting on RTVI client-ready, and a cancel when the client leaves. It adds a
shop assistant with two plain tools, a Pipecat Flows variant, and the Egma SDK
line between `PipelineWorker(...)` and `runner.add_workers(worker)`.

Each session picks its shape from `runner_args.body["e2e"]`, falling back to
environment variables:

    variant  plain | flows    E2E_VARIANT   (default plain)
    rtvi     on | off         E2E_RTVI      (default on)
    sdk      auto | on | off  EGMA_SDK      (default auto: use the SDK when installed)
    monitor  on | off         EGMA_MONITOR  (default off)

Run locally with Pipecat's development runner:

    uv run bot.py -t daily
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

from dotenv import load_dotenv
from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.flows import Flow, FlowConfig, FlowManager
from pipecat.frames.frames import LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import DailyRunnerArguments, RunnerArguments
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.llm_service import FunctionCallParams
from pipecat.services.openai.responses.llm import OpenAIResponsesLLMService
from pipecat.transports.daily.transport import DailyParams, DailyTransport
from pipecat.workers.runner import WorkerRunner

import flow_handlers
import store

load_dotenv(override=True)

FLOW_CONFIG_PATH = Path(__file__).with_name("flow.yaml")

SYSTEM_INSTRUCTION = (
    f"You are the phone assistant of {store.SHOP_NAME}. Your replies are spoken aloud, so use "
    "short plain sentences with no lists, emojis or formatting. When the caller gives an order "
    "number, call lookup_order with it. When the caller asks when the store is open on a day, "
    "call check_store_hours for that day. Answer only from tool results; never guess an order "
    "status or opening hours."
)


@dataclass(frozen=True)
class Options:
    variant: str
    rtvi: bool
    sdk: str
    monitor: bool


def read_options(body: dict[str, Any]) -> Options:
    e2e = body.get("e2e")
    e2e = e2e if isinstance(e2e, dict) else {}

    def pick(key: str, env: str, default: str) -> str:
        return str(e2e.get(key, os.getenv(env) or default)).strip().lower()

    variant = pick("variant", "E2E_VARIANT", "plain")
    sdk = pick("sdk", "EGMA_SDK", "auto")
    if variant not in {"plain", "flows"}:
        raise ValueError(f"e2e variant must be plain or flows, not {variant!r}")
    if sdk not in {"auto", "on", "off"}:
        raise ValueError(f"e2e sdk must be auto, on or off, not {sdk!r}")
    return Options(
        variant=variant,
        rtvi=pick("rtvi", "E2E_RTVI", "on") != "off",
        sdk=sdk,
        monitor=pick("monitor", "EGMA_MONITOR", "off") == "on",
    )


def load_egma(options: Options) -> ModuleType | None:
    """Return `egma.pipecat`, or None when this session runs without the SDK."""
    if options.sdk == "off":
        return None
    try:
        return importlib.import_module("egma.pipecat")
    except ImportError:
        if options.sdk == "on":
            raise
        logger.warning("E2E_EGMA_SDK_MISSING egma.pipecat is not installed; running without it")
        return None


async def handle_lookup_order(params: FunctionCallParams) -> None:
    await params.result_callback(store.lookup_order(str(params.arguments.get("order_id", ""))))


async def check_store_hours(params: FunctionCallParams, day: str) -> None:
    """Look up when the store is open on one day of the week.

    Args:
        day: The day of the week the caller asks about, for example "Saturday".
    """
    await params.result_callback(store.check_store_hours(day))


LOOKUP_ORDER = FunctionSchema(
    name="lookup_order",
    description="Look up the status of a customer's order by its order number.",
    properties={
        "order_id": {"type": "string", "description": "The order number, for example A100."}
    },
    required=["order_id"],
)


def token_fingerprint(token: str | None) -> str | None:
    """A short hash that tells two tokens apart without revealing either."""
    return hashlib.sha256(token.encode()).hexdigest()[:8] if token else None


def tool_names(context: LLMContext) -> list[str]:
    tools = context.tools
    return [tool.name for tool in tools.standard_tools] if isinstance(tools, ToolsSchema) else []


async def run_bot(
    transport: DailyTransport, runner_args: DailyRunnerArguments, options: Options
) -> None:
    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY"))
    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY"),
        settings=CartesiaTTSService.Settings(
            voice=os.getenv("CARTESIA_VOICE_ID", "71a7ad14-091c-4e8e-a314-022ece01c121"),
        ),
    )

    if options.variant == "flows":
        llm = OpenAIResponsesLLMService(
            api_key=os.getenv("OPENAI_API_KEY"),
            settings=OpenAIResponsesLLMService.Settings(
                model=os.getenv("OPENAI_MODEL", "gpt-4.1"),
            ),
        )
        context = LLMContext()
    else:
        llm = OpenAIResponsesLLMService(
            api_key=os.getenv("OPENAI_API_KEY"),
            settings=OpenAIResponsesLLMService.Settings(
                model=os.getenv("OPENAI_MODEL", "gpt-4.1"),
                system_instruction=SYSTEM_INSTRUCTION,
            ),
        )
        # One tool through register_function, one as a direct function the
        # context carries: the two ordinary ways a Pipecat bot adds a tool.
        llm.register_function("lookup_order", handle_lookup_order)
        context = LLMContext(tools=ToolsSchema(standard_tools=[LOOKUP_ORDER, check_store_hours]))

    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )
    user_aggregator, assistant_aggregator = context_aggregator

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        enable_rtvi=options.rtvi,
        observers=[],
    )

    logger.info("E2E_TOOLS_AT_SDK_LINE " + json.dumps(tool_names(context)))

    # The Egma SDK line.
    egma = load_egma(options)
    if egma is not None:
        await egma.simulation(worker, runner_args)
        if options.monitor:
            await egma.monitor(worker, runner_args)

    async def greet() -> None:
        context.add_message(
            {"role": "developer", "content": "Greet the caller in one short sentence."}
        )
        await worker.queue_frames([LLMRunFrame()])

    if options.rtvi and options.variant == "plain":

        @worker.rtvi.event_handler("on_client_ready")
        async def on_client_ready(rtvi):
            logger.info("E2E_CLIENT_READY")
            await greet()

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("E2E_CLIENT_CONNECTED")
        if not options.rtvi and options.variant == "plain":
            await greet()

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("E2E_CLIENT_DISCONNECTED")
        await worker.cancel()

    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)

    if options.variant == "flows":
        flow = Flow(FlowConfig.from_file(FLOW_CONFIG_PATH), handlers=flow_handlers)
        flow_manager = FlowManager(
            worker=worker,
            llm=llm,
            context_aggregator=context_aggregator,
            transport=transport,
            global_functions=flow.global_functions,
        )

        @transport.event_handler("on_client_connected")
        async def start_flow(transport, client):
            await flow_manager.initialize(flow.initial_node)
            logger.info("E2E_TOOLS_AFTER_FLOW_START " + json.dumps(tool_names(context)))

    await runner.run()


async def bot(runner_args: RunnerArguments):
    """Pipecat entry point, called by the development runner and by Pipecat Cloud."""
    body = runner_args.body if isinstance(runner_args.body, dict) else {}
    options = read_options(body)
    logger.info(
        "E2E_SESSION "
        + json.dumps(
            {
                "args": type(runner_args).__name__,
                "session_id": getattr(runner_args, "session_id", None),
                "room_url": getattr(runner_args, "room_url", None),
                "token_sha256_8": token_fingerprint(getattr(runner_args, "token", None)),
                "body": body,
                "options": asdict(options),
            },
            default=str,
        )
    )
    if not isinstance(runner_args, DailyRunnerArguments):
        logger.error(f"This bot runs on Daily only, not {type(runner_args).__name__}")
        return

    transport = DailyTransport(
        runner_args.room_url,
        runner_args.token,
        "Pipecat Bot",
        params=DailyParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    await run_bot(transport, runner_args, options)


if __name__ == "__main__":
    from pipecat.runner.run import main

    main()
