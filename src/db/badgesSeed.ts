// Sample badges (64×64 artwork). Real badges get inserted into the `badges` table.

const vip = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF1B8"/><stop offset="0.5" stop-color="#FFC94D"/><stop offset="1" stop-color="#C47A0B"/></linearGradient>
    <linearGradient id="in" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3A1D6E"/><stop offset="1" stop-color="#1A0B36"/></linearGradient>
  </defs>
  <path d="M32 6 L54 14 V31 C54 45 44 54 32 59 C20 54 10 45 10 31 V14 Z" fill="url(#g)" stroke="#8A5200" stroke-width="1.5"/>
  <path d="M32 11 L49 17.5 V31 C49 42 41.5 49.5 32 53.5 C22.5 49.5 15 42 15 31 V17.5 Z" fill="url(#in)"/>
  <path d="M21 25 L24 15 L29 21 L32 12 L35 21 L40 15 L43 25 Z" fill="url(#g)"/>
  <text x="32" y="43" text-anchor="middle" font-family="Arial" font-size="13" font-weight="900" fill="url(#g)" letter-spacing="1">VIP</text>
  <path d="M18 14.5 L32 9.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" opacity="0.7"/>
</svg>`;

const topGifter = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="gem" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF8AC2"/><stop offset="0.5" stop-color="#FF3D8B"/><stop offset="1" stop-color="#B0105A"/></linearGradient>
  </defs>
  <path d="M32 4 L56 18 V46 L32 60 L8 46 V18 Z" fill="url(#gem)" stroke="#FFD1E6" stroke-width="2"/>
  <path d="M32 4 L56 18 L32 26 L8 18 Z" fill="#FFFFFF" opacity="0.18"/>
  <rect x="20" y="30" width="24" height="17" rx="2.5" fill="#FFFFFF"/>
  <rect x="18" y="25" width="28" height="7" rx="2" fill="#FFE0EE"/>
  <rect x="30" y="25" width="4" height="22" fill="#FF3D8B"/>
  <path d="M32 25 C26 17 20 21 24 25 Z M32 25 C38 17 44 21 40 25 Z" fill="#FFFFFF" stroke="#FF3D8B" stroke-width="1.5"/>
</svg>`;

const partyStar = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <radialGradient id="bg" cx="0.5" cy="0.45" r="0.6"><stop offset="0" stop-color="#C084FC"/><stop offset="1" stop-color="#5B21B6"/></radialGradient>
    <linearGradient id="star" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF6C9"/><stop offset="1" stop-color="#FFC94D"/></linearGradient>
  </defs>
  <circle cx="32" cy="32" r="28" fill="url(#bg)" stroke="#E9D5FF" stroke-width="2"/>
  <g stroke="#F5D0FE" stroke-width="2" stroke-linecap="round" opacity="0.8">
    <path d="M32 7 V12"/><path d="M32 52 V57"/><path d="M7 32 H12"/><path d="M52 32 H57"/>
    <path d="M14 14 L17.5 17.5"/><path d="M46.5 46.5 L50 50"/><path d="M50 14 L46.5 17.5"/><path d="M17.5 46.5 L14 50"/>
  </g>
  <path d="M32 16 L36.7 26.2 L47.9 27.4 L39.5 34.9 L41.9 45.9 L32 40.2 L22.1 45.9 L24.5 34.9 L16.1 27.4 L27.3 26.2 Z" fill="url(#star)" stroke="#B45309" stroke-width="1.2" stroke-linejoin="round"/>
  <circle cx="27" cy="24" r="1.6" fill="#FFFFFF"/>
