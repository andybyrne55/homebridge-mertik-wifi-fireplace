/**
 * Dynamic platform: config validation, accessory restore/creation/removal. See docs/DESIGN.md §4–6.
 */

import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';

import { FireplaceAccessory } from './accessory.js';
import { validateFireplace, type FireplaceConfig } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Seed for accessory UUIDs. Never change it: HomeKit identifies the accessory (room, scenes, automations) by this UUID.
 * It predates the package rename, which is why it differs from PLUGIN_NAME.
 */
const ACCESSORY_ID_SEED = 'homebridge-mertik-wifi';

interface AccessoryContext {
  ip?: string;
  port?: number;
  /** Child lock state, persisted with the cached accessory. */
  childLock?: boolean;
}

export class MertikWifiFireplacePlatform implements DynamicPlatformPlugin {
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
    let rejected = 0;
    entries.forEach((raw, index) => {
      const { config, errors, warnings } = validateFireplace(raw);
      const label0 = typeof (raw as { name?: unknown })?.name === 'string' ? `"${(raw as { name: string }).name}"` : `#${index + 1}`;
      for (const w of warnings) {
        this.log.warn(`Fireplace ${label0}: ${w} – using the default instead`);
      }
      if (!config) {
        rejected++;
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
      const uuid = this.api.hap.uuid.generate(`${ACCESSORY_ID_SEED}:${config.ip}:${config.port}`);
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
    if (stale.length && rejected > 0) {
      // A fireplace entry could not be used: keep its accessory (rooms, scenes, automations) until the config is fixed.
      this.log.warn(`Keeping ${stale.length} cached fireplace accessory(s) because a fireplace entry has errors; fix the config to remove them.`);
    } else if (stale.length) {
      for (const a of stale) {
        this.log.info(`Removing fireplace "${a.displayName}" (no longer in the config)`);
      }
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
