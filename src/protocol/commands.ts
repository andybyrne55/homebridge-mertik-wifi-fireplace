/**
 * Pure encoders for every command the Mertik WiFi module understands.
 *
 * Wire format: STX (0x02) + ASCII payload + ETX (0x03). The payload is the ASCII prefix
 * "3030303080" followed by the command in ASCII. Aux commands get an extra LF after ETX.
 * See docs/DESIGN.md §3.
 */

export const STX = 0x02;
export const ETX = 0x03;
export const LF = 0x0a;

const PREFIX = '3030303080';

function frame(command: string, trailingLf = false): Buffer {
  const parts = [Buffer.from([STX]), Buffer.from(PREFIX + command, 'ascii'), Buffer.from([ETX])];
  if (trailingLf) {
    parts.push(Buffer.from([LF]));
  }
  return Buffer.concat(parts);
}

function hex(value: number, digits: number): string {
  return value.toString(16).toUpperCase().padStart(digits, '0');
}

/** Read-only status request. */
export function statusRequest(): Buffer {
  return frame('03');
}

/** Light the pilot and then the main burner (takes ~40 s). */
export function ignite(): Buffer {
  return frame('1A');
}

/** Pilot and burner off. */
export function off(): Buffer {
  return frame('10');
}

/**
 * Set the flame height. 0x80–0xFF is the usable range; 0x00 is standby (pilot only).
 * Values are clamped to a byte and rounded.
 */
export function flameHeight(value: number): Buffer {
  const byte = Math.max(0, Math.min(0xff, Math.round(Number.isFinite(value) ? value : 0)));
  return frame('16' + hex(byte, 2));
}

/** Standby: main burner out, pilot stays lit. */
export function standby(): Buffer {
  return frame('1600');
}

export function auxOn(): Buffer {
  return frame('2001', true);
}

export function auxOff(): Buffer {
  return frame('2000', true);
}

export function aux(on: boolean): Buffer {
  return on ? auxOn() : auxOff();
}

export function manualMode(): Buffer {
  return frame('B0');
}

export function thermostatMode(): Buffer {
  return frame('B201');
}

export function ecoMode(): Buffer {
  return frame('B301');
}

/** Thermostat target in °C, sent as °C × 10. */
export function setTargetTemperature(celsius: number): Buffer {
  const tenths = Math.max(0, Math.min(0xffff, Math.round(celsius * 10)));
  return frame('B2FD' + hex(tenths, 4));
}
