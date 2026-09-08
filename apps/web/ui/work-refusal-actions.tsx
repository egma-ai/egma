import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Take a blocked run or regrade to the settings that can resolve its refusal. */
export function WorkRefusalActions({
  code,
  projectId,
}: {
  readonly code: string;
  readonly projectId: string;
}) {
  const settings = `/projects/${encodeURIComponent(projectId)}/settings`;
  if (code === "providers_unfunded") {
    return (
      <div className="flex flex-wrap gap-2">
        <Button asChild><Link href={`${settings}/billing`}>Add credits</Link></Button>
        <Button asChild variant="secondary">
          <Link href={`${settings}/provider-api-keys`}>Manage provider API keys</Link>
        </Button>
      </div>
    );
  }
  if (code === "provider_key_unavailable") {
    return (
      <Button asChild>
        <Link href={`${settings}/provider-api-keys`}>Manage provider API keys</Link>
      </Button>
    );
  }
  if (code === "allowance_spent") {
    return <Button asChild><Link href={`${settings}/billing`}>Usage and billing</Link></Button>;
  }
  return null;
}
