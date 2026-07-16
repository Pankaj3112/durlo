import { LostLeaseError, ValidationError, WorkflowSleepError } from "./errors.js";
import { deserialize, serialize, serializeError } from "./serialization.js";
import type { ClaimedRun, DurloAdapter, StepTools } from "./types.js";
import { parseDuration, validateId } from "./validation.js";

export function createStepTools(adapter: DurloAdapter, run: ClaimedRun): StepTools {
  const seen = new Set<string>();
  let activeStepId: string | null = null;
  let insideStepCallback = false;

  const begin = (stepId: string): void => {
    validateId(stepId, "step id");
    if (activeStepId !== null) {
      if (insideStepCallback) throw new ValidationError("nested step calls are not allowed");
      throw new ValidationError(
        `workflow steps must be sequential; cannot start '${stepId}' while '${activeStepId}' is active`
      );
    }
    if (seen.has(stepId))
      throw new ValidationError(
        `step '${stepId}' was called more than once in this workflow execution`
      );
    seen.add(stepId);
    activeStepId = stepId;
  };

  const finish = (stepId: string): void => {
    if (activeStepId === stepId) activeStepId = null;
  };

  const ownership = { runId: run.id, workerId: run.lockedBy, leaseToken: run.leaseToken };

  return {
    async run<T>(stepId: string, fn: () => Promise<T> | T): Promise<T> {
      begin(stepId);
      try {
        if (await adapter.getTimer(run.id, stepId)) {
          throw new ValidationError(`step '${stepId}' is already used by a sleep`);
        }
        const existing = await adapter.getStep(run.id, stepId);
        if (existing?.status === "completed") return deserialize(existing.result!) as T;
        const step = await adapter.startStep({
          ...ownership,
          stepId,
          maxAttempts: run.maxAttempts
        });
        if (step.status === "completed") return deserialize(step.result!) as T;

        insideStepCallback = true;
        try {
          const result = await fn();
          insideStepCallback = false;
          await adapter.completeStep({
            ...ownership,
            stepId,
            result: serialize(result === undefined ? null : result)
          });
          return result;
        } catch (error) {
          insideStepCallback = false;
          try {
            await adapter.failStep({ ...ownership, stepId, error: serializeError(error) });
          } catch (writeError) {
            if (writeError instanceof LostLeaseError) throw writeError;
            throw writeError;
          }
          throw error;
        } finally {
          insideStepCallback = false;
        }
      } finally {
        finish(stepId);
      }
    },
    async sleep(stepId, duration): Promise<void> {
      begin(stepId);
      try {
        await sleepUntil(stepId, new Date(Date.now() + parseDuration(duration, "sleep duration")));
      } finally {
        finish(stepId);
      }
    },
    async sleepUntil(stepId, date): Promise<void> {
      begin(stepId);
      try {
        await sleepUntil(stepId, new Date(date));
      } finally {
        finish(stepId);
      }
    }
  };

  async function sleepUntil(stepId: string, fireAt: Date): Promise<void> {
    if (!Number.isFinite(fireAt.getTime()))
      throw new ValidationError("sleepUntil date must be valid");
    if (await adapter.getStep(run.id, stepId)) {
      throw new ValidationError(`step '${stepId}' is already used by step.run`);
    }
    const timer = await adapter.sleepRun({ ...ownership, stepId, fireAt });
    if (timer.status === "pending")
      throw new WorkflowSleepError(`workflow sleeping until ${timer.fireAt.toISOString()}`);
  }
}
