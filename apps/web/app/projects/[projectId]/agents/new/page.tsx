import { AwaitingArea } from "../../awaiting.tsx";

export default function RegisterAgentPage() {
  return (
    <AwaitingArea
      area="Registering an agent"
      title="Register an agent"
      what="An agent's name and description in egma, and the first way egma can reach it."
      meanwhile="Register an agent from a terminal with npx egma, which also sets up the connection. The browser form arrives with Agents."
    />
  );
}
