import { Durlo } from "@durlo/core";
import { postgresAdapter } from "@durlo/postgres";
import { config, assertAllowedDestination } from "./config.js";
import { webhookDeliverySchema } from "./input.js";

export const adapter = postgresAdapter({ connectionString: config.databaseUrl });
export const durlo = new Durlo({ id: "webhook-relay", adapter });

export const deliverWebhook = durlo.task({
  id: "deliver-webhook",
  version: "1",
  schema: webhookDeliverySchema,
  retry: {
    attempts: 5,
    backoff: { type: "exponential", delay: "1s", factor: 2, maxDelay: "1m", jitter: 0.2 }
  },
  timeout: "30s",
  run: async (input, { run, attempt, signal }) => {
    const destination = assertAllowedDestination(input.destinationUrl);
    await adapter.pool.query(
      `update webhook_relay_deliveries
       set status = 'delivering', attempt_count = greatest(attempt_count, $2),
           last_error = null, updated_at = now()
       where id = $1 and status in ('queued', 'delivering', 'retrying')`,
      [input.deliveryId, attempt.number]
    );

    try {
      const response = await fetch(destination, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": input.deliveryId,
          "User-Agent": "durlo-webhook-relay/1",
          "X-Durlo-Run-Id": run.id
        },
        body: JSON.stringify(input.payload),
        signal
      });
      const responseText = (await response.text()).slice(0, 1_000);
      if (!response.ok) {
        throw new Error(
          `destination returned HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`
        );
      }

      const deliveredAt = new Date().toISOString();
      await adapter.pool.query(
        `update webhook_relay_deliveries
         set status = 'delivered', response_status = $2, response_body = $3,
             delivered_at = $4, updated_at = now()
         where id = $1`,
        [input.deliveryId, response.status, responseText, deliveredAt]
      );
      return { statusCode: response.status, deliveredAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await adapter.pool.query(
        `update webhook_relay_deliveries
         set status = 'retrying', last_error = $2, updated_at = now()
         where id = $1 and status in ('queued', 'delivering', 'retrying')`,
        [input.deliveryId, message.slice(0, 1_000)]
      );
      throw error;
    }
  }
});
