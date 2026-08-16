# Egma documentation

This directory is the source for [docs.egma.ai](https://docs.egma.ai).
Mintlify reads it from the `/docs` directory in the `egma-ai/egma` repository.

## Preview changes

Install the Mintlify CLI, then start it from this directory:

```bash
npm install --global mint
cd docs
mint dev
```

The local preview opens at `http://localhost:3000`.

## Publish changes

Open a pull request against the Egma repository. Mintlify creates a preview for
the pull request and deploys the documentation after the change reaches the
default branch.
