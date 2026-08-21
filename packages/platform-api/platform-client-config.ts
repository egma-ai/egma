export function platformClientConfig(input: string, output: string) {
  return {
    input,
    output: {
      path: output,
      module: { extension: ".js" as const },
      tsConfigPath: "./tsconfig.json",
    },
    plugins: [
      {
        name: "@hey-api/client-fetch" as const,
        bundle: true,
        throwOnError: false,
      },
      { name: "@hey-api/typescript" as const },
      {
        name: "@hey-api/sdk" as const,
        client: true,
        operations: "flat" as const,
        paramsStructure: "flat" as const,
        responseStyle: "fields" as const,
      },
    ],
  };
}
