import { describe, expect, test } from "bun:test";
import { dealRoles, DAY_MS, lobbyState, nightAct, privateView, publicView, removePlayer, RuleError, SKIP, startGame, timeout, vote, type MafiaState, type Role } from "../src/lib/mafia";

// Pure rules: no server, no database.
const T0 = 1_000_000;
const people = ["m", "d", "x", "v1", "v2", "v3"].map((userId) => ({ userId, displayName: userId, avatarUrl: null }));
// A fixed deal: m Mafia, d Doctor, x Detective, the rest Villagers.
const ROLES: Record<string, Role> = { m: "MAFIA", d: "DOCTOR", x: "DETECTIVE", v1: "VILLAGER", v2: "VILLAGER", v3: "VILLAGER" };
const game = (): MafiaState => ({ ...startGame(lobbyState(), people, T0), roles: ROLES });
const isAlive = (s: MafiaState, id: string) => s.players.find((p) => p.userId === id)!.alive;
const night = (s: MafiaState, kill: string, save: string, check: string) => nightAct(nightAct(nightAct(s, "m", kill, T0), "d", save, T0), "x", check, T0);
const dayVotes = (s: MafiaState, votes: Record<string, string>) => Object.entries(votes).reduce((st, [who, t]) => vote(st, who, t, T0), s);

describe("mafia", () => {
  test("deal: 1 Mafia per 4 players, one Doctor and one Detective", () => {
    const count = (n: number, r: Role) => dealRoles(n, Math.random).filter((x) => x === r).length;
    expect(count(5, "MAFIA")).toBe(1);
    expect(count(8, "MAFIA")).toBe(2);
    expect(count(12, "MAFIA")).toBe(3);
    expect(count(12, "DOCTOR")).toBe(1);
    expect(count(12, "DETECTIVE")).toBe(1);
    expect(dealRoles(7, Math.random).length).toBe(7);
  });

  test("roles stay secret: the public view shows none until someone dies, each player sees only their own", () => {
    const s = game();
    expect(publicView(s)!.roles).toEqual({});
    expect(JSON.stringify(publicView(s))).not.toContain("MAFIA");
    expect(privateView(s, "v1")).toEqual({ role: "VILLAGER" });
    expect(privateView(s, "m")).toMatchObject({ role: "MAFIA", team: ["m"] });
    expect(privateView(s, "listener")).toBeNull();
  });

  test("night: the victim dies, the detective learns the truth, then it's day", () => {
    const s = night(game(), "v1", "v2", "m");
    expect(s.phase).toBe("day");
    expect(isAlive(s, "v1")).toBe(false);
    expect(s.last).toEqual({ kind: "night", killed: "v1", saved: false });
    expect(publicView(s)!.roles).toEqual({ v1: "VILLAGER" });
    expect(privateView(s, "x")).toMatchObject({ checks: [{ target: "m", mafia: true }] });
  });

  test("the doctor's save cancels the kill", () => {
    const s = night(game(), "v1", "v1", "v2");
    expect(s.players.every((p) => p.alive)).toBe(true);
    expect(s.last).toEqual({ kind: "night", killed: null, saved: true });
  });

  test("illegal picks are refused", () => {
    const s = game();
    expect(() => nightAct(s, "v1", "m", T0)).toThrow(RuleError); // villagers sleep
    expect(() => nightAct(s, "m", "m", T0)).toThrow(RuleError); // own team
    expect(() => nightAct(s, "x", "x", T0)).toThrow(RuleError); // check yourself
    expect(() => vote(s, "v1", "m", T0)).toThrow(RuleError); // not day
  });

  test("day: the most votes is out; a tie or more skips keeps everyone", () => {
    const day = night(game(), "v1", "v1", "v2"); // nobody died: 6 alive
    const out = dayVotes(day, { m: "v2", d: "m", x: "m", v1: "m", v2: "m", v3: SKIP });
    expect(isAlive(out, "m")).toBe(false);
    expect(out.phase).toBe("finished");
    expect(out.winner).toBe("TOWN");
    expect(publicView(out)!.roles).toEqual(ROLES); // all shown at the end
    const tie = dayVotes(day, { m: "v2", d: "v2", x: "m", v1: "m", v2: SKIP, v3: SKIP });
    expect(tie.players.every((p) => p.alive)).toBe(true);
    expect(tie.phase).toBe("night");
    expect(tie.day).toBe(2);
  });

  test("mafia win once they are half of the living", () => {
    let s = game();
    for (const id of ["v1", "v2", "v3", "d"]) s = removePlayer(s, id, T0);
    expect(s.phase).toBe("finished");
    expect(s.winner).toBe("MAFIA"); // m vs x
  });

  test("time running out resolves the phase with the picks made so far", () => {
    const s = nightAct(game(), "m", "v3", T0);
    const day = timeout(s, T0 + 1);
    expect(isAlive(day, "v3")).toBe(false);
    expect(Date.parse(day.deadline!)).toBe(T0 + 1 + DAY_MS);
    expect(timeout(day, T0 + 2).phase).toBe("night"); // no votes: nobody out
  });

  test("someone leaving drops their picks, and the night ends if they were the last to act", () => {
    let s = nightAct(nightAct(game(), "m", "v1", T0), "d", "v2", T0); // the Detective hasn't checked yet
    s = removePlayer(s, "x", T0);
    expect(s.phase).toBe("day");
    expect(isAlive(s, "v1")).toBe(false);
  });
});
