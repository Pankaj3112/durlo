import { createHash } from "node:crypto";
import type { StandardSchema } from "@durlo/core";

export type CatalogRow = {
  sku: string;
  name: string;
  priceCents: number;
};

export type CatalogImportRequest = {
  importId: string;
  rows: CatalogRow[];
};

export type CatalogWorkflowInput = {
  importId: string;
  publicationDelayMs: number;
};

const IMPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const SKU = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

type Issue = { issues: [{ message: string }] };

function issue(message: string): Issue {
  return { issues: [{ message }] };
}

export function parseImportRequest(
  value: unknown
): { value: CatalogImportRequest; contentHash: string } | Issue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return issue("request body must be a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.importId !== "string" || !IMPORT_ID.test(candidate.importId)) {
    return issue("importId must be 1-100 URL-safe characters");
  }
  if (
    !Array.isArray(candidate.rows) ||
    candidate.rows.length < 1 ||
    candidate.rows.length > 1_000
  ) {
    return issue("rows must contain between 1 and 1000 products");
  }

  const rows: CatalogRow[] = [];
  const skus = new Set<string>();
  for (const [index, raw] of candidate.rows.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return issue(`rows[${index}] must be an object`);
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.sku !== "string" || !SKU.test(row.sku)) {
      return issue(`rows[${index}].sku must be 1-100 URL-safe characters`);
    }
    if (skus.has(row.sku)) return issue(`rows contains duplicate sku '${row.sku}'`);
    skus.add(row.sku);
    if (typeof row.name !== "string" || row.name.trim().length < 1 || row.name.length > 200) {
      return issue(`rows[${index}].name must be 1-200 characters`);
    }
    if (
      typeof row.priceCents !== "number" ||
      !Number.isInteger(row.priceCents) ||
      row.priceCents < 0 ||
      row.priceCents > 100_000_000
    ) {
      return issue(`rows[${index}].priceCents must be an integer from 0 to 100000000`);
    }
    rows.push({ sku: row.sku, name: row.name.trim(), priceCents: row.priceCents });
  }

  const normalized = { importId: candidate.importId, rows };
  return {
    value: normalized,
    contentHash: createHash("sha256").update(JSON.stringify(normalized)).digest("hex")
  };
}

function parseWorkflowInput(value: unknown): { value: CatalogWorkflowInput } | Issue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return issue("workflow input must be an object");
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.importId !== "string" || !IMPORT_ID.test(candidate.importId)) {
    return issue("workflow importId is invalid");
  }
  if (
    typeof candidate.publicationDelayMs !== "number" ||
    !Number.isInteger(candidate.publicationDelayMs) ||
    candidate.publicationDelayMs < 100 ||
    candidate.publicationDelayMs > 86_400_000
  ) {
    return issue("workflow publicationDelayMs must be an integer from 100 to 86400000");
  }
  return {
    value: {
      importId: candidate.importId,
      publicationDelayMs: candidate.publicationDelayMs
    }
  };
}

export const catalogWorkflowSchema: StandardSchema<CatalogWorkflowInput> = {
  "~standard": {
    version: 1,
    vendor: "durlo-catalog-import",
    validate: parseWorkflowInput
  }
};
