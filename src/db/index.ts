import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config";
import * as schema from "./schema";

export const db = drizzle(config.databaseUrl, { schema });
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// drizzle wraps driver errors; the pg error code sits on `cause`.
export const pgCode = (e: unknown): string | undefined => (e as any)?.code ?? (e as any)?.cause?.code;
export const isUniqueViolation = (e: unknown) => pgCode(e) === "23505";
