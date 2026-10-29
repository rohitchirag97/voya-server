// Animated gift sample. `svg` is the artwork; `animation` names a motion preset the app plays
// (react-native-svg can't run animations written inside SVG, so motion lives in the app).

const rocket = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 200">
  <defs>
    <linearGradient id="hull" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#D9DEEA"/>
      <stop offset="0.45" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#AEB6C8"/>
    </linearGradient>
    <linearGradient id="fire" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFF4B0"/>
      <stop offset="0.4" stop-color="#FFC857"/>
      <stop offset="1" stop-color="#FF4D2E" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glass" cx="0.4" cy="0.35" r="0.7">
      <stop offset="0" stop-color="#B9F2FF"/>
      <stop offset="1" stop-color="#2E7BFF"/>
    </radialGradient>
  </defs>
  <path d="M60,150 C44,168 48,186 60,198 C72,186 76,168 60,150 Z" fill="url(#fire)"/>
  <path d="M60,150 C52,162 54,174 60,182 C66,174 68,162 60,150 Z" fill="#FFFFFF" opacity="0.85"/>
  <path d="M38,112 L16,146 L22,152 L42,136 Z" fill="#FF4D8D"/>
  <path d="M82,112 L104,146 L98,152 L78,136 Z" fill="#FF4D8D"/>
  <path d="M60,6 C84,30 90,70 86,118 L82,148 L38,148 L34,118 C30,70 36,30 60,6 Z" fill="url(#hull)" stroke="#8B93A7" stroke-width="2"/>
  <path d="M60,6 C70,16 77,28 81,42 L39,42 C43,28 50,16 60,6 Z" fill="#FF4D8D"/>
  <circle cx="60" cy="76" r="15" fill="url(#glass)" stroke="#7C5CFF" stroke-width="4"/>
  <circle cx="55" cy="71" r="4" fill="#FFFFFF" opacity="0.8"/>
  <rect x="52" y="112" width="16" height="36" rx="3" fill="#7C5CFF"/>
  <path d="M38,148 L82,148 L78,156 L42,156 Z" fill="#5C6375"/>
</svg>`;

export const ANIMATED_GIFTS = [
  { id: "rocket", name: "Rocket", assetUrl: "gifts/rocket.svg", coinPrice: 1000, maxQuantity: 10, sortOrder: 5, svg: rocket, animation: "launch" },
];
