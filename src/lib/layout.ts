export const SEAT_LAYOUTS = {
  4: [4], // live streams only: host + 3 co-hosts (audio rooms are created with 8-20)
  8: [4, 4],
  10: [5, 5],
  12: [4, 4, 4],
  16: [4, 4, 4, 4],
  20: [5, 5, 5, 5],
} as const;

export type SeatCount = keyof typeof SEAT_LAYOUTS;
export const SEAT_COUNTS = Object.keys(SEAT_LAYOUTS).map(Number) as SeatCount[];

// Row-major, index 0 = first cell of first row = host.
export function seatPositions(seatCount: SeatCount) {
  return SEAT_LAYOUTS[seatCount].flatMap((cols, rowIndex) =>
    Array.from({ length: cols }, (_, columnIndex) => ({ rowIndex, columnIndex })),
  ).map((p, seatIndex) => ({ seatIndex, ...p }));
}
