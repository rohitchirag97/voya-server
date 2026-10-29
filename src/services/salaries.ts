import { and, eq, inArray, sql } from "drizzle-orm";
import { db, isUniqueViolation } from "../db";
import { agencies, hostMonths, salaryLines, salaryRuns, users, walletAccounts, walletLedger, type User } from "../db/schema";
import { AppError } from "../lib/errors";
import { AGENCY_SHARE, COIN_LEVELS, RUPEES_PER_DIAMOND, standing } from "../lib/salaryLevels";
import { creditCash } from "./cash";
import { poolsOf } from "./hostMonth";
import { userSummary } from "./rooms";

// Monthly salaries. Staff open a finished month's sheet, check it, and pay it. Each host gets their level's salary minus
// what they converted from that month's pool (₹0.05 a diamond): levels 1-2 as coins, higher as cash. The rest of the
// pool lapses. Each owner gets 10% of their hosts' full level salaries, as cash. Paying is safe to repeat: every line is
// written once, so a run that stopped halfway picks up where it left off.

const PAISE_PER_COIN = 10; // ₹0.10
const PAISE_PER_DIAMOND = Math.round(RUPEES_PER_DIAMOND * 100); // 5

const IST_MONTH = sql<string>`to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM')`;
const day1 = (month: string) => `${month}-01`;

function hostPay(level: number, salaryRupees: number, converted: number) {
  const grossPaise = salaryRupees * 100;
  const payPaise = Math.max(0, grossPaise - converted * PAISE_PER_DIAMOND);
  return { grossPaise, payPaise, paidIn: level === 0 ? "NONE" : level <= COIN_LEVELS ? "COINS" : "CASH" };
}

async function isOver(month: string) {
  const [r] = (await db.execute<{ now: string }>(sql`select ${IST_MONTH} as now`)).rows;
  return month < r!.now;
}

// The sheet for a month: every host pool with what it pays, and each agency owner's bonus. Paid lines are marked.
export async function salarySheet(month: string) {
  const [pools, paid, [run], owners] = await Promise.all([
    poolsOf(sql`${day1(month)}::date`, { pool: sql`true`, mic: sql`true` }),
    db.select().from(salaryLines).where(eq(salaryLines.month, day1(month))),
    db.select().from(salaryRuns).where(eq(salaryRuns.month, day1(month))),
    db.select({ agencyId: agencies.id, name: agencies.name, code: agencies.code, ownerId: agencies.ownerId }).from(agencies),
  ]);
  const ids = [...new Set([...pools.map((p) => p.userId), ...owners.map((o) => o.ownerId)])];
  const people = new Map((ids.length ? await db.select({ ...userSummary, publicId: users.publicId }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.userId, u]));
  const agencyOf = new Map(owners.map((o) => [o.agencyId, o]));
  const done = new Map(paid.map((l) => [`${l.kind}|${l.userId}|${l.agencyId}`, l]));

  const hosts = pools
    .filter((p) => p.diamonds > 0)
    .map((p) => {
      const line = done.get(`HOST|${p.userId}|${p.agencyId}`);
      return {
        user: people.get(p.userId)!,
        agency: agencyOf.get(p.agencyId)!,
        level: line?.level ?? p.level,
        diamonds: p.diamonds,
        micMinutes: p.micMinutes,
        converted: line?.convertedDiamonds ?? p.converted,
        ...(line ? { grossPaise: line.grossPaise, payPaise: line.payPaise, paidIn: line.paidIn } : hostPay(p.level, p.salary, p.converted)),
        paid: !!line,
      };
    })
    .sort((a, b) => b.diamonds - a.diamonds);

  const byAgency = new Map<string, number>();
  for (const h of hosts) byAgency.set(h.agency.agencyId, (byAgency.get(h.agency.agencyId) ?? 0) + h.grossPaise);
  const ownerLines = [...byAgency].map(([agencyId, gross]) => {
    const a = agencyOf.get(agencyId)!;
    const line = done.get(`OWNER|${a.ownerId}|${agencyId}`);
    return { user: people.get(a.ownerId)!, agency: a, payPaise: line?.payPaise ?? Math.round(gross * AGENCY_SHARE), paid: !!line };
  });

  return { month, over: await isOver(month), run: run ?? null, hosts, owners: ownerLines };
}

