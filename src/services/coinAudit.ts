import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { findUserByRef } from "./auth";

// Coin audit (admin panel > Coin audit). Two books hold coins: user wallets (wallet_ledger) and coin-seller wallets
// (seller_ledger). The database guarantees each wallet's balance equals the sum of its ledger rows and that ledger rows
// are never changed (migration 0083); this reads them for staff, filtered, with a CSV export.

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const ledgerQuery = z.object({
  book: z.enum(["wallet", "seller"]).default("wallet"),
  user: z.string().trim().min(1).max(60).optional(), // user id, profile ID, Special ID or exact name
  type: z.string().trim().max(40).optional(),
  from: day.optional(), // India dates, both days included
  to: day.optional(),
  before: z.coerce.number().int().positive().optional(), // page: rows with a smaller id
  format: z.enum(["json", "csv"]).default("json"),
});
type Q = z.infer<typeof ledgerQuery>;
const PAGE = 100;
const CSV_MAX = 100_000;

// One shape for both books. Seller rows: reference = who was on the other side and who did it.
function rowsQuery(q: Q & { userId?: string }, limit?: number) {
  const seller = q.book === "seller";
  const t = sql.raw(seller ? "seller_ledger" : "wallet_ledger");
  const who = sql.raw(seller ? "l.seller_id" : "l.user_id");
  const type = sql.raw(seller ? "l.kind" : "l.entry_type");
  const ref = seller
    ? sql`concat_ws(' ', 'counterparty:' || l.counterparty_id::text, 'by:' || l.actor_id::text)`
    : sql`l.reference_type || ':' || l.reference_id`;
  const where = [
    sql`true`,
    ...(q.userId ? [sql`${who} = ${q.userId}`] : []),
    ...(q.type ? [sql`${type} = ${q.type}`] : []),
    ...(q.from ? [sql`l.created_at >= (${q.from}::date::timestamp at time zone 'Asia/Kolkata')`] : []),
    ...(q.to ? [sql`l.created_at < ((${q.to}::date + 1)::timestamp at time zone 'Asia/Kolkata')`] : []),
    ...(q.before ? [sql`l.id < ${q.before}`] : []),
  ];
  return sql`select l.id, l.created_at, ${who}::text as user_id, u.public_id, u.display_name, ${type} as type, l.amount, l.balance_after, ${ref} as reference
    from ${t} l join users u on u.id = ${who}
    where ${sql.join(where, sql` and `)}
    order by l.id desc${limit ? sql` limit ${limit}` : sql``}`;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The `user` filter as a user id (looked up when it's a profile ID, Special ID or name).
const withUser = async (q: Q) => ({ ...q, userId: !q.user ? undefined : UUID.test(q.user) ? q.user : (await findUserByRef(q.user)).id });

type Row = { id: string; created_at: string; user_id: string; public_id: string; display_name: string | null; type: string; amount: number; balance_after: string | null; reference: string };
const shape = (r: Row, book: string) => ({
  txnId: `${book === "seller" ? "STX" : "TXN"}${r.id}`,
  id: Number(r.id),
  at: new Date(r.created_at).toISOString(),
  userId: r.user_id,
  publicId: Number(r.public_id),
  displayName: r.display_name,
  type: r.type,
  amount: Number(r.amount),
  balanceAfter: r.balance_after === null ? null : Number(r.balance_after),
  reference: r.reference,
});

// Books check: every wallet's balance against its own ledger, and the totals. mismatched should always be 0.
async function check() {
  const { rows: [r] } = await db.execute<Record<string, string>>(sql`select
    (select count(*) from wallet_accounts w where w.balance <> coalesce((select sum(amount) from wallet_ledger l where l.user_id = w.user_id), 0)) as wm,
    (select coalesce(sum(balance), 0) from wallet_accounts) as wb, (select coalesce(sum(amount), 0) from wallet_ledger) as wl,
    (select count(*) from coin_sellers s where s.balance <> coalesce((select sum(amount) from seller_ledger l where l.seller_id = s.user_id), 0)) as sm,
    (select coalesce(sum(balance), 0) from coin_sellers) as sb, (select coalesce(sum(amount), 0) from seller_ledger) as sl`);
  const n = (k: string) => Number(r![k]);
  return { wallets: { mismatched: n("wm"), balances: n("wb"), ledger: n("wl") }, sellers: { mismatched: n("sm"), balances: n("sb"), ledger: n("sl") } };
}

// Coins in and out by type for the same filters (without paging).
async function totals(q: Q & { userId?: string }) {
  const { rows } = await db.execute<{ type: string; n: string; coins_in: string; coins_out: string }>(sql`select type, count(*) as n,
      coalesce(sum(amount) filter (where amount > 0), 0) as coins_in, coalesce(-sum(amount) filter (where amount < 0), 0) as coins_out
    from (${rowsQuery({ ...q, before: undefined })}) x group by type order by type`);
  return rows.map((r) => ({ type: r.type, count: Number(r.n), coinsIn: Number(r.coins_in), coinsOut: Number(r.coins_out) }));
}

export async function coinLedger(query: Q) {
  const q = await withUser(query);
  const { rows } = await db.execute<Row>(rowsQuery(q, PAGE));
  const out = rows.map((r) => shape(r, q.book));
  return { rows: out, nextBefore: out.length === PAGE ? out.at(-1)!.id : null, totals: await totals(q), check: await check() };
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s; // a name can't run as a spreadsheet formula
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};
// shortcut: up to CSV_MAX rows in one file, newest first; narrow the dates for more, or stream it if audits outgrow this.
export async function coinLedgerCsv(query: Q) {
  const q = await withUser(query);
  const { rows } = await db.execute<Row>(rowsQuery({ ...q, before: undefined }, CSV_MAX));
  const head = "txn_id,time_utc,book,user_id,public_id,name,type,amount,balance_after,reference";
  const lines = rows.map((r) => {
    const x = shape(r, q.book);
    return [x.txnId, x.at, q.book, x.userId, x.publicId, x.displayName, x.type, x.amount, x.balanceAfter, x.reference].map(cell).join(",");
  });
  return [head, ...lines].join("\n") + "\n";
}
