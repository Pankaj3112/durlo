const workflowSleepSignals = new WeakSet<object>();
const lostLeaseSignals = new WeakSet<object>();

export function createWorkflowSleepSignal(message: string): Error {
  const signal = new Error(message);
  workflowSleepSignals.add(signal);
  return signal;
}

export function isWorkflowSleepSignal(error: unknown): boolean {
  return typeof error === "object" && error !== null && workflowSleepSignals.has(error);
}

export function createLostLeaseSignal(message: string): Error {
  const signal = new Error(message);
  lostLeaseSignals.add(signal);
  return signal;
}

export function isLostLeaseSignal(error: unknown): boolean {
  return typeof error === "object" && error !== null && lostLeaseSignals.has(error);
}