</svg>`;

const micMaster = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#22D3EE"/><stop offset="1" stop-color="#2563EB"/></linearGradient>
    <linearGradient id="mic" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#E2E8F0"/><stop offset="0.5" stop-color="#FFFFFF"/><stop offset="1" stop-color="#CBD5E1"/></linearGradient>
  </defs>
  <rect x="5" y="5" width="54" height="54" rx="16" fill="url(#bg)" stroke="#A5F3FC" stroke-width="2"/>
  <rect x="25" y="13" width="14" height="24" rx="7" fill="url(#mic)"/>
  <path d="M28 20 H36 M28 25 H36 M28 30 H36" stroke="#94A3B8" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M20 31 C20 38 25.5 43 32 43 C38.5 43 44 38 44 31" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>
  <path d="M32 43 V50 M25 50 H39" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round"/>
  <path d="M13 24 C11 28 11 34 13 38 M51 24 C53 28 53 34 51 38" fill="none" stroke="#A5F3FC" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

// Authorised Coin Seller: royal crown over a gold coin on a royal-purple medallion. Granted with seller approval.
const coinSeller = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF6C9"/><stop offset="0.45" stop-color="#FFCB45"/><stop offset="1" stop-color="#B86E00"/></linearGradient>
    <radialGradient id="royal" cx="0.5" cy="0.38" r="0.62"><stop offset="0" stop-color="#8E4DFF"/><stop offset="0.6" stop-color="#4A1AA8"/><stop offset="1" stop-color="#22085C"/></radialGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#FFE38A" stop-opacity="0.55"/><stop offset="1" stop-color="#FFE38A" stop-opacity="0"/></radialGradient>
  </defs>
  <circle cx="32" cy="32" r="31" fill="url(#gold)" stroke="#7A4400" stroke-width="1.2"/>
  <circle cx="32" cy="32" r="26.5" fill="url(#royal)"/>
  <circle cx="32" cy="32" r="23.5" fill="none" stroke="#FFD66B" stroke-width="1.2" stroke-dasharray="1.6 3.2" opacity="0.8"/>
  <circle cx="32" cy="27" r="16" fill="url(#glow)"/>
  <path d="M14.5 31 L18.5 14.5 L25.5 22.5 L32 9.5 L38.5 22.5 L45.5 14.5 L49.5 31 Z" fill="url(#gold)" stroke="#7A4400" stroke-width="1.3" stroke-linejoin="round"/>
  <rect x="14" y="29.5" width="36" height="6.5" rx="2.2" fill="url(#gold)" stroke="#7A4400" stroke-width="1.2"/>
  <circle cx="18.5" cy="14.5" r="2.7" fill="#FF2E63" stroke="#7A0022" stroke-width="0.8"/>
  <circle cx="32" cy="9.5" r="3.2" fill="#34D3FF" stroke="#00507A" stroke-width="0.8"/>
  <circle cx="45.5" cy="14.5" r="2.7" fill="#FF2E63" stroke="#7A0022" stroke-width="0.8"/>
  <circle cx="23" cy="32.8" r="1.5" fill="#FF2E63"/>
  <circle cx="32" cy="32.8" r="1.9" fill="#34D3FF"/>
  <circle cx="41" cy="32.8" r="1.5" fill="#FF2E63"/>
  <circle cx="32" cy="46" r="10" fill="url(#gold)" stroke="#7A4400" stroke-width="1.3"/>
  <circle cx="32" cy="46" r="7.4" fill="none" stroke="#9A5A00" stroke-width="1" opacity="0.8"/>
  <text x="32" y="50.6" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="900" fill="#7A4400">₹</text>
  <path d="M20 22 L27 17" stroke="#FFFFFF" stroke-width="1.6" stroke-linecap="round" opacity="0.65"/>
  <path transform="translate(53 46)" d="M0,-4 L1,-1 L4,0 L1,1 L0,4 L-1,1 L-4,0 L-1,-1 Z" fill="#FFF6C9"/>
  <path transform="translate(11 46)" d="M0,-3 L0.8,-0.8 L3,0 L0.8,0.8 L0,3 L-0.8,0.8 L-3,0 L-0.8,-0.8 Z" fill="#FFF6C9" opacity="0.85"/>
</svg>`;


// Sub Seller: silver sibling of the Coin Seller badge (teal medallion, small tiara, silver coin). Given by a top seller.
const subSeller = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFFFFF"/><stop offset="0.45" stop-color="#D5DDE8"/><stop offset="1" stop-color="#7C8BA1"/></linearGradient>
    <radialGradient id="teal" cx="0.5" cy="0.38" r="0.62"><stop offset="0" stop-color="#2DE1C2"/><stop offset="0.6" stop-color="#0E8C8C"/><stop offset="1" stop-color="#064450"/></radialGradient>
  </defs>
  <circle cx="32" cy="32" r="31" fill="url(#silver)" stroke="#4A5568" stroke-width="1.2"/>
  <circle cx="32" cy="32" r="26.5" fill="url(#teal)"/>
  <circle cx="32" cy="32" r="23.5" fill="none" stroke="#E2F7F4" stroke-width="1.2" stroke-dasharray="1.6 3.2" opacity="0.7"/>
  <path d="M19 30 L21.5 18 L27 24 L32 15 L37 24 L42.5 18 L45 30 Z" fill="url(#silver)" stroke="#4A5568" stroke-width="1.2" stroke-linejoin="round"/>
  <rect x="18.5" y="28.5" width="27" height="5.5" rx="2" fill="url(#silver)" stroke="#4A5568" stroke-width="1.1"/>
  <circle cx="32" cy="15" r="2.6" fill="#34D3FF" stroke="#00507A" stroke-width="0.8"/>
  <circle cx="32" cy="31.2" r="1.5" fill="#2DE1C2"/>
  <circle cx="32" cy="45" r="10" fill="url(#silver)" stroke="#4A5568" stroke-width="1.3"/>
  <circle cx="32" cy="45" r="7.4" fill="none" stroke="#64748B" stroke-width="1" opacity="0.8"/>
  <text x="32" y="49.6" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="900" fill="#334155">₹</text>
  <path d="M22 22 L27.5 18.5" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round" opacity="0.7"/>
</svg>`;
export const SAMPLE_BADGES = [
  { id: "coin_seller", name: "Coin Seller", description: "Authorised VoyaLive coin seller. Safe to buy coins from.", svg: coinSeller, sortOrder: 0 },
  { id: "sub_seller", name: "Sub Seller", description: "Authorised VoyaLive sub seller, appointed by a coin seller. Safe to buy coins from.", svg: subSeller, sortOrder: 0 },
  { id: "vip", name: "VIP", description: "A valued member of the VoyaLive family.", svg: vip, sortOrder: 1 },
  { id: "top_gifter", name: "Top Gifter", description: "Among the most generous gifters this week.", svg: topGifter, sortOrder: 2 },
  { id: "party_star", name: "Party Star", description: "Brings the energy to every room.", svg: partyStar, sortOrder: 3 },
  { id: "mic_master", name: "Mic Master", description: "Spent hours on stage keeping the party talking.", svg: micMaster, sortOrder: 4 },
];
