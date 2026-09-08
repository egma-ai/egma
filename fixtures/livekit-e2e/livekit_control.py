"""Create and dispatch one ordinary LiveKit room for the inertness proof."""

from __future__ import annotations

import argparse
import asyncio

from livekit import api


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("api_key")
    parser.add_argument("api_secret")
    parser.add_argument("room")
    parser.add_argument("agent_name")
    args = parser.parse_args()
    client = api.LiveKitAPI(args.url, args.api_key, args.api_secret)
    try:
        await client.room.create_room(api.CreateRoomRequest(name=args.room))
        await client.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                room=args.room,
                agent_name=args.agent_name,
                metadata='{"egma_e2e":"production-inert"}',
            )
        )
    finally:
        await client.aclose()


if __name__ == "__main__":
    asyncio.run(main())
