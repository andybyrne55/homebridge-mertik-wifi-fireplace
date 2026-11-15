/**
 * Status frames for tests. The first two are full frames captured from the real module (14–15 Nov 2026).
 * The others are the captured "off" frame with the height / flags / mode fields that were observed on the
 * real unit for that state (see docs/DESIGN.md §3 and the probe logs).
 */

export const CAPTURED_OFF =
  '0303000000034400820A0000000000BE010444696E696E6720526F6F6D2046697265FFFFFFFF000000000000000000000000FF4400';
export const CAPTURED_ON_FULL_AUX =
  '03030000000344FF828A0000000000BE010444696E696E6720526F6F6D2046697265FFFFFFFF000000000000000000000000FF4400';

/** Replace height (chars 14–16), flags (16–20) and optionally mode (24–28) in the captured off frame. */
export function withFields(height: string, flags: string, mode = '0000', base = CAPTURED_OFF): string {
  return base.substring(0, 14) + height + flags + base.substring(20, 24) + mode + base.substring(28);
}

export const IGNITING = withFields('00', '821A');
export const ON_AUX_OFF = withFields('B8', '8282');
export const ON_LOW_AUX = withFields('80', '828A');
export const SHUTTING_DOWN = withFields('80', '838A');
export const SHUTTING_DOWN_HEIGHT_ZERO = withFields('00', '838A');
export const STANDBY = withFields('00', '828A');
/** Guard bit glitch after a turn-down: flags read "off" while the flame is clearly lit. */
export const FALSE_OFF_LIT = withFields('80', '820A');
export const THERMOSTAT_HEATING = withFields('FF', '828A', '1002');
export const ECO = withFields('BB', '828A', '2000');
