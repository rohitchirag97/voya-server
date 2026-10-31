// Staff access switches. A role (staff_roles, made in the admin panel > Roles) holds any set of these; the owner has
// all. Each one opens a panel menu or an app power, and the server checks it on every request (services/roles.ts).
export const PERMISSIONS = [
  { key: "users.view", group: "Users", label: "See users" },
  { key: "users.ban", group: "Users", label: "Ban and unban" },
  { key: "users.specialId", group: "Users", label: "Set Special IDs" },
  { key: "roles.assign", group: "Users", label: "Assign roles" },
  { key: "roles.manage", group: "Users", label: "Create and edit roles" },
  { key: "sellers.manage", group: "Money", label: "Coin sellers" },
  { key: "coins.mint", group: "Money", label: "Mint coins to sellers" },
  { key: "salaries.pay", group: "Money", label: "Salaries" },
  { key: "withdrawals.decide", group: "Money", label: "Withdrawals" },
  { key: "grants.give", group: "Money", label: "Give to user" },
  { key: "gifts.manage", group: "Content", label: "Gifts" },
  { key: "events.manage", group: "Content", label: "Events" },
  { key: "events.payout", group: "Content", label: "Approve event rewards" },
  { key: "notices.manage", group: "Content", label: "Notices" },
  { key: "items.manage", group: "Content", label: "Items" },
  { key: "svip.manage", group: "Content", label: "SVIP designs" },
  { key: "agencies.manage", group: "Content", label: "Agencies" },
  { key: "support.general", group: "In the app", label: "Answer General support" },
  { key: "support.svip", group: "In the app", label: "Answer SVIP support" },
  { key: "rooms.pin", group: "In the app", label: "Pin rooms" },
] as const;
export type Permission = (typeof PERMISSIONS)[number]["key"];
export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key) as Permission[];

// The owner's role: fixed, every switch, exactly one person (users_single_owner).
export const OWNER_ROLE = "OWNER";
// The colour only the owner's tick uses.
export const OWNER_GOLD = "#F5B301";
