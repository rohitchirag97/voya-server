import { describe, expect, test } from "bun:test";
import { add, dropUnseated, emptyState, finish, lrcTimes, PER_PERSON, READY_MS, remove, RuleError, SLACK_MS, started, timeout, type Entry } from "../src/lib/karaoke";
import { audioExt } from "../src/routes/posts";

// Pure rules: no server, no database.
const T0 = 1_000_000;
let n = 0;
const entry = (userId: string): Entry => ({ id: `e${++n}`, userId, displayName: userId, avatarUrl: null, songId: "s", title: "Song", artist: "", cover: null, durationMs: 200_000 });

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

  test("leaving your seat drops your songs and your turn", () => {
    const s = add(add(add(emptyState(), entry("a"), T0), entry("b"), T0), entry("c"), T0);
    const n2 = dropUnseated(s, new Set(["c"]), T0);
    expect(n2.current?.userId).toBe("c");
    expect(n2.queue).toEqual([]);
  });

  test("lyric times and audio sniffing", () => {
    expect(lrcTimes("[ti:x]\n[00:12.50]hello\n[01:02]world\n[00:05.1][00:30.00]chorus")).toEqual([5100, 12500, 30000, 62000]);
    const bytes = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
    expect(audioExt(bytes("ID3\x04\x00"))).toBe("mp3");
    expect(audioExt(new Uint8Array([0xff, 0xfb, 0x90]))).toBe("mp3");
    expect(audioExt(bytes("\x00\x00\x00\x20ftypM4A "))).toBe("m4a");
    expect(audioExt(bytes("\x89PNG\r\n"))).toBeNull();
  });
});
