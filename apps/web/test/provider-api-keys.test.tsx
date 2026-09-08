// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProviderApiKeysPage from "../app/projects/[projectId]/settings/provider-api-keys/page.tsx";
import type { ProviderKeyEntry } from "@egma/platform-api/client";
import { memberSession } from "./usage-billing-fixtures.ts";
import { observeRequest, type FetchInput } from "./platform-request.ts";
import { REPLAY_PRIVATE_ATTRIBUTE } from "../lib/replay-privacy.ts";

const routed = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), back: vi.fn() },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/prj_1/settings/provider-api-keys",
  useRouter: () => routed.router,
  useParams: () => ({ projectId: "prj_1" }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: unknown;
  }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));
vi.mock("next/image", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

let rows: ProviderKeyEntry[];
let mayManage: boolean;
let failedWrite: boolean;
let holdWrite: Promise<void> | undefined;
const requests: Awaited<ReturnType<typeof observeRequest>>[] = [];
const ORIGINAL_CREDENTIAL = {
  hint: "••••old1",
  revision: "rev_original",
  updatedAt: "2026-09-07T12:00:00Z",
};
beforeEach(() => {
  rows = [
    { provider: "openai", label: "OpenAI", credential: null },
    { provider: "deepgram", label: "Deepgram", credential: null },
    { provider: "cartesia", label: "Cartesia", credential: null },
  ];
  mayManage = true;
  failedWrite = false;
  holdWrite = undefined;
  requests.length = 0;
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = await observeRequest(input, init);
      requests.push(request);
      let body: unknown;
      let status = 200;
      if (request.path === "/api/me")
        body = memberSession(mayManage ? "admin" : "member");
      else if (request.path === "/v1/provider-keys")
        body = { providers: rows, mayManageProviderKeys: mayManage };
      else if (request.path.startsWith("/v1/provider-keys/")) {
        await holdWrite;
        if (failedWrite) {
          status = 409;
          body = {
            error: "identity_conflict",
            message:
              "This key changed. Close and open it again before replacing it.",
          };
        } else {
          const provider = request.path.split("/").at(-1);
          rows = rows.map((row) =>
            row.provider === provider
              ? {
                  ...row,
                  credential:
                    request.method.toUpperCase() === "DELETE"
                      ? null
                      : {
                          ...ORIGINAL_CREDENTIAL,
                          hint: "••••new1",
                          revision: "rev_new",
                        },
                }
              : row,
          );
          body = rows.find((row) => row.provider === provider);
        }
      } else throw new Error(`Unexpected request: ${request.path}`);
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("adds an organization key through a private password field and clears its draft after saving", async () => {
  render(<ProviderApiKeysPage />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Add OpenAI key" }),
  );
  const key = screen.getByLabelText("API key*") as HTMLInputElement;
  expect(key.type).toBe("password");
  expect(key.getAttribute(REPLAY_PRIVATE_ATTRIBUTE)).toBe("");
  fireEvent.change(key, { target: { value: "  fake-key-new1  " } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByText("OpenAI key saved.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByLabelText("API key*")).toBeNull());
  expect(requests.find((r) => r.method.toUpperCase() === "PUT")).toMatchObject({
    path: "/v1/provider-keys/openai",
    body: { key: "fake-key-new1", expectedRevision: null },
  });
  expect(await screen.findByText("••••new1")).toBeTruthy();
  expect(screen.queryByText("fake-key-new1")).toBeNull();
});

it("retains a replacement draft on a stale-write refusal and never overwrites a newer revision", async () => {
  rows[0] = { ...rows[0]!, credential: ORIGINAL_CREDENTIAL };
  failedWrite = true;
  render(<ProviderApiKeysPage />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage OpenAI key" }),
  );
  const key = screen.getByLabelText("New API key*") as HTMLInputElement;
  fireEvent.change(key, { target: { value: "fake-replacement" } });
  rows[0] = {
    ...rows[0]!,
    credential: { ...ORIGINAL_CREDENTIAL, revision: "rev_other_admin" },
  };
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByText(/This key changed/)).toBeTruthy();
  expect(key.value).toBe("fake-replacement");
  expect(requests.find((r) => r.method.toUpperCase() === "PUT")?.body).toEqual({
    key: "fake-replacement",
    expectedRevision: "rev_original",
  });
  expect(screen.queryByText("OpenAI key saved.")).toBeNull();
  await waitFor(() =>
    expect(requests.filter((r) => r.path === "/v1/provider-keys")).toHaveLength(
      2,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Discard changes" }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Manage OpenAI key" }),
    ),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage OpenAI key" }),
  );
  fireEvent.change(await screen.findByLabelText("New API key*"), {
    target: { value: "fake-replacement" },
  });
  failedWrite = false;
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  expect(await screen.findByText("OpenAI key saved.")).toBeTruthy();
  expect(
    requests.filter((r) => r.method.toUpperCase() === "PUT").at(-1)?.body,
  ).toEqual({ key: "fake-replacement", expectedRevision: "rev_other_admin" });
});

it("requires explicit removal confirmation and explains the return to inference credits", async () => {
  rows[0] = { ...rows[0]!, credential: ORIGINAL_CREDENTIAL };
  render(<ProviderApiKeysPage />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage OpenAI key" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  const confirmation = await screen.findByRole("dialog", {
    name: "Remove OpenAI API key?",
  });
  expect(
    within(confirmation).getByText(/will use your inference balance/),
  ).toBeTruthy();
  expect(requests.some((r) => r.method.toUpperCase() === "DELETE")).toBe(false);
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Remove key" }),
  );
  expect(await screen.findByText("OpenAI key removed.")).toBeTruthy();
  expect(
    requests.find((r) => r.method.toUpperCase() === "DELETE")?.body,
  ).toEqual({ expectedRevision: "rev_original" });
});

it("lets members see masked provider status without key management controls", async () => {
  mayManage = false;
  rows[0] = { ...rows[0]!, credential: ORIGINAL_CREDENTIAL };
  render(<ProviderApiKeysPage />);
  expect(await screen.findByText("••••old1")).toBeTruthy();
  expect(screen.getByText(/Ask an organization admin/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: /(?:Add|Manage) .* key/ }),
  ).toBeNull();
  expect(
    screen
      .getByRole("link", { name: "Provider API Keys" })
      .getAttribute("aria-current"),
  ).toBe("page");
});

it("keeps a pending removal open on Escape and displays a failed delete", async () => {
  rows[0] = { ...rows[0]!, credential: ORIGINAL_CREDENTIAL };
  let finish: (() => void) | undefined;
  holdWrite = new Promise<void>((resolve) => {
    finish = resolve;
  });
  failedWrite = true;
  render(<ProviderApiKeysPage />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Manage OpenAI key" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  const confirmation = await screen.findByRole("dialog", {
    name: "Remove OpenAI API key?",
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Remove key" }),
  );
  await waitFor(() =>
    expect(requests.some((r) => r.method.toUpperCase() === "DELETE")).toBe(
      true,
    ),
  );
  fireEvent.keyDown(confirmation, { key: "Escape", code: "Escape" });
  expect(
    screen.getByRole("dialog", { name: "Remove OpenAI API key?" }),
  ).toBeTruthy();
  await act(async () => {
    finish?.();
  });
  expect(
    await within(confirmation).findByText(/This key changed/),
  ).toBeTruthy();
  expect(screen.queryByText("OpenAI key removed.")).toBeNull();
});
