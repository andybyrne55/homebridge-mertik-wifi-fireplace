/**
 * Config parsing and validation. Invalid entries are reported and skipped; this never throws.
 * See docs/DESIGN.md §6.
 */

import { isIP } from 'node:net';

import type { IgniteLevel } from './controller.js';

export type TileType = 'heater' | 'fan';
export type ZeroPercent = 'off' | 'pilot';
export type AlertSensor = 'none' | 'contact' | 'leak';

export interface FireplaceConfig {
  name: string;
  ip: string;
  port: number;
  tileType: TileType;
  zeroPercent: ZeroPercent;
  igniteLevel: IgniteLevel;
  boostSwitch: boolean;
  restoreFlameAfterBoost: boolean;
  alertSensor: AlertSensor;
  shutOffAfterConnectionLoss: boolean;
  connectionLossMinutes: number;
  pollInterval: number;
  commandRetries: number;
  reigniteWait: number;
  leftOnAlertHours: number;
  leftOnSwitchOff: boolean;
  childLockSwitch: boolean;
  thermostatControl: boolean;
  debug: boolean;
}

export const CONFIG_DEFAULTS = {
  port: 2000,
  tileType: 'heater' as TileType,
  zeroPercent: 'off' as ZeroPercent,
  igniteLevel: 'last' as IgniteLevel,
  boostSwitch: true,
  restoreFlameAfterBoost: true,
  alertSensor: 'contact' as AlertSensor,
  shutOffAfterConnectionLoss: false,
  connectionLossMinutes: 5,
  pollInterval: 15,
  commandRetries: 3,
  reigniteWait: 180,
  leftOnAlertHours: 4,
  leftOnSwitchOff: false,
  childLockSwitch: true,
  thermostatControl: true,
  debug: false,
};

export interface ValidationResult {
  /** Present unless name or ip is unusable. */
  config?: FireplaceConfig;
  /** Problems that make the entry unusable (name, ip). */
  errors: string[];
  /** Optional settings that were invalid and replaced by their defaults. */
  warnings: string[];
}

const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateFireplace(raw: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isRecord(raw)) {
    return { errors: ['entry is not an object'], warnings };
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) {
    errors.push('"name" is required');
  }
  const ip = typeof raw.ip === 'string' ? raw.ip.trim() : '';
  if (!ip) {
    errors.push('"ip" is required');
  } else if (!isIP(ip) && !HOSTNAME.test(ip)) {
    errors.push(`"ip" is not a valid IP address or host name: ${ip}`);
  }

  const int = (key: string, def: number, min: number, max: number): number => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') {
      return def;
    }
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      warnings.push(`"${key}" must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)})`);
      return def;
    }
    return n;
  };
  const num = (key: string, def: number, minExclusive: number, max: number): number => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') {
      return def;
    }
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || n <= minExclusive || n > max) {
      warnings.push(`"${key}" must be a number above ${minExclusive} and at most ${max} (got ${JSON.stringify(v)})`);
      return def;
    }
    return n;
  };
  const bool = (key: string, def: boolean): boolean => {
    const v = raw[key];
    if (v === undefined || v === null) {
      return def;
    }
    if (typeof v !== 'boolean') {
      warnings.push(`"${key}" must be true or false (got ${JSON.stringify(v)})`);
      return def;
    }
    return v;
  };
  const choice = <T extends string>(key: string, def: T, allowed: readonly T[]): T => {
    const v = raw[key];
    if (v === undefined || v === null || v === '') {
      return def;
    }
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      warnings.push(`"${key}" must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`);
      return def;
    }
    return v as T;
  };

  // The port is part of the accessory's identity: never fall back silently (that would replace the accessory).
  let port: number = CONFIG_DEFAULTS.port;
  if (raw.port !== undefined && raw.port !== null && raw.port !== '') {
    const p = typeof raw.port === 'number' ? raw.port : Number(raw.port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) {
      port = p;
    } else {
      errors.push(`"port" must be a whole number from 1 to 65535 (got ${JSON.stringify(raw.port)})`);
    }
  }

  let igniteLevel: IgniteLevel = CONFIG_DEFAULTS.igniteLevel;
  const rawLevel = raw.igniteLevel;
  if (rawLevel !== undefined && rawLevel !== null && rawLevel !== '') {
    if (rawLevel === 'last' || rawLevel === 'full') {
      igniteLevel = rawLevel;
    } else {
      const n = typeof rawLevel === 'number' ? rawLevel : Number(rawLevel);
      if (Number.isInteger(n) && n >= 1 && n <= 100) {
        igniteLevel = n;
      } else {
        warnings.push(`"igniteLevel" must be "last", "full" or a percentage from 1 to 100 (got ${JSON.stringify(rawLevel)})`);
      }
    }
  }

  const config: FireplaceConfig = {
    name,
    ip,
    port,
    tileType: choice('tileType', CONFIG_DEFAULTS.tileType, ['heater', 'fan'] as const),
    zeroPercent: choice('zeroPercent', CONFIG_DEFAULTS.zeroPercent, ['off', 'pilot'] as const),
    igniteLevel,
    boostSwitch: bool('boostSwitch', CONFIG_DEFAULTS.boostSwitch),
    restoreFlameAfterBoost: bool('restoreFlameAfterBoost', CONFIG_DEFAULTS.restoreFlameAfterBoost),
    alertSensor: choice('alertSensor', CONFIG_DEFAULTS.alertSensor, ['none', 'contact', 'leak'] as const),
    shutOffAfterConnectionLoss: bool('shutOffAfterConnectionLoss', CONFIG_DEFAULTS.shutOffAfterConnectionLoss),
    connectionLossMinutes: num('connectionLossMinutes', CONFIG_DEFAULTS.connectionLossMinutes, 0, 1440),
    pollInterval: int('pollInterval', CONFIG_DEFAULTS.pollInterval, 5, 60),
    commandRetries: int('commandRetries', CONFIG_DEFAULTS.commandRetries, 0, 5),
    reigniteWait: int('reigniteWait', CONFIG_DEFAULTS.reigniteWait, 30, 900),
    leftOnAlertHours: raw.leftOnAlertHours === 0 || raw.leftOnAlertHours === '0' ? 0 : num('leftOnAlertHours', CONFIG_DEFAULTS.leftOnAlertHours, 0, 24),
    leftOnSwitchOff: bool('leftOnSwitchOff', CONFIG_DEFAULTS.leftOnSwitchOff),
    childLockSwitch: bool('childLockSwitch', CONFIG_DEFAULTS.childLockSwitch),
    thermostatControl: bool('thermostatControl', CONFIG_DEFAULTS.thermostatControl),
    debug: bool('debug', CONFIG_DEFAULTS.debug),
  };

  return errors.length ? { errors, warnings } : { config, errors, warnings };
}
