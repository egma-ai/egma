"""A customer-style starter for the e2e bot, in front of it instead of Pipecat's runner.

It answers the start request shape Pipecat Cloud and Pipecat's development
runner share, and refuses any request without `Authorization: Bearer <secret>`.
Each start creates a Daily room with DAILY_API_KEY, gives the bot an owner
token and the client a separate, non-owner token, and runs `bot()` in this
process:

    STARTER_SECRET=... uv run tools/starter.py --port 7870

The secret comes from the environment variable that `--secret-env` names.
"""

from __future__ import annotations

import argparse
import asyncio
import hmac
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import aiohttp
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from loguru import logger
from pipecat.runner.types import DailyRunnerArguments
from pipecat.transports.daily.utils import DailyRESTHelper, DailyRoomParams, DailyRoomProperties

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bot  # noqa: E402

ROOM_KEYS = set(DailyRoomProperties.model_fields)
SESSIONS: set[asyncio.Task] = set()


def create_app(secret: str) -> FastAPI:
    app = FastAPI()

    @app.post("/start")
    async def start(request: Request, authorization: str | None = Header(default=None)):
        if not authorization or not hmac.compare_digest(authorization, f"Bearer {secret}"):
            logger.warning("E2E_STARTER_REFUSED missing or wrong Authorization header")
            raise HTTPException(status_code=401, detail="missing or wrong Authorization header")
        payload: dict[str, Any] = await request.json()
        if payload.get("transport", "daily") != "daily" or not payload.get("createDailyRoom"):
            raise HTTPException(status_code=400, detail="this starter makes Daily rooms only")

        properties = {
            key: value
            for key, value in (payload.get("dailyRoomProperties") or {}).items()
            if key in ROOM_KEYS
        }
        properties.setdefault("exp", time.time() + 600)
        properties.setdefault("eject_at_room_exp", True)
        lifetime = max(60.0, float(properties["exp"]) - time.time())

        async with aiohttp.ClientSession() as session:
            daily = DailyRESTHelper(
                daily_api_key=os.environ["DAILY_API_KEY"], aiohttp_session=session
            )
            room = await daily.create_room(
                DailyRoomParams(properties=DailyRoomProperties(**properties))
            )
            bot_token = await daily.get_token(room.url, expiry_time=lifetime, owner=True)
            client_token = await daily.get_token(room.url, expiry_time=lifetime, owner=False)

        session_id = str(uuid.uuid4())
        body = payload.get("body") if isinstance(payload.get("body"), dict) else {}
        runner_args = DailyRunnerArguments(
            room_url=room.url, token=bot_token, body=body, session_id=session_id
        )
        task = asyncio.create_task(bot.bot(runner_args))
        SESSIONS.add(task)
        task.add_done_callback(SESSIONS.discard)
        logger.info(f"E2E_STARTER_STARTED session {session_id} in {room.url}")
        return {"dailyRoom": room.url, "dailyToken": client_token, "sessionId": session_id}

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7870)
    parser.add_argument("--secret-env", default="STARTER_SECRET")
    args = parser.parse_args()
    secret = os.environ.get(args.secret_env, "")
    if not secret:
        raise SystemExit(f"Set {args.secret_env} to the secret the Authorization header must carry")
    uvicorn.run(create_app(secret), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
