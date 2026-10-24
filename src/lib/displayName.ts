// Display names: decorative fonts, symbols and emoji are fine; invisible, layout-breaking or zalgo text is not.
// Keep in sync with app/src/displayName.ts (the app checks as you type).

export const NAME_MIN = 3;
export const NAME_MAX = 30; // characters (code points), so fancy-font letters count as one

// Blank-looking letters people use for "invisible" names.
const BLANK = /[ᅟᅠㅤﾠ⠀]/u;
// Control, format (bidi overrides, zero-width) except the emoji joiner U+200D, private-use, unassigned, line separators.
const BAD = /[\p{Cc}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?!‍)\p{Cf}/u;

export const normalizeName = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

// Expects a normalized name. null = OK.
export function nameError(n: string): string | null {
  const len = [...n].length;
  if (len < NAME_MIN) return `At least ${NAME_MIN} characters`;
  if (len > NAME_MAX) return `At most ${NAME_MAX} characters`;
  if (n.includes("@")) return "@ isn't allowed (it starts a mention)";
  if (BAD.test(n) || BLANK.test(n)) return "That name has invisible or unsupported characters";
  if (/\p{M}{4}/u.test(n)) return "Too many stacked accent marks";
  if (!/[\p{L}\p{N}\p{S}]/u.test(n)) return "Add at least one letter, number or symbol";
  return null;
}
