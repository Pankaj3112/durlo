import { LostLeaseError, ValidationError } from "./errors.js";
import { deserialize, serialize, serializeError } from "./serialization.js";
import type { ClaimedRun, DurloAdapter, StepTools } from "./types.js";
import { validateId } from "./validation.js";

export function createStepTools(adapter: DurloAdapter, run: ClaimedRun): StepTools {
  const seen = new Set<string>();
  let insideStep = false;

  const begin = (stepId: string): void => {
    validateId(stepId, "step id");
    if (insideStep) throw new ValidationError("nested step calls are not allowed");
    if (seen.has(stepId)) throw new ValidationError(`step '${stepId}' was called more than once in this workflow execution`);
    seen.add(stepId);
  };

  const ownership = { runId: run.id, workerId: run.lockedBy, leaseToken: run.leaseToken };

  return {
    async run<T>(stepId: string, fn: () => Promise<T> | T): Promise<T> {
      begin(stepId);
      const existing = await adapter.getStep(run.id, stepId);
      if (existing?.status === "completed") return deserialize(existing.result!) as T;
      const step = await adapter.startStep({ ...ownership, stepId, maxAttempts: run.maxAttempts });
      if (step.status === "completed") return deserialize(step.result!) as T;

      insideStep = true;
      try {
        const result = await fn();
        insideStep = false;
        await adapter.completeStep({
          ...ownership,
          stepId,
          result: serialize(result === undefined ? null : result),
        });
        return result;
      } catch (error) {
        insideStep = false;
        try {
          await adapter.failStep({ ...ownership, stepId, error: serializeError(error) });
        } catch (writeError) {
          if (writeError instanceof LostLeaseError) throw writeError;
          throw writeError;
        }
        throw error;
      } finally {
        insideStep = false;
      }
    },
    async sleep(stepId): Promise<void> {
      begin(stepId);
      throw new Error("step.sleep is implemented in Slice 6");
    },
    async sleepUntil(stepId): Promise<void> {
      begin(stepId);
      throw new Error("step.sleepUntil is implemented in Slice 6");
    },
  };
}
