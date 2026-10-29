// Gifts whose send animation is an SVGA (public/games/fx/gift), played full screen once by the app's FX player.
// `svg` is only the icon in the gift sheet.

const lips = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <defs>
    <linearGradient id="lipU" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF7AB8"/><stop offset="1" stop-color="#E8216E"/></linearGradient>
    <linearGradient id="lipL" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF4F98"/><stop offset="1" stop-color="#C2125A"/></linearGradient>
    <radialGradient id="lipGlow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FF8FD0" stop-opacity="0.55"/><stop offset="1" stop-color="#FF8FD0" stop-opacity="0"/></radialGradient>
  </defs>
  <circle cx="60" cy="62" r="56" fill="url(#lipGlow)"/>
  <path d="M12 60 C24 44 38 34 50 40 C55 42 58 45 60 47 C62 45 65 42 70 40 C82 34 96 44 108 60 C92 58 76 62 60 64 C44 62 28 58 12 60 Z" fill="url(#lipU)"/>
  <path d="M12 60 C28 62 44 66 60 66 C76 66 92 62 108 60 C98 80 80 92 60 92 C40 92 22 80 12 60 Z" fill="url(#lipL)"/>
  <path d="M14 60 C34 63 86 63 106 60" stroke="#8E0B43" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  <ellipse cx="44" cy="76" rx="12" ry="4" fill="#fff" opacity="0.55" transform="rotate(-8 44 76)"/>
  <ellipse cx="78" cy="78" rx="7" ry="2.6" fill="#fff" opacity="0.4" transform="rotate(8 78 78)"/>
  <ellipse cx="40" cy="47" rx="8" ry="2.6" fill="#fff" opacity="0.5" transform="rotate(-20 40 47)"/>
  <path d="M98 26 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2z" fill="#FFE3F1"/>
</svg>`;

const heartRocket = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 170">
  <defs>
    <linearGradient id="hrHull" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#D8C8F5"/><stop offset="0.45" stop-color="#FFFFFF"/><stop offset="1" stop-color="#A893D8"/></linearGradient>
    <linearGradient id="hrNose" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF4FA0"/><stop offset="1" stop-color="#E0247A"/></linearGradient>
    <linearGradient id="hrFin" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF6FB5"/><stop offset="1" stop-color="#FF9A4D"/></linearGradient>
    <linearGradient id="hrFire" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF4B0"/><stop offset="0.5" stop-color="#FFB15C"/><stop offset="1" stop-color="#FF4D8D" stop-opacity="0"/></linearGradient>
    <radialGradient id="hrPort" cx="0.4" cy="0.35" r="0.7"><stop offset="0" stop-color="#9B7BFF"/><stop offset="1" stop-color="#3E1F8F"/></radialGradient>
  </defs>
  <path d="M60 128 C52 142 54 156 60 168 C66 156 68 142 60 128Z" fill="url(#hrFire)"/>
  <path d="M42 96 L26 126 L44 122 Z" fill="url(#hrFin)"/>
  <path d="M78 96 L94 126 L76 122 Z" fill="url(#hrFin)"/>
  <path d="M60 28 C78 40 84 70 82 96 C80 112 74 124 60 128 C46 124 40 112 38 96 C36 70 42 40 60 28Z" fill="url(#hrHull)"/>
  <path d="M60 28 C68 33 73 40 76 48 C66 45 54 45 44 48 C47 40 52 33 60 28Z" fill="url(#hrNose)"/>
  <path d="M60 128 L54 118 L60 104 L66 118 Z" fill="url(#hrFin)"/>
  <ellipse cx="60" cy="126" rx="16" ry="4" fill="#F4ECFF"/>
  <circle cx="60" cy="62" r="7" fill="url(#hrPort)" stroke="#E9E2FA" stroke-width="2.5"/>
  <circle cx="60" cy="84" r="10" fill="url(#hrPort)" stroke="#E9E2FA" stroke-width="3"/>
  <circle cx="60" cy="104" r="6.5" fill="url(#hrPort)" stroke="#E9E2FA" stroke-width="2.5"/>
  <rect x="58.6" y="14" width="2.8" height="16" rx="1.4" fill="#C9B8EE"/>
  <path d="M60 18 C56 14 52 11 52 7 C52 4 54.5 2 57 2 C58.5 2 59.5 3 60 4 C60.5 3 61.5 2 63 2 C65.5 2 68 4 68 7 C68 11 64 14 60 18Z" fill="#FF3D7F"/>
  <ellipse cx="50" cy="74" rx="3" ry="14" fill="#fff" opacity="0.55"/>
  <path d="M16 40 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 l5 -2z" fill="#FFE3F1"/>
  <path d="M102 30 l1.5 4 l4 1.5 l-4 1.5 l-1.5 4 l-1.5 -4 l-4 -1.5 l4 -1.5z" fill="#FFF4B0"/>
</svg>`;

export const SVGA_GIFTS = [
  { id: "pink_lips", name: "Glossy Pink Lips", assetUrl: "gifts/pink_lips.svg", coinPrice: 2990, maxQuantity: 99, sortOrder: 24, svg: lips, effect: "/games/fx/gift/pink-lips.svga" },
  { id: "heart_rocket", name: "Pink Heart Rocket", assetUrl: "gifts/heart_rocket.svg", coinPrice: 13140, maxQuantity: 33, sortOrder: 29, svg: heartRocket, effect: "/games/fx/gift/pink-heart-rocket.svga" },
];
