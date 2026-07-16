import type {
  AttemptRecord,
  AttemptStatus,
  RunDetails,
  RunTimelineEvent,
  RunTimelineEventType,
  StoredRunDetails
} from "./types.js";

const FAILURE_STATUSES = new Set<AttemptStatus>(["failed", "timed_out", "stalled"]);

const EVENT_ORDER: Record<RunTimelineEventType, number> = {
  run_created: 0,
  run_retry_started: 9,
  run_manual_retry_started: 9,
  run_retry_scheduled: 75,
  run_manual_retry_scheduled: 75,
  run_released: 75,
  run_attempt_started: 10,
  step_created: 20,
  step_attempt_started: 30,
  step_attempt_succeeded: 40,
  step_attempt_failed: 40,
  step_attempt_timed_out: 40,
  step_attempt_stalled: 40,
  step_attempt_cancelled: 40,
  step_completed: 50,
  step_failed: 50,
  timer_scheduled: 60,
  run_attempt_succeeded: 70,
  run_attempt_failed: 70,
  run_attempt_timed_out: 70,
  run_attempt_stalled: 70,
  run_attempt_cancelled: 70,
  timer_fired: 80,
  timer_cancelled: 80,
  run_completed: 90,
  run_failed: 90,
  run_dead_letter: 90,
  run_cancelled: 90
};

function attemptEventType(attempt: AttemptRecord, status: AttemptStatus): RunTimelineEventType {
  return `${attempt.kind}_attempt_${status}` as RunTimelineEventType;
}

