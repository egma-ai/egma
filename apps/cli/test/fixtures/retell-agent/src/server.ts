/**
 * The web service Retell reaches for the two custom tools, and for events.
 *
 * Retell hosts the voice agent itself; this is only the part of it that has to
 * run where the workshop's own data is.
 */

import express from "express";

import { bookDropOff } from "./tools/book-drop-off.ts";
import { lookUpOrder } from "./tools/look-up-order.ts";

const app = express();
app.use(express.json());

app.post("/retell/look-up-order", (request, response) => {
  const { order_number: orderNumber } = request.body as { order_number: string };
  response.json(lookUpOrder(orderNumber));
});

app.post("/retell/book-drop-off", (request, response) => {
  const { name, day, time } = request.body as { name: string; day: string; time: string };
  response.json(bookDropOff(name, day, time));
});

app.post("/retell/events", (_request, response) => {
  response.sendStatus(204);
});

app.listen(Number(process.env.PORT ?? 8080));
