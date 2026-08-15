import { AwaitingArea } from "../awaiting.tsx";

export default function RunsPage() {
  return (
    <AwaitingArea
      area="Run history"
      title="Runs"
      what="Every execution of a selection of tests against one agent over one connection."
      meanwhile="Start a run with egma run, and open the address it prints to read its results. The list and the run builder arrive with Runs."
    />
  );
}
