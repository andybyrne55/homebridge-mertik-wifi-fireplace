/**
 * Mapping between HomeKit percentages and flame-height bytes. See docs/DESIGN.md §3 (behaviour 7) and §5.
 *
 * 1–100 % maps to 0x80–0xFF. 0x51–0x7F are only reachable going down and look the same as 0x80,
 * so any lit height below 0x80 is shown as 1 %. Below 0x50 the main burner is out.
 */

export const FLAME_MIN = 0x80;
export const FLAME_MAX = 0xff;
/** At or above this height the main burner is lit. */
export const LIT_THRESHOLD = 0x50;
/** Reported heights differ slightly from what was sent. */
export const FLAME_TOLERANCE = 8;

export function percentToByte(percent: number): number {
  const p = Math.max(1, Math.min(100, Math.round(Number.isFinite(percent) ? percent : 100)));
  return FLAME_MIN + Math.round((p * (FLAME_MAX - FLAME_MIN)) / 100);
}

/** 0 when the burner is out; otherwise 1–100. */
export function byteToPercent(byte: number): number {
  if (byte < LIT_THRESHOLD) {
    return 0;
  }
  if (byte <= FLAME_MIN) {
    return 1;
  }
  const p = Math.round(((byte - FLAME_MIN) * 100) / (FLAME_MAX - FLAME_MIN));
  return Math.max(1, Math.min(100, p));
}

export function flameMatches(reported: number, wanted: number): boolean {
  return Math.abs(reported - wanted) <= FLAME_TOLERANCE;
}
