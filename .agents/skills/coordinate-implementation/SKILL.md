---
name: coordinate-implementation
description: Drive one ticketed effort through parallel implementation, independent review, serial integration, and one open pull request.
disable-model-invocation: true
---

<!-- path-routing:start -->
Repository configuration overrides this skill's default planning paths.
If a Planning root is defined, resolve `CONTEXT.md`, `docs/adr/`,
`docs/agents/`, `.scratch/`, and `.out-of-scope/` from that root.
Skill-local paths remain unchanged.
<!-- path-routing:end -->

Your job is to act as a coordinator and implement a bunch of tickets. Up until their end, the typical flow is that you will first create an integration branch, and then each of the tickets will raise their own individual PRs to this integration branch. This integration branch would be the culmination of all of the other tickets.
Here is the development flow:
1. You will look at all the tickets.
2. You will tell the user if there is anything needed from the user, such as API keys or anything else, in order to drive the whole thing end to end.
3. Your main goal is to drive the whole ticket end to end and not stop to ask for permissions or anything like that.
4. You will build the ticket graph and dependency. If something can be run in parallel, those tickets should be run in parallel.
5. For each ticket, you will fire off Opus 5 subagent with "max" reasoning and tell it to implement using the implement skill in this codebase. use /implement skill. But tell the subagent to run scoped tests and not waste time on running full suite. The full suite should only run once for the whole effort after all the tickets have landed.
6. Once that subagent, in its independent context, has done the implementation, you will fire off another subagent to check its work using the review skill of this codebase. use /code-review skill
7. Once that review comes back and whatever issues it has, go back to the implementation agent. This back-and-forth of review and implementation can happen at most two times.
8. If there are still issues, record them, and then raise the PR to the integration branch from this ticket branch.
9. That would lead to running our PR review bot on GitHub. Wait for the check_run completion event for the exact PR head SHA. Do not poll GitHub. If you do it this way, you won't waste time waiting for the bot more than you'd need.
10. Once that is done, move on to the next ticket and keep on recording the issues if there are any leftover issues.
11. Meanwhile, you, as a coordinator, need to see and judge whether some issues, or reviewer flags, are actually worth solving or not, because each run takes time.
12. We do this work for all the tickets and keep on doing and repeating the loop until one final integration branch is ready to create a PR on main. 
13. After all tickets have landed, pull the latest from main into the integration branch and run the full suite once. Raise the final PR, review and fix its comments, and rerun the full suite if the commit changes.
14. That is when you will actually call your work done.

You MUST keep your context protected. Your sole goal is to land all the tickets to the finish line.
