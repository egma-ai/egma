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

# The sentence-tokenizer corpus, fetched once here rather than at run time.
#
# The speaking leg regroups a turn into sentences to line spoken words up
# with the transcript, and that regrouping needs this data. It is the same
# file for every deployment, it never changes between them, and nobody
# configures it — so there is nothing to gain by fetching it later, and a
# customer's firewall would be a poor place to discover it was missing.
#
# English alone, because the sentence matcher asks for no other language;
# that is 244 KB where the whole package is 11 MB. Should a language ever
# be asked for, the library's own missing-data error says so loudly rather
# than guessing, which is what makes this pruning safe to do.
#
# Run through the interpreter directly and not through the simulator: the
# package disarms NLTK's downloader on import, deliberately, and this is
# the one moment that download is wanted.
# Said twice, because the two say different things. The variable puts the
# directory on NLTK's *search* path, without which the downloader refuses
# to write there at all — it will not write anywhere it would not later
# read from. The argument below is the *destination*, which otherwise
# lands in whichever home directory the build happens to run as.
ENV NLTK_DATA=/app/nltk_data

# Loudly, and checked twice: the downloader answers False rather than
# raising, so a quiet build would carry an image whose speaking leg fails
# on its first two-sentence turn — the very failure this line prevents.
# The second check reads the corpus back the way the simulator will.
RUN /app/.venv/bin/python -c \
        "import nltk, sys; sys.exit(0 if nltk.download('punkt_tab', download_dir='/app/nltk_data') else 'the punkt_tab corpus could not be fetched')" \
    && find /app/nltk_data/tokenizers/punkt_tab -maxdepth 1 -mindepth 1 \
        -not -name english -exec rm -rf {} + \
    && rm -f /app/nltk_data/tokenizers/punkt_tab.zip \
    && /app/.venv/bin/python -c "import nltk; nltk.data.find('tokenizers/punkt_tab')"

FROM python:3.13-slim-bookworm AS runtime

WORKDIR /app
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    EGMA_SIMULATION_CONTRACT_DIR=/app/packages/simulation-contract \
    NLTK_DATA=/app/nltk_data

COPY --from=build /app/.venv /app/.venv

# Named rather than left to the library's search path: the corpus is a
# thing this image ships, so where it is should be readable here instead
# of inferred from somebody's home directory at run time.
COPY --from=build /app/nltk_data /app/nltk_data

# The contract, read at runtime rather than vendored: one shared artifact,
# two readers. The walk that finds it inside a checkout would find it here
# too, but a deployment should not depend on being shaped like a checkout,
# so the variable that exists for exactly this points at it above.
COPY packages/simulation-contract /app/packages/simulation-contract

# No EXPOSE, and no `ports:` in the compose file either. The simulator
# claims its work rather than being sent it, so nothing ever dials in and
# there is no port to declare. This absence is the feature.

CMD ["egma-simulator"]
