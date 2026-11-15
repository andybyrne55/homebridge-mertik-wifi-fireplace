/**
 * Dynamic platform: config validation, accessory restore/creation/removal. See docs/DESIGN.md §4–6.
 */

import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { FireplaceAccessory } from './accessory.js';
import { validateFireplace, type FireplaceConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

interface AccessoryContext {
  ip?: string;
  port?: number;
}

export class MertikWifiPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;

  private readonly cached = new Map<string, PlatformAccessory<AccessoryContext>>();
  private readonly fireplaces: FireplaceAccessory[] = [];

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    api.on('didFinishLaunching', () => {
      try {
        this.setup();
      } catch (err) {
        this.log.error(`Could not start: ${String(err)}`);
      }
    });
    api.on('shutdown', () => {
      for (const f of this.fireplaces) {
        f.stop();
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory as PlatformAccessory<AccessoryContext>);
  }

  private setup(): void {
    const entries = Array.isArray(this.config?.fireplaces) ? (this.config.fireplaces as unknown[]) : [];
    if (!entries.length) {
      this.log.warn('No fireplaces configured – the plugin is not starting. Add a fireplace in the plugin settings.');
    }

    const configs: FireplaceConfig[] = [];
    const seen = new Set<string>();
    entries.forEach((raw, index) => {
      const { config, errors } = validateFireplace(raw);
      if (!config) {
        const label = typeof (raw as { name?: unknown })?.name === 'string' ? `"${(raw as { name: string }).name}"` : `#${index + 1}`;
        this.log.error(`Fireplace ${label} skipped – invalid config: ${errors.join('; ')}`);
        return;
      }
      const key = `${config.ip}:${config.port}`;
      if (seen.has(key)) {
        this.log.error(`Fireplace "${config.name}" skipped – ${key} is already configured`);
        return;
      }
      seen.add(key);
      configs.push(config);
    });

    const keep = new Set<string>();
    for (const config of configs) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${config.ip}:${config.port}`);
      keep.add(uuid);
      let accessory = this.cached.get(uuid);
      const isNew = !accessory;
      if (!accessory) {
        accessory = new this.api.platformAccessory<AccessoryContext>(config.name, uuid);
      }
      accessory.context.ip = config.ip;
      accessory.context.port = config.port;
      const fireplace = new FireplaceAccessory(this, accessory, config, this.log);
      this.fireplaces.push(fireplace);
      if (isNew) {
        this.log.info(`Adding fireplace "${config.name}" (${config.ip}:${config.port})`);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      } else {
        this.api.updatePlatformAccessories([accessory]);
      }
      fireplace.start();
    }

    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      for (const a of stale) {
        this.log.info(`Removing fireplace "${a.displayName}" (no longer in the config)`);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
