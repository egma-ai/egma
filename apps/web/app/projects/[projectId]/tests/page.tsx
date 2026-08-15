import { AwaitingArea } from "../awaiting.tsx";

export default function TestsPage() {
  return (
    <AwaitingArea
      area="Test authoring"
      title="Tests"
      what="One authored specification: the situation, who calls about it, and what should happen."
      meanwhile="Tests are authored in the egma folder of your agent's repository and pushed with egma push. Browser authoring arrives with Tests."
    />
  );
}
