# Charter: Crash Recovery And At-Least-Once Honesty

Goal: explore failure boundaries around claims, external side effects, checkpoints, and heartbeats.

- Run at least two worker processes against one app/resource.
- Terminate workers with `SIGKILL` after claim, during user code, after an external side effect, and
  after a step checkpoint.
- Observe lease expiry, new lease tokens, attempt history, stalled counts, and final run state.
- Attempt late completion and failure with the stale token.
- Confirm external side effects can duplicate and completed checkpoints do not.
- Vary lease duration and include one event-loop-blocking task; record operational ergonomics and
  documentation gaps.
