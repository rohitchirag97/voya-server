// SVIP-only frame and chat bubble for each tier (min_svip = tier). Higher tiers get richer art:
// more gems, wings from SVIP4, a crown from SVIP5, a blazing rim at SVIP7.

const PALETTE: Record<number, { light: string; mid: string; dark: string; gem: string; text: string; bubble: [string, string] }> = {
  1: { light: "#F3C9A4", mid: "#C08457", dark: "#6E4126", gem: "#FFE2C2", text: "#FFFFFF", bubble: ["#8A5A3B", "#C08457"] },
  2: { light: "#F1F5FB", mid: "#B8C4D6", dark: "#5E6E87", gem: "#FFFFFF", text: "#FFFFFF", bubble: ["#5E6E87", "#9AAAC2"] },
  3: { light: "#FFF1B8", mid: "#FFC94D", dark: "#B4760A", gem: "#FF4D8D", text: "#3A2300", bubble: ["#E09B12", "#FFD86B"] },
  4: { light: "#FFD3E2", mid: "#FF6F9F", dark: "#A31F55", gem: "#FFF1B8", text: "#FFFFFF", bubble: ["#A31F55", "#FF6F9F"] },
  5: { light: "#E4D4FF", mid: "#A47BFF", dark: "#4C1D95", gem: "#FFD86B", text: "#FFFFFF", bubble: ["#4C1D95", "#8B5CF6"] },
  6: { light: "#CCFBF1", mid: "#2DD4BF", dark: "#0E5160", gem: "#FFD86B", text: "#FFFFFF", bubble: ["#0E5160", "#14B8A6"] },
  7: { light: "#FFE9A8", mid: "#E7B53C", dark: "#2A1C05", gem: "#FF3D6E", text: "#FFE9A8", bubble: ["#0B0B0B", "#3A2A12"] },
};

const star = (x: number, y: number, r: number, fill: string) =>
  `<path transform="translate(${x} ${y})" d="M0,-${r} L${r * 0.25},-${r * 0.25} L${r},0 L${r * 0.25},${r * 0.25} L0,${r} L-${r * 0.25},${r * 0.25} L-${r},0 L-${r * 0.25},-${r * 0.25} Z" fill="${fill}"/>`;

// Avatar frame on a 200×200 box; the picture sits in the centre circle (70% of the box).
function frame(tier: number) {
  const p = PALETTE[tier]!;
  const g = `svf${tier}`;
  // Gems around the ring: one per tier.
  const gems = Array.from({ length: tier }, (_, i) => {
    const a = (-90 + (360 / tier) * i + (tier === 1 ? 0 : 180 / tier)) * (Math.PI / 180);
    return `<circle cx="${(100 + 76 * Math.cos(a)).toFixed(1)}" cy="${(100 + 76 * Math.sin(a)).toFixed(1)}" r="5" fill="${p.gem}" stroke="${p.dark}" stroke-width="1.5"/>`;
  }).join("");
  const wings =
    tier >= 4
      ? `<g fill="url(#${g})" stroke="${p.dark}" stroke-width="1.2" opacity="0.95">
    <path d="M24,100 C6,86 2,64 10,48 C16,66 26,74 34,78 C20,72 14,60 18,52 C26,70 34,76 30,92 Z"/>
    <path d="M176,100 C194,86 198,64 190,48 C184,66 174,74 166,78 C180,72 186,60 182,52 C174,70 166,76 170,92 Z"/>
  </g>`
      : "";
  const crown =
    tier >= 5
      ? `<path d="M76,32 L80,8 L91,21 L100,2 L109,21 L120,8 L124,32 Z" fill="url(#${g})" stroke="${p.dark}" stroke-width="1.5" stroke-linejoin="round"/>
  <circle cx="80" cy="8" r="3" fill="${p.gem}"/><circle cx="100" cy="2.5" r="3.5" fill="${p.gem}"/><circle cx="120" cy="8" r="3" fill="${p.gem}"/>`
      : "";
  const blaze =
    tier === 7
      ? `<circle cx="100" cy="100" r="89" fill="none" stroke="#FF3D6E" stroke-width="3" stroke-dasharray="2 9" stroke-linecap="round" opacity="0.9"/>
  ${star(170, 40, 8, "#FFE9A8")}${star(30, 40, 8, "#FFE9A8")}${star(22, 150, 6, "#FFE9A8")}${star(178, 150, 6, "#FFE9A8")}`
      : `${star(172, 52, 6, p.light)}${star(28, 148, 5, p.light)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs>
    <linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${p.light}"/><stop offset="0.5" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.dark}"/>
    </linearGradient>
  </defs>
  ${wings}
  <circle cx="100" cy="100" r="76" fill="none" stroke="url(#${g})" stroke-width="11"/>
  <circle cx="100" cy="100" r="83" fill="none" stroke="${p.mid}" stroke-width="2" opacity="0.8"/>
  ${gems}
  ${blaze}
  ${crown}
  <rect x="66" y="170" width="68" height="24" rx="12" fill="url(#${g})" stroke="${p.dark}" stroke-width="1.5"/>
  <text x="100" y="187" text-anchor="middle" font-family="Arial" font-size="14" font-weight="900" fill="${tier === 3 ? "#3A2300" : tier === 7 ? "#2A1C05" : "#FFFFFF"}" letter-spacing="1">SVIP${tier}</text>
</svg>`;
}

// Chat bubble corner ornament (48×28): a gem badge with the tier number, a crown on SVIP5+.
function ornament(tier: number) {
  const p = PALETTE[tier]!;
  const g = `svb${tier}`;
  const top = tier >= 5 ? `<path d="M14,9 L16,1 L21,6 L24,0 L27,6 L32,1 L34,9 Z" fill="url(#${g})" stroke="${p.dark}" stroke-width="1"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 28">
  <defs>
    <linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${p.light}"/><stop offset="1" stop-color="${p.mid}"/>
    </linearGradient>
  </defs>
  ${top}
  <rect x="8" y="9" width="32" height="17" rx="8.5" fill="url(#${g})" stroke="${p.dark}" stroke-width="1.2"/>
  <text x="24" y="21.5" text-anchor="middle" font-family="Arial" font-size="10" font-weight="900" fill="${tier === 3 || tier === 7 ? "#2A1C05" : "#FFFFFF"}">S${tier}</text>
  ${star(44, 8, 4, p.light)}
</svg>`;
}

export const SVIP_COSMETICS = [1, 2, 3, 4, 5, 6, 7].flatMap((tier) => {
  const p = PALETTE[tier]!;
  return [
    { id: `svip${tier}_frame`, kind: "AVATAR_FRAME" as const, name: `SVIP${tier} Frame`, svg: frame(tier), minSvip: tier, sortOrder: 100 + tier },
    {
      id: `svip${tier}_bubble`,
      kind: "CHAT_BUBBLE" as const,
      name: `SVIP${tier} Bubble`,
      svg: ornament(tier),
      style: { gradient: p.bubble, border: p.light, text: p.text },
      minSvip: tier,
      sortOrder: 100 + tier,
    },
  ];
});
