// Sample decorations. Real items will be inserted into the `cosmetics` table (admin console / SQL).

// Avatar frame: drawn on a 200×200 box; the picture sits in the centre circle (70% of the box).
const goldenHalo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <defs>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFF1C2"/>
      <stop offset="0.45" stop-color="#FFC857"/>
      <stop offset="1" stop-color="#B9780F"/>
    </linearGradient>
  </defs>
  <circle cx="100" cy="100" r="76" fill="none" stroke="url(#gold)" stroke-width="10"/>
  <circle cx="100" cy="100" r="87" fill="none" stroke="#FFC857" stroke-width="2" stroke-dasharray="3 7" stroke-linecap="round" opacity="0.85"/>
  <g fill="#FFF6D6">
    <path transform="translate(174 57)" d="M0,-9 L2.2,-2.2 L9,0 L2.2,2.2 L0,9 L-2.2,2.2 L-9,0 L-2.2,-2.2 Z"/>
    <path transform="translate(26 57)" d="M0,-7 L1.7,-1.7 L7,0 L1.7,1.7 L0,7 L-1.7,1.7 L-7,0 L-1.7,-1.7 Z"/>
    <path transform="translate(26 143)" d="M0,-9 L2.2,-2.2 L9,0 L2.2,2.2 L0,9 L-2.2,2.2 L-9,0 L-2.2,-2.2 Z"/>
    <path transform="translate(174 143)" d="M0,-7 L1.7,-1.7 L7,0 L1.7,1.7 L0,7 L-1.7,1.7 L-7,0 L-1.7,-1.7 Z"/>
    <path transform="translate(100 187)" d="M0,-8 L2,-2 L8,0 L2,2 L0,8 L-2,2 L-8,0 L-2,-2 Z"/>
  </g>
  <path d="M78,30 L82,8 L92,21 L100,3 L108,21 L118,8 L122,30 Z" fill="url(#gold)" stroke="#8A5A00" stroke-width="1.5" stroke-linejoin="round"/>
  <circle cx="82" cy="8" r="3" fill="#FF4D8D"/>
  <circle cx="100" cy="3" r="3.5" fill="#7C5CFF"/>
  <circle cx="118" cy="8" r="3" fill="#FF4D8D"/>
</svg>`;

// Card decoration: a banner across the top of the profile card (400×140), fading into the card colour.
const aurora = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid slice">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5B3FFF"/>
      <stop offset="0.5" stop-color="#B44DFF"/>
      <stop offset="1" stop-color="#FF4D8D"/>
    </linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="400" height="140" fill="url(#sky)"/>
  <path d="M0,70 C70,40 130,105 210,78 C290,52 340,98 400,66 L400,140 L0,140 Z" fill="url(#glow)"/>
  <path d="M0,98 C80,78 150,124 230,104 C310,84 355,118 400,100 L400,140 L0,140 Z" fill="#1A1533"/>
  <g fill="#FFFFFF">
    <path transform="translate(42 30)" d="M0,-8 L2,-2 L8,0 L2,2 L0,8 L-2,2 L-8,0 L-2,-2 Z" opacity="0.95"/>
    <path transform="translate(338 26)" d="M0,-10 L2.5,-2.5 L10,0 L2.5,2.5 L0,10 L-2.5,2.5 L-10,0 L-2.5,-2.5 Z" opacity="0.9"/>
    <path transform="translate(290 70)" d="M0,-5 L1.2,-1.2 L5,0 L1.2,1.2 L0,5 L-1.2,1.2 L-5,0 L-1.2,-1.2 Z" opacity="0.8"/>
    <path transform="translate(96 72)" d="M0,-5 L1.2,-1.2 L5,0 L1.2,1.2 L0,5 L-1.2,1.2 L-5,0 L-1.2,-1.2 Z" opacity="0.7"/>
    <circle cx="150" cy="22" r="2" opacity="0.8"/>
    <circle cx="250" cy="38" r="1.6" opacity="0.7"/>
    <circle cx="370" cy="60" r="1.8" opacity="0.7"/>
    <circle cx="20" cy="64" r="1.5" opacity="0.6"/>
    <circle cx="200" cy="14" r="1.4" opacity="0.6"/>
  </g>
</svg>`;

// Chat bubble ornament: sits on the bubble's top-left corner (48×28 box).
const galaxyCrownOrnament = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 28">
  <defs>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFF1B8"/><stop offset="0.5" stop-color="#FFC94D"/><stop offset="1" stop-color="#C47A0B"/>
    </linearGradient>
  </defs>
  <path d="M6,24 L9,8 L16,15 L22,3 L28,15 L35,8 L38,24 Z" fill="url(#gold)" stroke="#8A5200" stroke-width="1.2" stroke-linejoin="round"/>
  <circle cx="9" cy="8" r="2.4" fill="#FF3D8B"/>
  <circle cx="22" cy="3" r="2.6" fill="#8B5CF6"/>
  <circle cx="35" cy="8" r="2.4" fill="#FF3D8B"/>
  <rect x="6" y="22" width="32" height="3.5" rx="1.5" fill="#C47A0B"/>
  <path transform="translate(43 6)" d="M0,-5 L1.2,-1.2 L5,0 L1.2,1.2 L0,5 L-1.2,1.2 L-5,0 L-1.2,-1.2 Z" fill="#FFF6D6"/>
  <path transform="translate(43 19)" d="M0,-3 L0.8,-0.8 L3,0 L0.8,0.8 L0,3 L-0.8,0.8 L-3,0 L-0.8,-0.8 Z" fill="#FFF6D6" opacity="0.8"/>
</svg>`;

export const SAMPLE_COSMETICS = [
  { id: "frame_golden_halo", kind: "AVATAR_FRAME" as const, name: "Golden Halo", svg: goldenHalo, sortOrder: 1 },
  { id: "card_aurora", kind: "CARD_DECOR" as const, name: "Aurora", svg: aurora, sortOrder: 1 },
  {
    id: "bubble_galaxy_crown",
    kind: "CHAT_BUBBLE" as const,
    name: "Galaxy Crown",
    svg: galaxyCrownOrnament,
    style: { gradient: ["#4C1D95", "#BE185D"], border: "#FFC94D", text: "#FFFFFF" },
    sortOrder: 1,
  },
];