export function buildRunDetails(records: StoredRunDetails): RunDetails {
  const { run, steps, attempts, timers, checkedAt } = records;
  const timeline: RunTimelineEvent[] = [
    {
      id: `run_created:${run.id}`,
      type: "run_created",
      at: run.createdAt,
      runId: run.id,
      recordId: run.id,
      status: "pending",
      scheduledAt: run.scheduledAt
    }
  ];

  for (const attempt of attempts) {
    timeline.push({
      id: `${attempt.kind}_attempt_started:${attempt.id}`,
      type: attempt.kind === "run" ? "run_attempt_started" : "step_attempt_started",
      at: attempt.startedAt,
      runId: run.id,
      recordId: attempt.id,
      ...(attempt.stepId === null ? {} : { stepId: attempt.stepId }),
      attemptNumber: attempt.attemptNumber,
      ...(attempt.workerId === null ? {} : { workerId: attempt.workerId }),
      status: "running"
    });
    if (attempt.completedAt && attempt.status !== "running") {
      timeline.push({
        id: `${attempt.kind}_attempt_${attempt.status}:${attempt.id}`,
        type: attemptEventType(attempt, attempt.status),
        at: attempt.completedAt,
        runId: run.id,
        recordId: attempt.id,
        ...(attempt.stepId === null ? {} : { stepId: attempt.stepId }),
        attemptNumber: attempt.attemptNumber,
        ...(attempt.workerId === null ? {} : { workerId: attempt.workerId }),
        status: attempt.status,
        ...(attempt.error === null ? {} : { error: attempt.error })
      });
    }
  }

  for (const step of steps) {
    timeline.push({
      id: `step_created:${step.id}`,
      type: "step_created",
      at: step.createdAt,
      runId: run.id,
      recordId: step.id,
      stepId: step.stepId,
      status: "pending"
    });
    if (step.completedAt && (step.status === "completed" || step.status === "failed")) {
      timeline.push({
        id: `step_${step.status}:${step.id}`,
        type: step.status === "completed" ? "step_completed" : "step_failed",
        at: step.completedAt,
        runId: run.id,
        recordId: step.id,
        stepId: step.stepId,
        status: step.status,
        ...(step.error === null ? {} : { error: step.error })
      });
    }
  }

  for (const timer of timers) {
    timeline.push({
      id: `timer_scheduled:${timer.id}`,
      type: "timer_scheduled",
      at: timer.createdAt,
      runId: run.id,
      recordId: timer.id,
      stepId: timer.stepId,
      status: "pending",
      fireAt: timer.fireAt
    });
    if (timer.firedAt) {
      timeline.push({
        id: `timer_fired:${timer.id}`,
        type: "timer_fired",
        at: timer.firedAt,
        runId: run.id,
        recordId: timer.id,
        stepId: timer.stepId,
        status: "fired",
        fireAt: timer.fireAt
      });
    }
    if (timer.cancelledAt) {
      timeline.push({
        id: `timer_cancelled:${timer.id}`,
        type: "timer_cancelled",
        at: timer.cancelledAt,
        runId: run.id,
        recordId: timer.id,
        stepId: timer.stepId,
        status: "cancelled",
        fireAt: timer.fireAt
      });
    }
  }

  const runAttempts = attempts
    .filter((attempt) => attempt.kind === "run")
    .sort(
      (left, right) =>
        left.attemptNumber - right.attemptNumber ||
        left.startedAt.getTime() - right.startedAt.getTime() ||
        left.id.localeCompare(right.id)
    );
  const failedRunAttempts = runAttempts.filter((attempt) => FAILURE_STATUSES.has(attempt.status));
  let priorFailures = 0;
  for (let index = 1; index < runAttempts.length; index += 1) {
    const previous = runAttempts[index - 1]!;
    if (!FAILURE_STATUSES.has(previous.status)) continue;
    priorFailures += 1;
    const attempt = runAttempts[index]!;
    const manual = priorFailures >= run.maxAttempts;
    const type = manual ? "run_manual_retry_started" : "run_retry_started";
    timeline.push({
      id: `${type}:${attempt.id}`,
      type,
      at: attempt.startedAt,
      runId: run.id,
      recordId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      ...(attempt.workerId === null ? {} : { workerId: attempt.workerId }),
      status: "running"
    });
  }
  const lastRunAttempt = runAttempts.at(-1);
  if (run.status === "pending" && lastRunAttempt?.completedAt) {
    if (FAILURE_STATUSES.has(lastRunAttempt.status)) {
      const manual = failedRunAttempts.length >= run.maxAttempts;
      const type = manual ? "run_manual_retry_scheduled" : "run_retry_scheduled";
      timeline.push({
        id: `${type}:${run.id}:${run.updatedAt.toISOString()}`,
        type,
        at: run.updatedAt,
        runId: run.id,
        recordId: run.id,
        status: "pending",
        scheduledAt: run.scheduledAt
      });
    } else if (lastRunAttempt.status === "cancelled") {
      timeline.push({
        id: `run_released:${run.id}:${run.updatedAt.toISOString()}`,
        type: "run_released",
        at: run.updatedAt,
        runId: run.id,
        recordId: run.id,
        status: "pending",
        scheduledAt: run.scheduledAt
      });
    }
  }

  const terminalType = {
    completed: "run_completed",
    failed: "run_failed",
    dead_letter: "run_dead_letter",
    cancelled: "run_cancelled"
  } as const;
  if (run.status in terminalType) {
    const status = run.status as keyof typeof terminalType;
    const at = status === "cancelled" ? run.cancelledAt : run.completedAt;
    if (at) {
      timeline.push({
        id: `${terminalType[status]}:${run.id}`,
        type: terminalType[status],
        at,
        runId: run.id,
        recordId: run.id,
        status,
        ...(run.error === null ? {} : { error: run.error })
      });
    }
  }

  timeline.sort(
    (left, right) =>
      left.at.getTime() - right.at.getTime() ||
      EVENT_ORDER[left.type] - EVENT_ORDER[right.type] ||
      left.id.localeCompare(right.id)
  );

  const failedAttempts = failedRunAttempts.filter(({ status }) => status === "failed").length;
  const timedOutAttempts = failedRunAttempts.filter(({ status }) => status === "timed_out").length;
  const stalledAttempts = failedRunAttempts.filter(({ status }) => status === "stalled").length;
  const terminalFailure = run.status === "failed" || run.status === "dead_letter";
  const timerLagMs = timers.reduce(
    (maximum, timer) =>
      timer.status === "pending"
        ? Math.max(maximum, checkedAt.getTime() - timer.fireAt.getTime())
        : maximum,
    0
  );

  return {
    ...records,
    timeline,
    diagnostics: {
      failureCount: failedRunAttempts.length,
      failedAttempts,
      timedOutAttempts,
      stalledAttempts,
      retryCount: Math.max(0, failedRunAttempts.length - (terminalFailure ? 1 : 0)),
      leaseLossCount: stalledAttempts,
      hasExpiredLease:
        run.status === "running" &&
        run.lockedUntil !== null &&
        run.lockedUntil.getTime() <= checkedAt.getTime(),
      timerLagMs: Math.max(0, timerLagMs)
    }
  };
}
