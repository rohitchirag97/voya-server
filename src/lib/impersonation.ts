// Stops regular users posing as app staff. Names are already limited to [A-Za-z0-9_.], so only words and digit swaps matter there.

// Lowercase, drop separators, fold look-alikes (adm1n, 0fficial, supp0rt, 5taff, offlcial) onto one spelling.
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/[1l|]/g, "i")
    .replace(/0/g, "o")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/8/g, "b");

const NAME_WORDS = ["admin", "official", "support", "moderator", "staff", "voyalive", "helpdesk", "customercare", "system", "verified"].map(fold);
// Bios may mention admins ("room admin") but not claim to be the app's staff.
const BIO_WORDS = ["official", "staff", "verified", "adminteam", "supportteam", "voyaliveteam", "customercare", "helpdesk"].map(fold);
// Emoji and symbols that copy the Official mark.
const FAKE_MARK = /[✅☑✔✓\u{1F6E1}\u{1F530}\u{1F396}\u{1F3C5}]/u;

export const reservedName = (name: string) => NAME_WORDS.some((w) => fold(name).includes(w));
export const impersonatingBio = (bio: string) => FAKE_MARK.test(bio) || BIO_WORDS.some((w) => fold(bio).includes(w));
