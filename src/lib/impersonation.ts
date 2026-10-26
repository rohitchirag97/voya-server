// Stops regular users posing as app staff.

// Fancy fonts back to plain letters (𝓐𝓭𝓶𝓲𝓷, ⓐⓓⓜⓘⓝ, ＡＤＭＩＮ), lowercase, drop separators, fold look-alikes
// (adm1n, 0fficial, supp0rt, 5taff, offlcial) onto one spelling.
// Small caps, Cyrillic and Greek look-alikes that NFKD leaves alone.
const LOOKALIKE: Record<string, string> = Object.fromEntries(
  [..."ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘǫʀꜱᴛᴜᴠᴡʏᴢ"]
    .map((c, i) => [c, "abcdefghijklmnopqrstuvwyz"[i]!])
    .concat([..."аеорсухіѕ"].map((c, i) => [c, "aeopcyxis"[i]!]))
    .concat([..."νοαγυιτκρ"].map((c, i) => [c, "voayuitkp"[i]!]))
    // Barred/slashed O's and theta; lambda, delta or ∀ for A; ʌ or ∇ for V; ¥ for Y (after lowercasing: Ɵ→ɵ, Θ→θ, Ø→ø,
    // Λ→λ, Δ→δ; math-bold letters like 𝝯 𝝝 𝝙 fold to ∇ Θ Δ first).
    .concat([..."ɵθøσօλδ∀ʌ∇¥"].map((c, i) => [c, "oooooaaavvy"[i]!])),
);
const fold = (s: string) =>
  s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/./gu, (c) => LOOKALIKE[c] ?? c)
    .replace(/[^a-z0-9]/g, "")
    .replace(/[1l|]/g, "i")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b");

// "voya" covers VoyaLive and any variant; only staff may use the app's name.
const NAME_WORDS = ["admin", "official", "support", "moderator", "staff", "voya", "helpdesk", "customercare", "system", "verified"].map(fold);
// Bios may mention admins ("room admin") but not claim to be the app's staff.
const BIO_WORDS = ["official", "staff", "verified", "adminteam", "supportteam", "voyaliveteam", "customercare", "helpdesk"].map(fold);
// Emoji and symbols that copy the Official mark.
const FAKE_MARK = /[✅☑✔✓\u{1F6E1}\u{1F530}\u{1F396}\u{1F3C5}]/u;

export const reservedName = (name: string) => NAME_WORDS.some((w) => fold(name).includes(w));
// The app's name in any spelling (fancy fonts, look-alikes, digit swaps): used to clean up existing names.
export const mentionsVoya = (name: string) => fold(name).includes("voya");
export const impersonatingBio = (bio: string) => FAKE_MARK.test(bio) || BIO_WORDS.some((w) => fold(bio).includes(w));
