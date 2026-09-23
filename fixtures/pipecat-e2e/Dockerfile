# Pipecat Cloud image for the e2e bot. Build it from the context deploy.sh
# stages (.build/), which holds only the files below and, when this branch has
# the Egma SDK, its wheel under wheels/.
FROM dailyco/pipecat-base:0.1.31

ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

COPY wheels/ /tmp/egma-wheels/
RUN for wheel in /tmp/egma-wheels/*.whl; do \
      [ -e "$wheel" ] || continue; \
      uv pip install --python /app/.venv/bin/python "${wheel}[pipecat]"; \
    done

COPY bot.py flow_handlers.py store.py flow.yaml ./
