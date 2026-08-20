import { ProductStatePage } from "../../ui/shell.tsx";

/**
 * What the router draws between the press and
 * `/members` arriving.
 *
 * A forwarding address, reached from the account menu. Its page waits with a
 * header and nothing under it, so this is that header — same words, same
 * shape, nothing added that the page would then remove.
 *
 * Its header is the page's own down to its shape — the same eyebrow or the
 * same crumbs, never one standing in for the other — so nothing is redrawn a
 * second way when the page arrives. `agents/loading.tsx` carries the
 * reasoning every one of these shares.
 */
export default function MembersLoading() {
  return (
    <div data-slot="route-loading">
      <ProductStatePage eyebrow="Settings"
        title="Opening organization settings"
        lead="People and invitations moved into the product shell, beside the project selector." />
    </div>
  );
}
