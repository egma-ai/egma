import { ProductStatePage } from "@/ui/shell.tsx";
import { Loading } from "@/ui/page-state.tsx";

export default function LoadingClonePersona() {
  return <ProductStatePage title="Clone persona"><Loading what="persona" /></ProductStatePage>;
}
