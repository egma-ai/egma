import { ProductStatePage } from "@/ui/shell.tsx";
import { Loading } from "@/ui/page-state.tsx";

export default function LoadingNewPersona() {
  return <ProductStatePage title="New persona"><Loading what="persona choices" /></ProductStatePage>;
}
