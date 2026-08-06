# Quillfeather Bindery — order line

The voice agent that answers the order line for Quillfeather Bindery, an
invented bookbinding workshop. Retell runs the voice agent; this repository
holds the prompt, the two tools it can use, and the service Retell reaches for
them.

- `prompts/order-line.md` — the prompt, reviewed here and pushed to Retell.
- `src/tools/` — the tool definitions and the code behind them.
- `src/config.ts` — the Retell agent and LLM identifiers.
- `scripts/deploy.ts` — pushes the prompt and the tools to Retell.

Set `RETELL_API_KEY` before running the deploy script.
