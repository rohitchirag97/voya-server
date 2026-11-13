import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";

// What the games took in and paid out, from the wallet ledger (the record of every coin moved), per period and game.
// Profit = bet − paid. Days are India days. A bet and its win can land on either side of midnight; over a range it evens out.
export const profitQuery = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    group: z.enum(["day", "week", "month", "year"]).default("day"),
  })
  .refine((q) => q.from <= q.to, { message: "Start date must be on or before end date" });

export type ProfitRow = { period: string; game: "jungle" | "galaxy" | "rocket" | "slot" | "roulette"; bet: number; paid: number };

export async function gameProfit({ from, to, group }: z.infer<typeof profitQuery>) {
  const tz = "Asia/Kolkata";
  const { rows } = await db.execute<ProfitRow>(sql`
    select to_char(date_trunc(${group}, l.created_at at time zone ${tz}), 'YYYY-MM-DD') as period,
      case l.reference_type when 'ROCKET_ROUND' then 'rocket' when 'SLOT_SPIN' then 'slot' when 'ROULETTE_SPIN' then 'roulette' else r.game end as game,
      coalesce(sum(-l.amount) filter (where l.entry_type in ('GREEDY_BET', 'ROCKET_BET', 'SLOT_BET', 'ROULETTE_BET')), 0)::float8 as bet,
      coalesce(sum(l.amount) filter (where l.entry_type in ('GREEDY_WIN', 'ROCKET_WIN', 'SLOT_WIN', 'ROULETTE_WIN')), 0)::float8 as paid
    from wallet_ledger l
    left join greedy_rounds r on l.reference_type = 'GREEDY_ROUND' and r.id::text = l.reference_id
    where l.entry_type in ('GREEDY_BET', 'GREEDY_WIN', 'ROCKET_BET', 'ROCKET_WIN', 'SLOT_BET', 'SLOT_WIN', 'ROULETTE_BET', 'ROULETTE_WIN')
      and l.created_at >= (${from}::date)::timestamp at time zone ${tz}
      and l.created_at < (${to}::date + 1)::timestamp at time zone ${tz}
    group by 1, 2
    order by 1 desc, 2`);
  return { from, to, group, rows };
}
