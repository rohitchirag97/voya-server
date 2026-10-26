// More gifts, cheapest to priciest (nothing over 20,000 coins). Artwork is drawn here as small SVGs (viewBox 100x100);
// seeded with "insert if missing", so price edits made later in the admin panel are never overwritten.

const svg = (body: string, defs = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${body}</svg>`;
const lin = (id: string, a: string, b: string, vertical = true) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;
const rad = (id: string, a: string, b: string) => `<radialGradient id="${id}" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></radialGradient>`;
const shine = (x: number, y: number, rx: number, ry: number) => `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#fff" opacity="0.45"/>`;

const lollipop = svg(
  `<rect x="47" y="48" width="6" height="46" rx="3" fill="#F3E3C8"/>
  <circle cx="50" cy="34" r="27" fill="url(#lp)"/>
  <path d="M50 34 m0-18 a18 18 0 1 1 -17 12 a12 12 0 1 0 11 -7 a6 6 0 1 1 6 8" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity="0.85"/>
  ${shine(39, 20, 7, 4)}`,
  rad("lp", "#FF9AD5", "#E0368E"),
);

const iceCream = svg(
  `<path d="M30 48 L50 96 L70 48 Z" fill="url(#cone)"/>
  <path d="M34 56 L66 56 M37 66 L63 66 M41 76 L59 76" stroke="#B9783A" stroke-width="2" opacity="0.6"/>
  <circle cx="38" cy="42" r="14" fill="#FFB3CC"/><circle cx="62" cy="42" r="14" fill="#9EE6C9"/>
  <circle cx="50" cy="28" r="16" fill="#FFF1D6"/>
  <circle cx="50" cy="12" r="5" fill="#E8344E"/>
  ${shine(44, 22, 5, 3)}`,
  lin("cone", "#F2C27B", "#D18D45"),
);

const balloons = svg(
  `<path d="M34 58 Q38 76 50 92 M66 56 Q62 76 50 92 M50 60 L50 92" stroke="#C9C2E8" stroke-width="1.5" fill="none"/>
  <ellipse cx="34" cy="36" rx="17" ry="21" fill="url(#b1)"/>
  <ellipse cx="66" cy="34" rx="17" ry="21" fill="url(#b2)"/>
  <ellipse cx="50" cy="44" rx="17" ry="21" fill="url(#b3)"/>
  ${shine(28, 28, 4, 6)}${shine(60, 26, 4, 6)}${shine(44, 36, 4, 6)}`,
  rad("b1", "#7FD3FF", "#2A8CDB") + rad("b2", "#FFE07A", "#F0A51E") + rad("b3", "#FF8FB8", "#E8346F"),
);

const teddy = svg(
  `<circle cx="28" cy="24" r="11" fill="#B07443"/><circle cx="72" cy="24" r="11" fill="#B07443"/>
  <circle cx="28" cy="24" r="5" fill="#F2C9A0"/><circle cx="72" cy="24" r="5" fill="#F2C9A0"/>
  <ellipse cx="50" cy="74" rx="26" ry="22" fill="url(#fur)"/>
  <circle cx="50" cy="40" r="25" fill="url(#fur)"/>
  <ellipse cx="50" cy="49" rx="11" ry="8" fill="#F2C9A0"/>
  <circle cx="41" cy="36" r="3.2" fill="#2B1B10"/><circle cx="59" cy="36" r="3.2" fill="#2B1B10"/>
  <ellipse cx="50" cy="46" rx="4" ry="3" fill="#2B1B10"/>
  <path d="M44 70 q6 -8 12 0 q6 8 -6 14 q-12 -6 -6 -14z" fill="#FF4F7B"/>`,
  rad("fur", "#D79A63", "#9A5E30"),
);

const perfume = svg(
  `<rect x="42" y="10" width="16" height="12" rx="3" fill="url(#cap)"/>
  <rect x="46" y="20" width="8" height="8" fill="#E6D7A8"/>
  <path d="M24 46 Q24 28 50 28 Q76 28 76 46 L76 80 Q76 92 62 92 L38 92 Q24 92 24 80 Z" fill="url(#glass)"/>
  <path d="M30 60 L70 60 L70 80 Q70 86 62 86 L38 86 Q30 86 30 80 Z" fill="#FF6FB0" opacity="0.55"/>
  ${shine(36, 42, 5, 10)}`,
  lin("cap", "#FFE38A", "#C9921E") + lin("glass", "#F6E8FF", "#C8A6F0"),
);

const guitar = svg(
  `<rect x="47" y="6" width="7" height="50" rx="2" fill="#6B3E1F" transform="rotate(30 50 50)"/>
  <rect x="62" y="2" width="14" height="10" rx="3" fill="#3A2210" transform="rotate(30 50 50)"/>
  <path d="M30 52 q-12 4 -10 20 q2 18 22 22 q18 2 24 -12 q4 -12 -6 -18 q-6 -6 -4 -14 q2 -10 -10 -8 q-8 2 -16 10z" fill="url(#gbody)"/>
  <circle cx="44" cy="68" r="6" fill="#2A1608"/>
  <path d="M38 80 L58 50" stroke="#F5E6C8" stroke-width="1.2" opacity="0.8"/>`,
  lin("gbody", "#F0A048", "#B05A1C"),
);

const cake = svg(
  `<rect x="18" y="56" width="64" height="32" rx="6" fill="url(#c1)"/>
  <rect x="28" y="34" width="44" height="24" rx="5" fill="url(#c2)"/>
  <path d="M18 62 q8 8 16 0 q8 8 16 0 q8 8 16 0 q8 8 16 0" fill="none" stroke="#fff" stroke-width="4"/>
  <path d="M28 40 q7 7 14 0 q8 7 16 0 q7 7 14 0" fill="none" stroke="#fff" stroke-width="3.5"/>
  <rect x="47" y="18" width="6" height="16" rx="2" fill="#7CC8FF"/>
  <path d="M50 6 q6 7 0 12 q-6 -5 0 -12z" fill="#FFB020"/>
  <circle cx="34" cy="74" r="3" fill="#FFE07A"/><circle cx="50" cy="78" r="3" fill="#7FE0B0"/><circle cx="66" cy="74" r="3" fill="#7CC8FF"/>`,
  lin("c1", "#FF8FB8", "#E0457F") + lin("c2", "#FFC0D8", "#F07AA8"),
);

const diamondRing = svg(
  `<circle cx="50" cy="66" r="24" fill="none" stroke="url(#band)" stroke-width="8"/>
  <path d="M34 26 L66 26 L76 38 L50 62 L24 38 Z" fill="url(#gem)"/>
  <path d="M34 26 L42 38 L50 26 L58 38 L66 26 M24 38 L76 38 M42 38 L50 62 L58 38" stroke="#fff" stroke-width="1.5" fill="none" opacity="0.7"/>
  <path d="M80 14 l3 7 l7 3 l-7 3 l-3 7 l-3 -7 l-7 -3 l7 -3z" fill="#fff"/>`,
  lin("band", "#FFE59A", "#C98F1E") + lin("gem", "#D8F6FF", "#5CC2F2"),
);

const loveLetter = svg(
  `<rect x="12" y="28" width="76" height="52" rx="6" fill="url(#env)"/>
  <path d="M12 32 L50 60 L88 32" fill="none" stroke="#E9B8C8" stroke-width="3"/>
  <path d="M50 46 c-10 -14 -28 -2 -14 14 l14 12 l14 -12 c14 -16 -4 -28 -14 -14z" fill="url(#seal)"/>
  <path d="M74 12 c-4 -6 -12 -1 -6 6 l6 5 l6 -5 c6 -7 -2 -12 -6 -6z" fill="#FF5C93"/>`,
  lin("env", "#FFF6F0", "#F8D9E4") + rad("seal", "#FF7AA8", "#D81E5B"),
);

const sportsCar = svg(
  `<path d="M8 66 Q10 52 26 50 L38 38 Q44 32 56 32 L70 32 Q78 32 84 44 L92 50 Q96 54 94 66 Z" fill="url(#car)"/>
  <path d="M40 40 L50 34 L68 34 L74 44 Z" fill="#BFE6FF" opacity="0.9"/>
  <rect x="8" y="62" width="88" height="6" rx="3" fill="#9E0F2C"/>
  <circle cx="28" cy="68" r="11" fill="#1E1E28"/><circle cx="28" cy="68" r="5" fill="#C9CED8"/>
  <circle cx="76" cy="68" r="11" fill="#1E1E28"/><circle cx="76" cy="68" r="5" fill="#C9CED8"/>
  <rect x="86" y="52" width="8" height="4" rx="2" fill="#FFE07A"/>
  ${shine(56, 42, 14, 2)}`,
  lin("car", "#FF5A6E", "#C4102E"),
);

const yacht = svg(
  `<path d="M6 76 Q30 70 50 76 Q70 82 94 76 L94 96 L6 96 Z" fill="url(#sea)"/>
  <path d="M12 64 L88 64 L78 80 L20 80 Z" fill="url(#hull)"/>
  <path d="M26 64 L30 50 L70 50 L76 64 Z" fill="#F4F7FF"/>
  <path d="M36 50 L40 40 L62 40 L66 50 Z" fill="#E6ECFA"/>
  <rect x="34" y="54" width="30" height="5" rx="2" fill="#5AA9E6"/>
  <rect x="44" y="42" width="14" height="4" rx="2" fill="#5AA9E6"/>
  <rect x="49" y="24" width="2.5" height="16" fill="#9AA5B8"/>
  <path d="M51 24 L64 30 L51 32 Z" fill="#E8344E"/>`,
  lin("sea", "#62C7FF", "#1C6FC4") + lin("hull", "#FFFFFF", "#C9D2E3"),
);

const castle = svg(
  `<rect x="14" y="40" width="18" height="52" fill="url(#stone)"/><rect x="68" y="40" width="18" height="52" fill="url(#stone)"/>
  <rect x="30" y="52" width="40" height="40" fill="url(#stone)"/>
  <rect x="40" y="28" width="20" height="30" fill="url(#stone)"/>
  <path d="M12 40 L23 22 L34 40 Z M66 40 L77 22 L88 40 Z M38 28 L50 8 L62 28 Z" fill="url(#roof)"/>
  <path d="M42 92 L42 76 Q50 66 58 76 L58 92 Z" fill="#5B3A8C"/>
  <rect x="20" y="52" width="6" height="9" rx="3" fill="#FFE07A"/><rect x="74" y="52" width="6" height="9" rx="3" fill="#FFE07A"/>
  <rect x="47" y="36" width="6" height="9" rx="3" fill="#FFE07A"/>
  <path d="M50 8 L50 0 L58 3 L50 6" fill="#FF5C93"/>`,
  lin("stone", "#EDE6FF", "#B9A8E6") + lin("roof", "#FF7AB6", "#B4207A"),
);

const privateJet = svg(
  `<path d="M50 4 Q58 12 58 30 L58 70 Q58 86 50 96 Q42 86 42 70 L42 30 Q42 12 50 4 Z" fill="url(#jet)"/>
  <path d="M42 44 L8 64 L8 70 L42 60 Z M58 44 L92 64 L92 70 L58 60 Z" fill="#D7DEEC"/>
  <path d="M44 80 L30 92 L30 96 L46 90 Z M56 80 L70 92 L70 96 L54 90 Z" fill="#D7DEEC"/>
  <path d="M46 16 Q50 10 54 16 L54 24 L46 24 Z" fill="#5AA9E6"/>
  <rect x="49" y="30" width="2" height="44" fill="#C7A84A" opacity="0.8"/>`,
  lin("jet", "#FFFFFF", "#AFB9CC", false),
);

const treasure = svg(
  `<ellipse cx="50" cy="90" rx="40" ry="5" fill="#000" opacity="0.25"/>
  <circle cx="50" cy="46" r="36" fill="url(#glow)"/>
  <rect x="14" y="50" width="72" height="38" rx="5" fill="url(#wood)"/>
  <path d="M14 50 Q14 26 50 24 Q86 26 86 50 Z" fill="url(#wood)"/>
  <path d="M18 46 Q30 36 50 36 Q70 36 82 46" fill="none" stroke="#FFD86B" stroke-width="3"/>
  <rect x="14" y="48" width="72" height="6" fill="url(#gold)"/>
  <rect x="26" y="26" width="6" height="62" fill="url(#gold)"/><rect x="68" y="26" width="6" height="62" fill="url(#gold)"/>
  <rect x="42" y="50" width="16" height="16" rx="3" fill="url(#gold)"/>
  <circle cx="50" cy="57" r="2.5" fill="#5A3410"/><rect x="49" y="57" width="2" height="5" fill="#5A3410"/>
  <circle cx="34" cy="22" r="6" fill="url(#gold)"/><circle cx="46" cy="18" r="6" fill="url(#gold)"/><circle cx="60" cy="20" r="6" fill="url(#gold)"/>
  <path d="M68 12 L76 12 L80 18 L72 26 L64 18 Z" fill="#FF4F8B"/><path d="M24 10 L30 10 L33 15 L27 21 L21 15 Z" fill="#5CC2F2"/>
  <path d="M84 20 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2z" fill="#fff"/>`,
  lin("wood", "#B66A2E", "#6E3A14") + lin("gold", "#FFE59A", "#D39A22") + rad("glow", "#FFE7A0", "#FFE7A000"),
);

const universe = svg(
  `<circle cx="50" cy="50" r="46" fill="url(#space)"/>
  <ellipse cx="50" cy="52" rx="40" ry="11" fill="none" stroke="url(#ringg)" stroke-width="5" transform="rotate(-18 50 52)"/>
  <circle cx="50" cy="50" r="20" fill="url(#planet)"/>
  <path d="M14 58 A40 11 0 0 0 86 46" fill="none" stroke="url(#ringg)" stroke-width="5" transform="rotate(-18 50 52)"/>
  <circle cx="22" cy="24" r="1.6" fill="#fff"/><circle cx="78" cy="20" r="1.2" fill="#fff"/><circle cx="82" cy="78" r="1.6" fill="#fff"/>
  <circle cx="18" cy="76" r="1.2" fill="#fff"/><circle cx="66" cy="12" r="1" fill="#fff"/>
  <path d="M30 14 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2z" fill="#FFE59A"/>
  ${shine(43, 42, 6, 4)}`,
  rad("space", "#3A1E7A", "#0B0620") + rad("planet", "#FFB36B", "#E0457F") + lin("ringg", "#FFF1B8", "#C59BFF", false),
);

const g = (id: string, name: string, coinPrice: number, maxQuantity: number, sortOrder: number, art: string, animation: string | null = null) => ({
  id,
  name,
  assetUrl: `gifts/${id}.svg`,
  coinPrice,
  maxQuantity,
  sortOrder,
  svg: art,
  animation,
});

export const MORE_GIFTS = [
  g("lollipop", "Lollipop", 5, 999, 10, lollipop),
  g("icecream", "Ice Cream", 9, 999, 11, iceCream),
  g("balloons", "Balloons", 19, 999, 12, balloons),
  g("teddy", "Teddy Bear", 39, 520, 13, teddy),
  g("perfume", "Perfume", 99, 99, 20, perfume),
  g("guitar", "Guitar", 149, 99, 21, guitar),
  g("cake", "Party Cake", 199, 99, 22, cake),
  g("diamond_ring", "Diamond Ring", 299, 99, 23, diamondRing),
  g("love_letter", "Love Letter", 520, 66, 30, loveLetter),
  g("sports_car", "Sports Car", 1314, 33, 31, sportsCar),
  g("yacht", "Yacht", 2999, 10, 32, yacht),
  g("castle", "Dream Castle", 5200, 10, 33, castle),
  g("private_jet", "Private Jet", 8888, 5, 34, privateJet, "launch"),
  g("treasure_chest", "Treasure Chest", 13140, 5, 35, treasure),
  g("universe", "Universe", 19999, 3, 36, universe),
];
