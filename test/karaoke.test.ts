import { describe, expect, test } from "bun:test";
import { add, dropUnseated, emptyState, finish, hasParts, joinDuet, leaveDuet, lrcTimes, PER_PERSON, playNext, READY_MS, remove, RuleError, SLACK_MS, started, timeout, type Entry } from "../src/lib/karaoke";
import { audioExt } from "../src/routes/posts";

// Pure rules: no server, no database.
const T0 = 1_000_000;
let n = 0;
const entry = (userId: string, duet = false): Entry => ({ id: `e${++n}`, userId, displayName: userId, avatarUrl: null, songId: "s", title: "Song", artist: "", cover: null, durationMs: 200_000, duet, partner: null });
const person = (userId: string) => ({ userId, displayName: userId, avatarUrl: null });

describe("karaoke queue", () => {
  test("the first song starts a turn at once; later ones wait", () => {
    let s = add(emptyState(), entry("a"), T0);
    expect(s.current?.userId).toBe("a");
    expect(s.current?.startedAt).toBeNull();
    expect(Date.parse(s.current!.deadline)).toBe(T0 + READY_MS);
    s = add(s, entry("b"), T0);
    expect(s.queue.map((q) => q.userId)).toEqual(["b"]);
  });

  test("starting sets the deadline to the song's length plus slack; done passes the turn on", () => {
    let s = add(add(emptyState(), entry("a"), T0), entry("b"), T0);
    const id = s.current!.id;
    expect(() => started(s, "b", id, T0)).toThrow(RuleError);
    s = started(s, "a", id, T0 + 5000);
    expect(Date.parse(s.current!.deadline)).toBe(T0 + 5000 + 200_000 + SLACK_MS);
    s = finish(s, "a", id, T0 + 210_000);
    expect(s.current?.userId).toBe("b");
    expect(finish(s, "a", id, T0)).toBe(s); // a late "done" for the old song does nothing
  });

  test("only the singer skips, unless forced by an admin", () => {
    const s = add(emptyState(), entry("a"), T0);
    expect(() => finish(s, "b", s.current!.id, T0)).toThrow(RuleError);
    expect(finish(s, "b", s.current!.id, T0, true).current).toBeNull();
  });

  test("a turn that never starts, or runs far over, times out", () => {
    const s = add(add(emptyState(), entry("a"), T0), entry("b"), T0);
    expect(timeout(s, T0 + READY_MS - 1)).toBe(s);
    expect(timeout(s, T0 + READY_MS).current?.userId).toBe("b");
  });

  test("queue limits and removing songs", () => {
    let s = add(emptyState(), entry("a"), T0); // singing now, not counted as waiting
    const waiting: Entry[] = [];
    for (let i = 0; i < PER_PERSON; i++) s = add(s, (waiting[i] = entry("a")), T0);
    expect(() => add(s, entry("a"), T0)).toThrow(RuleError);
    expect(() => remove(s, "b", waiting[0]!.id)).toThrow(RuleError);
    expect(remove(s, "a", waiting[0]!.id).queue.length).toBe(PER_PERSON - 1);
    expect(remove(s, "b", waiting[0]!.id, true).queue.length).toBe(PER_PERSON - 1);
  });

  test("seats: waiting songs don't need one; a singer who leaves mid-song loses the turn", () => {
    let s = add(add(emptyState(), entry("a"), T0), entry("b"), T0);
    expect(dropUnseated(s, new Set(), T0)).toBe(s); // not started yet: time to sit down
    s = started(s, "a", s.current!.id, T0);
    const n2 = dropUnseated(s, new Set(["b"]), T0);
    expect(n2.current?.userId).toBe("b");
    expect(dropUnseated(s, new Set(["a"]), T0)).toBe(s);
  });

  test("room duets: one partner joins the open spot, and is dropped if they leave their seat mid-song", () => {
    let s = add(emptyState(), entry("a", true), T0);
    const id = s.current!.id;
    expect(() => joinDuet(s, id, person("a"))).toThrow(RuleError);
    s = joinDuet(s, id, person("b"));
    expect(s.current?.partner?.userId).toBe("b");
    expect(() => joinDuet(s, id, person("c"))).toThrow(RuleError);
    expect(() => leaveDuet(s, id, "c")).toThrow(RuleError);
    expect(leaveDuet(s, id, "b").current?.partner).toBeNull();
    s = started(s, "a", id, T0);
    expect(() => joinDuet(leaveDuet(s, id, "a"), id, person("c"))).toThrow(RuleError); // started: too late
    expect(dropUnseated(s, new Set(["a"]), T0).current?.partner).toBeNull();
    expect(() => joinDuet(add(emptyState(), entry("a"), T0), `e${n}`, person("b"))).toThrow(RuleError); // a solo
  });

  test("an admin moves a waiting song to the front", () => {
    const s = add(add(add(emptyState(), entry("a"), T0), entry("b"), T0), entry("c"), T0);
    const c = s.queue[1]!.id;
    expect(playNext(s, c).queue.map((q) => q.userId)).toEqual(["c", "b"]);
    expect(playNext(s, s.queue[0]!.id)).toBe(s);
    expect(() => playNext(s, s.current!.id)).toThrow(RuleError); // singing now: not waiting
  });

  test("lyric times and audio sniffing", () => {
    expect(lrcTimes("[ti:x]\n[00:12.50]hello\n[01:02]world\n[00:05.1][00:30.00]chorus")).toEqual([5100, 12500, 30000, 62000]);
    const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    expect(audioExt(bytes("ID3\x04\x00"))).toBe("mp3");
    expect(audioExt(new Uint8Array([0xff, 0xfb, 0x90]))).toBe("mp3");
    expect(audioExt(bytes("\x00\x00\x00\x20ftypM4A "))).toBe("m4a");
    expect(audioExt(bytes("\x89PNG\r\n"))).toBeNull();
    expect(hasParts("[00:01.00][A]me\n[00:02.00][B]you")).toBe(true);
    expect(hasParts("[00:01.00]solo song")).toBe(false);
  });
});
