/**
 * Pure decoder for status frames, plus the stream splitter. See docs/DESIGN.md §3.
 */

import { ETX, STX } from './commands.js';
import { LIT_THRESHOLD } from './flame.js';

export type FireMode = 'manual' | 'thermostat' | 'eco';

/**
 * - `off`: burner and pilot out
 * - `pilot`: pilot only – manual standby (mode manual) or thermostat idle (mode thermostat)
 * - `igniting`: ignition sequence running
 * - `on`: main burner lit
 * - `shuttingDown`: off sequence running
 */
export type FireState = 'off' | 'pilot' | 'igniting' | 'on' | 'shuttingDown';

export interface FireplaceStatus {
  /** The 106-char ASCII payload the status was decoded from. */
  raw: string;
  /** 0x00–0xFF. 0x00 = main burner out, 0x80 = lowest lit, 0xFF = full. */
  flameHeight: number;
  /** 16-bit flags word. */
  flags: number;
  shuttingDown: boolean;
  /** Guard (pilot) flame bit. Unreliable after a turn-down – never derive "off" from it alone. */
  guardFlame: boolean;
  igniting: boolean;
  auxOn: boolean;
  modeRaw: string;
  mode: FireMode;
  /** °C */
  roomTemperature: number;
  /** °C */
  targetTemperature: number;
  deviceName: string;
  state: FireState;
}

export type ParsedFrame =
  | { type: 'status'; status: FireplaceStatus }
  | { type: 'ack'; payload: string; echo: string }
  | { type: 'unknown'; payload: string };

/** Flag bits, numbered from the most significant bit (bit 0 = 0x8000). */
export const FLAG_BITS = {
  shuttingDown: 7,
  guardFlame: 8,
  igniting: 11,
  aux: 12,
} as const;

export function flagBit(flags: number, index: number): boolean {
  return ((flags >> (15 - index)) & 1) === 1;
}

const HEX = /^[0-9A-Fa-f]+$/;
const ACK_PREFIX = '0303000000';
const STATUS_MIN_LENGTH = 68;

export function decodeMode(modeRaw: string): FireMode {
  switch (modeRaw.charAt(0)) {
  case '1':
    return 'thermostat';
  case '2':
    return 'eco';
  default:
    return 'manual';
  }
}

export function deriveState(flameHeight: number, shuttingDown: boolean, guardFlame: boolean, igniting: boolean): FireState {
  if (shuttingDown) {
    return 'shuttingDown';
  }
  if (igniting) {
    return 'igniting';
  }
  if (flameHeight >= LIT_THRESHOLD) {
    return 'on';
  }
  return guardFlame ? 'pilot' : 'off';
}

function decodeName(payload: string): string {
  let end = payload.length;
  for (let i = 36; i + 8 <= payload.length; i += 2) {
    if (payload.substring(i, i + 8).toUpperCase() === 'FFFFFFFF') {
      end = i;
      break;
    }
  }
  if (end === payload.length) {
    end = Math.min(68, payload.length);
  }
  let name = '';
  for (let i = 36; i + 2 <= end; i += 2) {
    const code = parseInt(payload.substring(i, i + 2), 16);
    if (code >= 0x20 && code < 0x7f) {
      name += String.fromCharCode(code);
    }
  }
  return name.trim();
}

/** Decode a status payload (without STX/ETX). Returns undefined if it is not a status frame. */
export function decodeStatus(payload: string): FireplaceStatus | undefined {
  if (payload.length < STATUS_MIN_LENGTH || !HEX.test(payload) || !payload.startsWith('0303')) {
    return undefined;
  }
  const flameHeight = parseInt(payload.substring(14, 16), 16);
  const flags = parseInt(payload.substring(16, 20), 16);
  const modeRaw = payload.substring(24, 28);
  const shuttingDown = flagBit(flags, FLAG_BITS.shuttingDown);
  const guardFlame = flagBit(flags, FLAG_BITS.guardFlame);
  const igniting = flagBit(flags, FLAG_BITS.igniting);
  return {
    raw: payload,
    flameHeight,
    flags,
    shuttingDown,
    guardFlame,
    igniting,
    auxOn: flagBit(flags, FLAG_BITS.aux),
    modeRaw,
    mode: decodeMode(modeRaw),
    roomTemperature: parseInt(payload.substring(28, 32), 16) / 10,
    targetTemperature: parseInt(payload.substring(32, 36), 16) / 10,
    deviceName: decodeName(payload),
    state: deriveState(flameHeight, shuttingDown, guardFlame, igniting),
  };
}

/** Classify one frame payload (the ASCII between STX and ETX). */
export function parseFrame(payload: string): ParsedFrame {
  const status = decodeStatus(payload);
  if (status) {
    return { type: 'status', status };
  }
  if (payload.startsWith(ACK_PREFIX) && payload.length < STATUS_MIN_LENGTH) {
    return { type: 'ack', payload, echo: payload.substring(ACK_PREFIX.length) };
  }
  return { type: 'unknown', payload };
}

/**
 * TCP reads do not align with frames: buffer bytes and split on ETX.
 * A frame may arrive in several reads, and one read may hold several frames.
 */
export class FrameSplitter {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxBuffer = 4096) {}

  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : Buffer.from(chunk);
    const frames: string[] = [];
    let index: number;
    while ((index = this.buffer.indexOf(ETX)) !== -1) {
      let frame = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      const start = frame.lastIndexOf(STX);
      if (start !== -1) {
        frame = frame.subarray(start + 1);
      }
      const text = frame.toString('latin1').replace(/[\r\n\s]/g, '');
      if (text.length) {
        frames.push(text);
      }
    }
    if (this.buffer.length > this.maxBuffer) {
      // Garbage without an ETX: drop it rather than grow forever.
      this.buffer = Buffer.alloc(0);
    }
    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
