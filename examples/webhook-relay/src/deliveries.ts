import { RunStateError } from "@durlo/core";
import { adapter, deliverWebhook, durlo } from "./durlo.js";
import type { WebhookDeliveryInput } from "./input.js";

export type DeliveryRow = {
  id: string;
  run_id: string;
  destination_url: string;
  payload: unknown;
  status: string;
  response_status: number | null;
  response_body: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  delivered_at: Date | null;
};

export async function enqueueDelivery(input: WebhookDeliveryInput) {
  return durlo.transaction(async (transaction) => {
    const inserted = await transaction.client.query(
      `insert into webhook_relay_deliveries (id, destination_url, payload, status)
       values ($1, $2, $3::jsonb, 'queued')
       on conflict (id) do nothing`,
      [input.deliveryId, input.destinationUrl, JSON.stringify(input.payload)]
    );

    if (inserted.rowCount === 0) {
      const matching = await transaction.client.query(
        `select 1 from webhook_relay_deliveries
         where id = $1 and destination_url = $2 and payload = $3::jsonb`,
        [input.deliveryId, input.destinationUrl, JSON.stringify(input.payload)]
      );
      if (matching.rowCount !== 1) {
        throw new RunStateError(`deliveryId '${input.deliveryId}' already has different input`);
      }
    }

    const handle = await transaction.enqueue(deliverWebhook, input, {
      idempotencyKey: `delivery:${input.deliveryId}`
    });
    const linked = await transaction.client.query(
      `update webhook_relay_deliveries
       set run_id = coalesce(run_id, $2), updated_at = now()
       where id = $1 and (run_id is null or run_id = $2)`,
      [input.deliveryId, handle.run.id]
    );
    if (linked.rowCount !== 1) {
      throw new Error(
        `delivery '${input.deliveryId}' could not be linked to run '${handle.run.id}'`
      );
    }
    return handle;
  });
}

export async function getDelivery(deliveryId: string) {
  const result = await adapter.pool.query<DeliveryRow>(
    `select id, run_id, destination_url, payload, status, response_status, response_body,
            attempt_count, last_error, created_at, updated_at, delivered_at
     from webhook_relay_deliveries where id = $1`,
    [deliveryId]
  );
  const delivery = result.rows[0];
  if (!delivery) return null;
  const run = await durlo.runs.getDetails(delivery.run_id);
  return { delivery, run };
}

export async function cancelDelivery(deliveryId: string) {
  const current = await getDelivery(deliveryId);
  if (!current) return null;
  const run = await durlo.runs.cancel(current.delivery.run_id);
  await adapter.pool.query(
    `update webhook_relay_deliveries
     set status = 'cancelled', updated_at = now()
     where id = $1 and status <> 'delivered'`,
    [deliveryId]
  );
  return run;
}

export async function retryDelivery(deliveryId: string) {
  const current = await getDelivery(deliveryId);
  if (!current) return null;
  const run = await durlo.runs.retry(current.delivery.run_id);
  await adapter.pool.query(
    `update webhook_relay_deliveries
     set status = 'queued', last_error = null, updated_at = now()
     where id = $1`,
    [deliveryId]
  );
  return run;
}
