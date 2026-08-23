type DefinitionRegistration = {
  run: (...args: never[]) => Promise<unknown>;
};

type OutcomeConstructor = {
  readonly prototype: object;
};

type PrivateRegistry = {
  readonly taskRegistrations: WeakMap<object, DefinitionRegistration>;
  readonly workflowRegistrations: WeakMap<object, DefinitionRegistration>;
  readonly permanentErrors: WeakMap<object, OutcomeConstructor>;
  readonly retryErrors: WeakMap<object, OutcomeConstructor>;
};

const PRIVATE_REGISTRY = Symbol.for("@durlo/core/private-registry/v1");
const sharedScope = globalThis as typeof globalThis & {
  [PRIVATE_REGISTRY]?: PrivateRegistry;
};

export const privateRegistry =
  sharedScope[PRIVATE_REGISTRY] ??
  (sharedScope[PRIVATE_REGISTRY] = {
    taskRegistrations: new WeakMap(),
    workflowRegistrations: new WeakMap(),
    permanentErrors: new WeakMap(),
    retryErrors: new WeakMap()
  });