export async function payMonth(staff: User, month: string) {
  if (!(await isOver(month))) throw new AppError("MONTH_NOT_OVER", 409, "This month isn't over yet");
  const [run] = await db.insert(salaryRuns).values({ month: day1(month), startedBy: staff.id }).onConflictDoNothing().returning();
  const [existing] = run ? [run] : await db.select().from(salaryRuns).where(eq(salaryRuns.month, day1(month)));
  if (existing?.finishedAt) throw new AppError("ALREADY_PAID", 409, "This month was already paid");

  const pools = await poolsOf(sql`${day1(month)}::date`, { pool: sql`settled_at is null`, mic: sql`true` });
  for (const p of pools) {
    if (p.diamonds <= 0) continue; // mic time alone reaches no level
    await db.transaction(async (tx) => {
      // Lock order as in conversions: coin wallet, then the pool.
      await tx.select({ id: walletAccounts.userId }).from(walletAccounts).where(eq(walletAccounts.userId, p.userId)).for("update");
      const key = and(eq(hostMonths.userId, p.userId), eq(hostMonths.agencyId, p.agencyId), eq(hostMonths.month, day1(month)));
      const [pool] = await tx.select().from(hostMonths).where(key).for("update");
      if (!pool || pool.settledAt) return;
      const s = standing(pool.earned, p.micMinutes);
      const pay = hostPay(s.level, s.salary, pool.converted);
      const [line] = await tx
        .insert(salaryLines)
        .values({ month: day1(month), userId: p.userId, agencyId: p.agencyId, kind: "HOST", level: s.level, diamonds: pool.earned, micMinutes: p.micMinutes, convertedDiamonds: pool.converted, ...pay })
        .returning();
      if (pay.payPaise > 0 && pay.paidIn === "COINS") {
        const coins = Math.floor(pay.payPaise / PAISE_PER_COIN);
        await tx.update(walletAccounts).set({ balance: sql`${walletAccounts.balance} + ${coins}`, version: sql`${walletAccounts.version} + 1` }).where(eq(walletAccounts.userId, p.userId));
        await tx.insert(walletLedger).values({ userId: p.userId, entryType: "SALARY", amount: coins, referenceType: "SALARY_LINE", referenceId: String(line!.id) });
      }
      if (pay.payPaise > 0 && pay.paidIn === "CASH") await creditCash(tx, p.userId, pay.payPaise, "SALARY", "SALARY_LINE", String(line!.id));
      await tx.update(hostMonths).set({ settledAt: new Date() }).where(key);
    });
  }

  // Owner bonuses from the host lines now on record (also those paid by an earlier, interrupted run).
  const { rows } = await db.execute<{ agency_id: string; owner_id: string; gross: number }>(sql`
    select l.agency_id, a.owner_id, sum(l.gross_paise)::int as gross from ${salaryLines} l join ${agencies} a on a.id = l.agency_id
    where l.month = ${day1(month)} and l.kind = 'HOST' group by l.agency_id, a.owner_id`);
  for (const r of rows) {
    const payPaise = Math.round(Number(r.gross) * AGENCY_SHARE);
    try {
      await db.transaction(async (tx) => {
        const [line] = await tx
          .insert(salaryLines)
          .values({ month: day1(month), userId: r.owner_id, agencyId: r.agency_id, kind: "OWNER", level: 0, diamonds: 0, micMinutes: 0, grossPaise: payPaise, convertedDiamonds: 0, payPaise, paidIn: "CASH" })
          .returning();
        if (payPaise > 0) await creditCash(tx, r.owner_id, payPaise, "AGENCY_BONUS", "SALARY_LINE", String(line!.id));
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // already paid by an earlier run
    }
  }
  await db.update(salaryRuns).set({ finishedAt: new Date() }).where(eq(salaryRuns.month, day1(month)));
  return salarySheet(month);
}
