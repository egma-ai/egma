import { ProductStatePage } from "@/ui/shell.tsx";
import { Loading } from "@/ui/page-state.tsx";

export default function LoadingPersona() {
  return <ProductStatePage title="Persona"><Loading what="persona" /></ProductStatePage>;
}
