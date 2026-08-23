import { Durlo, RetryError } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

export const adapter = postgresAdapter({ connectionString: databaseUrl });
export const durlo = new Durlo({ id: "durlo-quickstart", adapter });

type OrderInput = {
  orderId: string;
};

type OrderOutput = {
  orderId: string;
  customerEmail: string;
  reservation: "confirmed";
  courier: { provider: string; bookingId: string };
};

export const recordOrderCreatedTask = durlo.task<OrderInput, { recorded: true }>({
  id: "record-order-created",
  run: async (input, { run }) => {
    await adapter.pool.query(
      `insert into quickstart_effects (run_id, effect_key, detail)
       values ($1, 'order-created', $2)
       on conflict (run_id, effect_key) do nothing`,
      [run.id, input.orderId]
    );
    return { recorded: true };
  }
});

export const orderWorkflow = durlo.workflow<OrderInput, OrderOutput>({
  id: "fulfill-order",
  retry: {
    attempts: 3,
    backoff: { type: "fixed", delay: "400ms", jitter: 0 }
  },
  run: async ({ input, run, step }) => {
    const order = await step.run("load-order", async () => {
      const result = await adapter.pool.query<{ id: string; customer_email: string }>(
        "select id, customer_email from quickstart_orders where id = $1",
        [input.orderId]
      );
      const row = result.rows[0];
      if (!row) throw new Error(`order '${input.orderId}' does not exist`);
      return { id: row.id, customerEmail: row.customer_email };
    });

    await step.run("reserve-inventory", async () => {
      await adapter.pool.query(
        `insert into quickstart_effects (run_id, effect_key, detail)
         values ($1, 'inventory-reserved', $2)
         on conflict (run_id, effect_key) do nothing`,
        [run.id, order.id]
      );
      return { reservation: `stock:${order.id}` };
    });

    if (process.env.DURLO_DEMO_PAUSE_AFTER_CHECKPOINT === "1") {
      process.stdout.write(`CRASH_READY runId=${run.id} pid=${process.pid}\n`);
      await new Promise<never>(() => undefined);
    }

    await step.sleep("packing-window", "1s");

    const courier = await step.run("book-courier", async () => {
      const result = await adapter.pool.query<{ attempt_count: number }>(
        `insert into quickstart_courier_attempts (run_id, attempt_count)
         values ($1, 1)
         on conflict (run_id) do update
           set attempt_count = quickstart_courier_attempts.attempt_count + 1
         returning attempt_count`,
        [run.id]
      );
      const attempt = result.rows[0]!.attempt_count;
      if (attempt === 1) {
        throw new RetryError({
          after: "400ms",
          message: "courier sandbox requested a retry"
        });
      }
      return { provider: "Parcel Kite", bookingId: `PK-${order.id.slice(0, 8)}` };
    });

    return {
      orderId: order.id,
      customerEmail: order.customerEmail,
      reservation: "confirmed",
      courier
    };
  }
});
