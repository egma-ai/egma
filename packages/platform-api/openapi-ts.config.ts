import { defineConfig } from "@hey-api/openapi-ts";

import { platformClientConfig } from "./platform-client-config.ts";

export default defineConfig(
  platformClientConfig(
    "./openapi/platform-api.openapi.json",
    "./src/generated",
  ),
);
