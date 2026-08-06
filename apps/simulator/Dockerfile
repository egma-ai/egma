# syntax=docker/dockerfile:1

# The one Python image in a TypeScript monorepo. Built from the repository
# root like the other two, because the simulator needs one thing from
# outside its own directory: the contract package, which is the whole of
# what it shares with the rest of egma.
#
# Debian rather than Alpine, unlike the Node images beside it. The audio
# stack underneath the voice legs ships compiled wheels for glibc and not
# for musl, so Alpine would trade a smaller image for building numpy from
# source on every self-hoster's machine.
FROM python:3.13-slim-bookworm AS build

# uv is the simulator's toolchain everywhere else, so it is the toolchain
# here too — same lockfile, same resolution, no second way to install. It
# comes from the package index rather than from its own published image so
# that this build reaches exactly two hosts: the one the base image is on
# and the one the dependencies are on. A self-hoster behind a proxy has
# fewer things to allow, and a third registry cannot be what stops them.
RUN --mount=type=cache,target=/root/.cache/pip pip install uv==0.11.17

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /src/apps/simulator

# Manifests first, so editing source does not reinstall the world.
COPY apps/simulator/pyproject.toml apps/simulator/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# Then the simulator itself, copied into the environment rather than
# linked into it: the runtime stage below carries the environment and
# nothing else, and an editable install would point at a directory that
# is not there.
COPY apps/simulator/README.md ./
COPY apps/simulator/src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable

FROM python:3.13-slim-bookworm AS runtime

WORKDIR /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    EGMA_SIMULATION_CONTRACT_DIR=/app/packages/simulation-contract

COPY --from=build /app/.venv /app/.venv

# The contract, read at runtime rather than vendored: one shared artifact,
# two readers. The walk that finds it inside a checkout would find it here
# too, but a deployment should not depend on being shaped like a checkout,
# so the variable that exists for exactly this points at it above.
COPY packages/simulation-contract /app/packages/simulation-contract

# No EXPOSE, and no `ports:` in the compose file either. The simulator
# claims its work rather than being sent it, so nothing ever dials in and
# there is no port to declare. This absence is the feature.

CMD ["egma-simulator"]
