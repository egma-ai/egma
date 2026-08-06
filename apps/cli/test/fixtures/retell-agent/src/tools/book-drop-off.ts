import { TOOLS_BASE_URL } from "../config.ts";

/** Told to Retell so the voice agent knows when and how to use this tool. */
export const bookDropOffTool = {
  type: "custom",
  name: "book_drop_off",
  description:
    "Hold a drop-off slot at the workshop. Only for slots the workshop is open for: Tuesday to Saturday, 10:00 to 17:00.",
  url: `${TOOLS_BASE_URL}/book-drop-off`,
  speak_during_execution: true,
  speak_after_execution: true,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Who is bringing the book in." },
      day: { type: "string", description: "The day, as an ISO date." },
      time: { type: "string", description: "The time, as 24-hour HH:MM." },
    },
    required: ["name", "day", "time"],
  },
};

export function bookDropOff(name: string, day: string, time: string): { held: boolean } {
  const hour = Number(time.slice(0, 2));
  return { held: name !== "" && day !== "" && hour >= 10 && hour < 17 };
}
