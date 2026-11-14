import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";

export class AppError extends Error {
  constructor(
    public code: string,
    public status: ContentfulStatusCode = 400,
    message?: string,
    public data?: Record<string, unknown>, // extra details for the app, e.g. a ban's reason and end time
  ) {
    super(message ?? code);
  }
}

// Safe for clients: never includes stacks or internals.
export function toSafeError(e: unknown): { status: ContentfulStatusCode; code: string; message: string; data?: Record<string, unknown> } {
  if (e instanceof AppError) return { status: e.status, code: e.code, message: e.message, data: e.data };
  if (e instanceof z.ZodError) return { status: 400, code: "VALIDATION_ERROR", message: z.prettifyError(e) };
  // Postgres "numeric value out of range": a balance would pass what its column holds (about 214 crore coins).
  if (((e as any)?.code ?? (e as any)?.cause?.code) === "22003") return { status: 409, code: "AMOUNT_TOO_LARGE", message: "That's more coins than a wallet can hold" };
  console.error(JSON.stringify({ level: "error", msg: String(e), stack: (e as Error)?.stack }));
  return { status: 500, code: "INTERNAL", message: "Internal error" };
}
