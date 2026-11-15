/**
 * HomeKit services <-> FireplaceController. See docs/DESIGN.md §5.
 *
 * Never a Lightbulb: "turn on all the lights" must not ignite a gas fire.
 */

import type { Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { FireplaceConfig } from './config.js';
import { Connection } from './connection.js';
import { clampTarget, FireplaceController, TARGET_MAX, TARGET_MIN, type FireplaceView } from './controller.js';
import { FireplaceLogger, type LogSink } from './logger.js';
import type { MertikWifiFireplacePlatform } from './platform.js';
import { percentToByte } from './protocol/flame.js';

type CharacteristicType = WithUUID<new () => Characteristic>;

export class FireplaceAccessory {
  readonly controller: FireplaceController;
  private readonly connection: Connection;
  private readonly log: FireplaceLogger;
  private readonly main: Service;
  private readonly auxService?: Service;
  private readonly alertService?: Service;
  private readonly leftOnService?: Service;
  private readonly lockService?: Service;
  private readonly ecoService?: Service;
  private lastReachable?: boolean;

  constructor(
    private readonly platform: MertikWifiFireplacePlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: FireplaceConfig,
    sink: LogSink,
  ) {
    const { Service: S, Characteristic: C } = platform;
    this.log = new FireplaceLogger(sink, config.name, config.debug);
    this.connection = new Connection(config.ip, config.port, this.log, { pollIntervalMs: config.pollInterval * 1000 });
    this.controller = new FireplaceController(this.connection, this.log, {
      commandRetries: config.commandRetries,
      igniteLevel: config.igniteLevel,
      restoreFlameAfterAux: config.restoreFlameAfterAux,
      shutOffAfterConnectionLoss: config.shutOffAfterConnectionLoss,
      connectionLossMinutes: config.connectionLossMinutes,
      leftOnAlertMs: config.leftOnAlertHours * 3_600_000,
      leftOnSwitchOff: config.leftOnSwitchOff,
    }, { reigniteLockoutMs: config.reigniteWait * 1000 });

    accessory.getService(S.AccessoryInformation)!
      .setCharacteristic(C.Manufacturer, 'Mertik Maxitrol')
      .setCharacteristic(C.Model, 'WiFi fireplace module')
      .setCharacteristic(C.SerialNumber, `${config.ip}:${config.port}`);

    // ---- main service (heater or fan); remove the other type if the tile type changed
    const heater = config.tileType === 'heater';
    const stale = accessory.getService(heater ? S.Fanv2 : S.HeaterCooler);
    if (stale) {
      accessory.removeService(stale);
    }
    const legacyLight = accessory.getService(S.Lightbulb);
    if (legacyLight) {
      accessory.removeService(legacyLight);
    }
    this.main = accessory.getService(heater ? S.HeaterCooler : S.Fanv2) ?? accessory.addService(heater ? S.HeaterCooler : S.Fanv2, config.name);
    this.main.setCharacteristic(C.Name, config.name);

    this.main.getCharacteristic(C.Active)
      .onGet(() => this.read((v) => (v.power === 'off' ? C.Active.INACTIVE : C.Active.ACTIVE)))
      .onSet((value) => this.write('Active', () => {
        this.checkLock(value === C.Active.ACTIVE, 'switching the fire on');
        if (value === C.Active.ACTIVE) {
          void this.controller.requestOn();
        } else {
          void this.controller.requestOff();
        }
      }));

    this.main.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(() => this.read((v) => v.flamePercent))
      .onSet((value) => this.write('RotationSpeed', () => {
        this.checkLock(Number(value) > 0, 'changing the flame');
        this.setFlamePercent(value);
      }));

    if (heater) {
      this.main.getCharacteristic(C.CurrentHeaterCoolerState)
        .onGet(() => this.read((v) => this.heaterState(v)));
      // Set the value before restricting validValues, or HAP warns that the default (0) is not allowed.
      this.main.getCharacteristic(C.TargetHeaterCoolerState).updateValue(C.TargetHeaterCoolerState.HEAT);
      this.main.getCharacteristic(C.TargetHeaterCoolerState)
        .setProps({ validValues: [C.TargetHeaterCoolerState.HEAT] })
        .onGet(() => C.TargetHeaterCoolerState.HEAT)
        .onSet(() => undefined);
      this.main.getCharacteristic(C.CurrentTemperature)
        .onGet(() => this.read((v) => this.temperature(v)));
      if (config.thermostatControl) {
        // Setting a target temperature puts the fire in thermostat mode; moving the flame slider returns to manual.
        // Value first, then limits: the HAP default (0) is below the 5 °C minimum and would log a warning.
        this.main.getCharacteristic(C.HeatingThresholdTemperature).updateValue(clampTarget(20));
        this.main.getCharacteristic(C.HeatingThresholdTemperature)
          .setProps({ minValue: TARGET_MIN, maxValue: TARGET_MAX, minStep: 0.5 })
          .onGet(() => this.read((v) => clampTarget(v.targetTemperature ?? 20)))
          .onSet((value) => this.write('HeatingThresholdTemperature', () => {
            this.checkLock(true, 'changing the thermostat');
            void this.controller.requestThermostat(Number(value));
          }));
      } else if (this.main.testCharacteristic(C.HeatingThresholdTemperature)) {
        this.main.removeCharacteristic(this.main.getCharacteristic(C.HeatingThresholdTemperature));
      }
    }

    // ---- aux switch
    this.auxService = this.optionalService(S.Switch, 'aux', config.auxSwitch, `${config.name} Aux`);
    this.auxService?.getCharacteristic(C.On)
      .onGet(() => this.read((v) => v.aux))
      .onSet((value) => this.write('Aux', () => {
        this.checkLock(true, 'switching aux');
        void this.controller.requestAux(value === true);
      }));

    // ---- shutdown alert sensor (trips only on a confirmed shutdown failure)
    const wantContact = config.alertSensor === 'contact';
    const wantLeak = config.alertSensor === 'leak';
    const contact = this.optionalService(S.ContactSensor, 'alert', wantContact, `${config.name} Shutdown Alert`);
    const leak = this.optionalService(S.LeakSensor, 'alert', wantLeak, `${config.name} Shutdown Alert`);
    this.alertService = contact ?? leak;
    contact?.getCharacteristic(C.ContactSensorState)
      .onGet(() => (this.controller.view.alert ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED));
    leak?.getCharacteristic(C.LeakDetected)
      .onGet(() => (this.controller.view.alert ? C.LeakDetected.LEAK_DETECTED : C.LeakDetected.LEAK_NOT_DETECTED));

    // ---- eco switch
    this.ecoService = this.optionalService(S.Switch, 'eco', config.ecoSwitch, `${config.name} Eco`);
    this.ecoService?.getCharacteristic(C.On)
      .onGet(() => this.read((v) => v.mode === 'eco'))
      .onSet((value) => this.write('Eco', () => {
        this.checkLock(true, 'changing eco mode');
        void (value === true ? this.controller.requestEco() : this.controller.requestManual());
      }));

    // ---- left-on alert sensor (same sensor type as the shutdown alert)
    const wantLeftOn = config.leftOnAlertHours > 0;
    const leftOnContact = this.optionalService(S.ContactSensor, 'leftOn', wantContact && wantLeftOn, `${config.name} Left On`);
    const leftOnLeak = this.optionalService(S.LeakSensor, 'leftOn', wantLeak && wantLeftOn, `${config.name} Left On`);
    this.leftOnService = leftOnContact ?? leftOnLeak;
    leftOnContact?.getCharacteristic(C.ContactSensorState)
      .onGet(() => (this.controller.view.leftOnAlert ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED));
    leftOnLeak?.getCharacteristic(C.LeakDetected)
      .onGet(() => (this.controller.view.leftOnAlert ? C.LeakDetected.LEAK_DETECTED : C.LeakDetected.LEAK_NOT_DETECTED));

    // ---- child lock: blocks HomeKit from lighting the fire or changing it; off always works
    this.lockService = this.optionalService(S.Switch, 'childLock', config.childLockSwitch, `${config.name} Child Lock`);
    this.lockService?.getCharacteristic(C.On)
      .onGet(() => this.locked)
      .onSet((value) => this.write('Child lock', () => {
        this.accessory.context.childLock = value === true;
        this.platform.api.updatePlatformAccessories([this.accessory]);
        this.log.info(`Child lock ${value === true ? 'on' : 'off'}`);
      }));

    this.controller.on('update', (view: FireplaceView) => this.refresh(view));
  }

  start(): void {
    this.connection.start();
  }

  stop(): void {
    this.controller.stop();
    this.connection.stop();
  }

  // ---------------------------------------------------------------- HomeKit -> controller

  private setFlamePercent(value: CharacteristicValue): void {
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct <= 0) {
      if (this.config.zeroPercent === 'pilot') {
        void this.controller.requestStandby();
      } else {
        void this.controller.requestOff();
      }
      return;
    }
    void this.controller.requestFlame(percentToByte(pct));
  }

  private get locked(): boolean {
    return this.config.childLockSwitch && this.accessory.context.childLock === true;
  }

  /** Refuse a HomeKit command that would light the fire or change it while the child lock is on. */
  private checkLock(blockedAction: boolean, what: string): void {
    if (blockedAction && this.locked) {
      this.log.warn(`Child lock is on: ${what} from HomeKit was refused`);
      setTimeout(() => this.refresh(this.controller.view, true), 50);
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
    }
  }

  private write(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (err instanceof this.platform.api.hap.HapStatusError) {
        throw err;
      }
      this.log.error(`Internal error handling ${what}: ${String(err)}`);
    }
  }

  // ---------------------------------------------------------------- controller -> HomeKit

  private read<T extends CharacteristicValue>(fn: (view: FireplaceView) => T): T {
    const view = this.controller.view;
    if (!view.reachable && !view.busy) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return fn(view);
  }

  private heaterState(v: FireplaceView): number {
    const C = this.platform.Characteristic.CurrentHeaterCoolerState;
    if (v.power === 'off') {
      return C.INACTIVE;
    }
    return v.heating ? C.HEATING : C.IDLE;
  }

  private temperature(v: FireplaceView): number {
    const t = v.roomTemperature;
    return t === undefined || !Number.isFinite(t) ? 0 : Math.max(0, Math.min(100, t));
  }

  private refresh(view: FireplaceView, force = false): void {
    try {
      const C = this.platform.Characteristic;
      const recovered = force || (view.reachable && this.lastReachable === false);
      if (!view.reachable && !view.busy && view.known && this.lastReachable !== false) {
        const error = new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        this.main.updateCharacteristic(C.Active, error);
      }
      this.lastReachable = view.reachable;
      this.set(this.main, C.Active, view.power === 'off' ? C.Active.INACTIVE : C.Active.ACTIVE, recovered);
      this.set(this.main, C.RotationSpeed, view.flamePercent, recovered);
      if (this.config.tileType === 'heater') {
        this.set(this.main, C.CurrentHeaterCoolerState, this.heaterState(view), recovered);
        if (view.roomTemperature !== undefined) {
          this.set(this.main, C.CurrentTemperature, this.temperature(view), recovered);
        }
      }
      if (this.auxService) {
        this.set(this.auxService, C.On, view.aux, recovered);
      }
      if (this.alertService) {
        if (this.config.alertSensor === 'contact') {
          this.set(this.alertService, C.ContactSensorState,
            view.alert ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED, recovered);
        } else {
          this.set(this.alertService, C.LeakDetected, view.alert ? C.LeakDetected.LEAK_DETECTED : C.LeakDetected.LEAK_NOT_DETECTED, recovered);
        }
      }
      if (this.leftOnService) {
        if (this.config.alertSensor === 'contact') {
          this.set(this.leftOnService, C.ContactSensorState,
            view.leftOnAlert ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED, recovered);
        } else {
          this.set(this.leftOnService, C.LeakDetected, view.leftOnAlert ? C.LeakDetected.LEAK_DETECTED : C.LeakDetected.LEAK_NOT_DETECTED, recovered);
        }
      }
      if (this.lockService) {
        this.set(this.lockService, C.On, this.locked, recovered);
      }
      if (this.ecoService) {
        this.set(this.ecoService, C.On, view.mode === 'eco', recovered);
      }
      if (this.config.tileType === 'heater' && this.config.thermostatControl && view.targetTemperature !== undefined) {
        this.set(this.main, C.HeatingThresholdTemperature, clampTarget(view.targetTemperature), recovered);
      }
    } catch (err) {
      this.log.error(`Internal error updating HomeKit: ${String(err)}`);
    }
  }

  private set(service: Service, type: CharacteristicType, value: CharacteristicValue, force: boolean): void {
    const characteristic = service.getCharacteristic(type);
    if (force || characteristic.value !== value) {
      characteristic.updateValue(value);
    }
  }

  private optionalService(type: WithUUID<typeof Service>, subtype: string, wanted: boolean, name: string): Service | undefined {
    const C = this.platform.Characteristic;
    const existing = this.accessory.getServiceById(type, subtype);
    if (!wanted) {
      if (existing) {
        this.accessory.removeService(existing);
      }
      return undefined;
    }
    if (existing) {
      existing.setCharacteristic(C.Name, name);
      return existing;
    }
    const service = this.accessory.addService(type, name, subtype);
    service.setCharacteristic(C.Name, name);
    service.addOptionalCharacteristic(C.ConfiguredName);
    service.setCharacteristic(C.ConfiguredName, name);
    return service;
  }
}
