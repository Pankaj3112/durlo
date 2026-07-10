# Charter: Controls, Timers, And Timing Races

Goal: explore user-visible behavior when controls race worker and timer transitions.

- Race cancellation against completion, failure, retry scheduling, and due timer firing.
- Repeat cancellation and manual retry commands rapidly from separate clients.
- Exercise pending, running, sleeping, completed, failed, dead-letter, and cancelled states.
- Move database time eligibility around exact due/expiry boundaries without changing JavaScript
  clocks.
- Verify terminal runs cannot be reclaimed or resumed and no active attempt remains stranded.
- Assess whether returned errors and persisted state make the winner of each race understandable.
