import { TOOLS_BASE_URL } from "../config.ts";

/** Told to Retell so the voice agent knows when and how to use this tool. */
export const lookUpOrderTool = {
  type: "custom",
  name: "look_up_order",
  description:
    "Find an order by its number and answer where it has got to. Use it whenever someone asks about an order they already placed.",
  url: `${TOOLS_BASE_URL}/look-up-order`,
  speak_during_execution: true,
  speak_after_execution: true,
  parameters: {
    type: "object",
    properties: {
      order_number: {
        type: "string",
        description: "The order number, in the shape QB-00000.",
      },
    },
    required: ["order_number"],
  },
};

export type OrderState = "received" | "with the binder" | "ready to collect";

export function lookUpOrder(orderNumber: string): { state: OrderState; due: string } {
  // The real workshop system sits behind this; the fixture answers a fixed row.
  return orderNumber === "QB-00042"
    ? { state: "with the binder", due: "next Thursday" }
    : { state: "received", due: "not yet set" };
}
