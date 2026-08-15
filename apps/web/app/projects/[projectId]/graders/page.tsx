import { AwaitingArea } from "../awaiting.tsx";

export default function GradersPage() {
  return (
    <AwaitingArea
      area="Grader authoring"
      title="Graders"
      what="The authored logic that judges a simulation, beside the built-in expected-behaviors grader."
      meanwhile="Every test is already judged against its own expected behaviors. Authoring graders of your own arrives with Graders."
    />
  );
}
