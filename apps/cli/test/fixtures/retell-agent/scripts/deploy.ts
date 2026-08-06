/**
 * Pushes the repository's prompt and tools up to Retell.
 *
 * The prompt in `prompts/` is the one this workshop reviews in pull requests,
 * so it is the one Retell has to be running. This script is what makes that
 * true, and it runs from the release workflow.
 */

import { readFile } from "node:fs/promises";
import process from "node:process";

import Retell from "retell-sdk";

import { RETELL_AGENT_ID, RETELL_LLM_ID } from "../src/config.ts";
import { bookDropOffTool } from "../src/tools/book-drop-off.ts";
import { lookUpOrderTool } from "../src/tools/look-up-order.ts";

const retell = new Retell({ apiKey: process.env.RETELL_API_KEY ?? "" });

const generalPrompt = await readFile(
  new URL("../prompts/order-line.md", import.meta.url),
  "utf8",
);

await retell.llm.update(RETELL_LLM_ID, {
  general_prompt: generalPrompt,
  begin_message: "Quillfeather Bindery, how can I help?",
  general_tools: [lookUpOrderTool, bookDropOffTool],
});

await retell.agent.update(RETELL_AGENT_ID, {
  agent_name: "order-line",
  voice_id: "11labs-Chloe",
  language: "en-GB",
  webhook_url: "https://orders.quillfeather.example/retell/events",
});

process.stdout.write("Quillfeather's order line is up to date on Retell.\n");
