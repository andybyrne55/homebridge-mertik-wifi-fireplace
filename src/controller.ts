/**
 * State machine for one fireplace: serial command queue, verified commands with retries,
 * handset-change detection and the view HomeKit displays. See docs/DESIGN.md §4 (controller.ts).
 *
 * Every command is: send -> verify from status -> retry -> result. Acks are ignored. Never throws.
 */

import { EventEmitter } from 'node:events';

import type { FireplaceLink } from './connection.js';
import type { FireplaceLogger } from './logger.js';
import * as cmd from './protocol/commands.js';
import { byteToPercent, FLAME_MAX, FLAME_TOLERANCE, flameMatches, percentToByte } from './protocol/flame.js';
import type { FireMode, FireplaceStatus, FireState } from './protocol/status.js';

/** `last`, `full`, or a percentage 1–100. */
export type IgniteLevel = 'last' | 'full' | number;

export interface ControllerOptions {
  commandRetries: number;
  igniteLevel: IgniteLevel;
  restoreFlameAfterBoost: boolean;
  shutOffAfterConnectionLoss: boolean;
  connectionLossMinutes: number;
  /** Raise the left-on alert after the main burner has been lit continuously this long. 0 = off. */
  leftOnAlertMs?: number;
  /** Also switch the fire off when the left-on alert is raised. */
  leftOnSwitchOff?: boolean;
}

export interface ControllerTiming {
  offResendMs: number;
  igniteTimeoutMs: number;
  igniteBitWaitMs: number;
  mainBurnerWaitMs: number;
  flameTimeoutMs: number;
  transientFfMs: number;
  auxTimeoutMs: number;
  auxFlameResetWaitMs: number;
  standbyTimeoutMs: number;
  sliderDebounceMs: number;
  reigniteLockoutMs: number;
  shutdownWaitMs: number;
  modeSettleMs: number;
  firstContactWarnMs: number;
  transientRecheckMs: number;
  unknownStateWaitMs: number;
  leftOnCheckMs: number;
  modeTimeoutMs: number;
  /** After the shutdown bit, how long to wait for the fire to actually report off. */
  offCompleteMs: number;
}

export const DEFAULT_CONTROLLER_TIMING: ControllerTiming = {
  offResendMs: 6_000,
  igniteTimeoutMs: 90_000,
  igniteBitWaitMs: 8_000,
  mainBurnerWaitMs: 15_000,
  flameTimeoutMs: 12_000,
  transientFfMs: 8_000,
  auxTimeoutMs: 10_000,
  auxFlameResetWaitMs: 4_000,
  standbyTimeoutMs: 12_000,
  sliderDebounceMs: 400,
  // Re-igniting 45-60 s after an off stopped at pilot or failed on the real unit; 3 min worked (15 Nov).
  reigniteLockoutMs: 180_000,
  shutdownWaitMs: 20_000,
  modeSettleMs: 1_000,
  firstContactWarnMs: 60_000,
  transientRecheckMs: 3_000,
  unknownStateWaitMs: 10_000,
  leftOnCheckMs: 30_000,
  modeTimeoutMs: 10_000,
  offCompleteMs: 30_000,
};

type Command =
  | { kind: 'off' }
  | { kind: 'on'; flameByte?: number; explicitFlame: boolean }
  | { kind: 'flame'; flameByte: number }
  | { kind: 'aux'; on: boolean }
  | { kind: 'standby' }
  | { kind: 'mode'; mode: FireMode; target?: number };

interface QueueItem {
  command: Command;
  promise: Promise<boolean>;
  resolve: (ok: boolean) => void;
}

interface Token {
  aborted: boolean;
  onAbort: Array<() => void>;
}

function abortToken(token: Token): void {
  if (!token.aborted) {
    token.aborted = true;
    for (const fn of token.onAbort.splice(0)) {
      fn();
    }
  }
}

interface Waiter {
  predicate: (status: FireplaceStatus) => boolean;
  done: (ok: boolean) => void;
}

export type DisplayPower = 'off' | 'pilot' | 'on';

/** What HomeKit should show. While a command is pending this is the target, not a stale reading. */
export interface FireplaceView {
  /** A status frame has been received at least once. */
  known: boolean;
  reachable: boolean;
  power: DisplayPower;
  /** Main burner lit right now (from status). */
  heating: boolean;
  igniting: boolean;
  /** 0 unless power is `on`. */
  flamePercent: number;
  aux: boolean;
  mode: FireMode;
  /** Thermostat target (°C), as stored in the fireplace or as just requested. */
  targetTemperature?: number;
  roomTemperature?: number;
  busy: boolean;
  /** Off could not be confirmed. Cleared when the fire is confirmed off. */
  alert: boolean;
  /** On (lit, or thermostat idling) continuously for longer than the left-on time. Cleared when it stops being on. */
  leftOnAlert: boolean;
}

type Category = 'off' | 'pilot' | 'igniting' | 'on';

function category(state: FireState): Category {
  return state === 'shuttingDown' ? 'off' : state;
}

/** Thermostat range the plugin offers: 5–36 °C in 0.5 °C steps. */
export const TARGET_MIN = 5;
export const TARGET_MAX = 36;

export function clampTarget(celsius: number): number {
  const c = Number.isFinite(celsius) ? celsius : 20;
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(c * 2) / 2));
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function hexByte(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, '0');
}

export class FireplaceController extends EventEmitter {
  private readonly timing: ControllerTiming;

  private status?: FireplaceStatus;
  private displayHeight = 0;
  private ffSince?: number;
  private lastFlameByte?: number;
  private lastShutdownAt?: number;
  private unreachableSince?: number;
  private everReachable = false;
  private shutOffOnNextStatus = false;
  private alert = false;
  private litSince?: number;
  private lastStatusAt?: number;
  /** Thermostat target set while the fire was off: applied at the next switch-on from HomeKit. */
  private savedTarget?: number;
  private lastIgniteSentAt?: number;
  private leftOnAlert = false;
  private leftOnTimer?: NodeJS.Timeout;

  private queue: QueueItem[] = [];
  private current?: QueueItem;
  private currentToken?: Token;
  private pumping = false;
  private readonly waiters = new Set<Waiter>();

  private desired: { power?: DisplayPower; flameByte?: number; aux?: boolean; mode?: FireMode; target?: number } = {};
  private targetTimer?: NodeJS.Timeout;
  private pendingTarget?: number;
  private targetResolvers: Array<(ok: boolean) => void> = [];
  private debounceTimer?: NodeJS.Timeout;
  private pendingFlameByte?: number;
  private debounceResolvers: Array<(ok: boolean) => void> = [];

  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(
    private readonly link: FireplaceLink,
    private readonly log: FireplaceLogger,
    private readonly options: ControllerOptions,
    timing: Partial<ControllerTiming> = {},
  ) {
    super();
    this.timing = { ...DEFAULT_CONTROLLER_TIMING, ...timing };
    link.on('status', (status) => this.guard('status', () => this.onStatus(status)));
    link.on('reachable', (reachable) => this.guard('reachable', () => this.onReachable(reachable)));
    if ((options.leftOnAlertMs ?? 0) > 0) {
      this.leftOnTimer = setInterval(() => this.guard('left-on', () => this.checkLeftOn()), this.timing.leftOnCheckMs);
    }
    this.later(this.timing.firstContactWarnMs, () => {
      if (!this.everReachable) {
        this.log.warn('Unreachable: no reply from the fireplace yet (check the IP address and that the WiFi module is powered)');
        this.unreachableSince = Date.now();
      }
    });
  }

  // ---------------------------------------------------------------- public API

  get view(): FireplaceView {
    const s = this.status;
    let power: DisplayPower = 'off';
    let heating = false;
    let igniting = false;
    let flameByte = 0;
    let aux = false;
    if (s) {
      aux = s.auxOn;
      switch (s.state) {
      case 'on':
        power = 'on';
        heating = true;
        flameByte = this.displayHeight;
        break;
      case 'igniting':
        power = 'on';
        igniting = true;
        break;
      case 'pilot':
        power = 'pilot';
        break;
      default:
        power = 'off';
      }
    }
    const d = this.desired;
    if (d.power) {
      power = d.power;
      if (power !== 'on') {
        flameByte = 0;
      } else if (d.flameByte !== undefined) {
        flameByte = d.flameByte;
      }
    }
    if (d.aux !== undefined) {
      aux = d.aux;
    }
    return {
      known: s !== undefined,
      reachable: this.link.reachable,
      power,
      heating,
      igniting,
      flamePercent: power === 'on' ? byteToPercent(flameByte) : 0,
      aux,
      mode: d.mode ?? s?.mode ?? 'manual',
      targetTemperature: d.target ?? this.savedTarget ?? s?.targetTemperature,
      roomTemperature: s?.roomTemperature,
      busy: this.busy,
      alert: this.alert,
      leftOnAlert: this.leftOnAlert,
    };
  }

  get busy(): boolean {
    return this.pumping || this.queue.length > 0 || this.debounceTimer !== undefined || this.targetTimer !== undefined;
  }

  get lastStatus(): FireplaceStatus | undefined {
    return this.status;
  }

  /** Switch off. Always sent, even if believed off. Clears the queue and pre-empts the running command. */
  requestOff(): Promise<boolean> {
    this.log.info('Off requested');
    this.cancelDebounce();
    clearTimeout(this.targetTimer);
    this.targetTimer = undefined;
    for (const r of this.targetResolvers.splice(0)) {
      r(false);
    }
    for (const item of this.queue) {
      item.resolve(false);
    }
    this.queue = [];
    if (this.current && this.current.command.kind !== 'off' && this.currentToken) {
      this.log.debug(`aborting running ${this.current.command.kind} command for off`);
      abortToken(this.currentToken);
      this.abortWaiters();
    }
    this.desired = { power: 'off' };
    const promise = this.enqueue({ kind: 'off' });
    this.emitUpdate();
    return promise;
  }

  /** Switch on (ignite if needed) at the configured ignite level. */
  requestOn(): Promise<boolean> {
    const existing = this.findItem('on');
    if (existing) {
      return existing.promise;
    }
    // HomeKit often sends Active=1 together with a slider change, or while the fire is already on:
    // that must not ignite again or reset the flame to the ignite level.
    const state = this.status?.state;
    const offPending = this.findItem('off') !== undefined;
    // Thermostat (or eco set on the handset) waiting at pilot is "on" too: switching on must not knock it back to manual.
    const autoWaiting = state === 'pilot' && this.status?.mode !== 'manual';
    if (!offPending && (this.desired.power === 'on' || state === 'on' || state === 'igniting' || autoWaiting)) {
      return Promise.resolve(true);
    }
    const flameByte = this.igniteTargetByte();
    this.desired = { ...this.desired, power: 'on', flameByte };
    const promise = this.enqueue({ kind: 'on', flameByte, explicitFlame: false });
    const saved = this.savedTarget;
    if (saved !== undefined) {
      this.desired = { ...this.desired, mode: 'thermostat', target: saved };
      const thermostat = this.enqueue({ kind: 'mode', mode: 'thermostat', target: saved });
      this.emitUpdate();
      return promise.then((lit) => (lit ? thermostat : false));
    }
    this.emitUpdate();
    return promise;
  }

  /**
   * Thermostat mode with this target (°C). Debounced like the slider. Never lights the fire: while the fire is
   * off the target is saved and applied at the next switch-on (HomeKit semantics for a heater's setpoint).
   */
  requestThermostat(target: number): Promise<boolean> {
    const t = clampTarget(target);
    const state = this.status?.state;
    const offNow = state === undefined || state === 'off' || state === 'shuttingDown' || this.desired.power === 'off';
    if (offNow && !this.findItem('on')) {
      this.savedTarget = t;
      this.log.info(`Thermostat ${t.toFixed(1)} °C saved – the fire stays off; switching it on starts thermostat mode`);
      this.emitUpdate();
      return Promise.resolve(true);
    }
    this.desired = { ...this.desired, mode: 'thermostat', target: t };
    this.pendingTarget = t;
    clearTimeout(this.targetTimer);
    const promise = new Promise<boolean>((resolve) => this.targetResolvers.push(resolve));
    this.targetTimer = setTimeout(() => this.guard('thermostat', () => {
      this.targetTimer = undefined;
      const resolvers = this.targetResolvers.splice(0);
      this.removeQueued((c) => c.kind === 'mode' || c.kind === 'flame' || c.kind === 'standby');
      void this.enqueue({ kind: 'mode', mode: 'thermostat', target: this.pendingTarget }).then((ok) => resolvers.forEach((r) => r(ok)));
    }), this.timing.sliderDebounceMs);
    this.emitUpdate();
    return promise;
  }

  /** Pilot only in manual mode (standby): no flame, and nothing but switch-on or the slider may relight it. */
  isManualStandby(): boolean {
    return this.status?.state === 'pilot' && this.status.mode === 'manual' && this.desired.power !== 'on' && !this.findItem('on');
  }

  /** Set the flame (byte 0x80–0xFF). Debounced; ignites first if the fire is off. Returns to manual mode. */
  requestFlame(flameByte: number): Promise<boolean> {
    this.savedTarget = undefined;
    this.removeQueued((c) => c.kind === 'mode');
    this.desired = { ...this.desired, power: 'on', flameByte, mode: 'manual' };
    this.pendingFlameByte = flameByte;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    const promise = new Promise<boolean>((resolve) => this.debounceResolvers.push(resolve));
    this.debounceTimer = setTimeout(() => this.guard('flame', () => this.commitFlame()), this.timing.sliderDebounceMs);
    this.emitUpdate();
    return promise;
  }

  /** Standby: main burner out, pilot stays lit. */
  requestStandby(): Promise<boolean> {
    this.cancelDebounce();
    this.removeQueued((c) => c.kind === 'flame' || c.kind === 'standby');
    this.desired = { ...this.desired, power: 'pilot', flameByte: undefined };
    const promise = this.enqueue({ kind: 'standby' });
    this.emitUpdate();
    return promise;
  }

  requestAux(on: boolean): Promise<boolean> {
    if (this.isManualStandby()) {
      this.log.warn('Boost ignored at pilot only: a boost change resets the flame to full and could relight the burner');
      this.emitUpdate();
      return Promise.resolve(false);
    }
    this.removeQueued((c) => c.kind === 'aux');
    this.desired = { ...this.desired, aux: on };
    const promise = this.enqueue({ kind: 'aux', on });
    this.emitUpdate();
    return promise;
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.leftOnTimer);
    clearTimeout(this.targetTimer);
    for (const r of this.targetResolvers.splice(0)) {
      r(false);
    }
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.cancelDebounce();
    for (const item of this.queue) {
      item.resolve(false);
    }
    this.queue = [];
    if (this.currentToken) {
      abortToken(this.currentToken);
    }
    this.abortWaiters();
  }

  // ---------------------------------------------------------------- status handling

  private onStatus(s: FireplaceStatus): void {
    const prev = this.status;
    const prevDisplay = this.displayHeight;
    const now = Date.now();
    this.status = s;
    this.lastStatusAt = now;
    this.updateDisplayHeight(prev, s, now);
    if (this.savedTarget !== undefined && !this.busy && (s.state === 'on' || s.state === 'igniting')) {
      this.savedTarget = undefined; // lit some other way (handset): the saved target no longer applies
    }

    if (!this.everReachable || (prev === undefined)) {
      this.everReachable = true;
      this.log.info(`Connected: ${this.describe(s)}`);
    }

    if (s.shuttingDown || (s.state === 'off' && prev && prev.state !== 'off' && prev.state !== 'shuttingDown')) {
      this.lastShutdownAt = now;
    }

    this.trackLitTime(s, now);

    if (this.alert && s.state === 'off') {
      this.alert = false;
      this.log.info('Fire confirmed off – shutdown alert cleared');
    }

    if (!this.busy && prev) {
      this.reportHandsetChange(prev, prevDisplay, s);
    }
    // Remember handset changes, but not the unit's small reporting offset (that would make the
    // remembered level drift down a few percent with every aux restore or re-ignition).
    if (!this.busy && s.state === 'on' && this.ffSince === undefined &&
      (this.lastFlameByte === undefined || !flameMatches(s.flameHeight, this.lastFlameByte))) {
      this.lastFlameByte = s.flameHeight;
    }

    if (this.shutOffOnNextStatus) {
      this.shutOffOnNextStatus = false;
      if (s.state !== 'off') {
        this.log.warn(`Connection was lost for at least ${this.options.connectionLossMinutes} min: switching the fire off`);
        void this.requestOff();
      }
    }

    for (const waiter of [...this.waiters]) {
      let match: boolean;
      try {
        match = waiter.predicate(s);
      } catch {
        match = false;
      }
      if (match) {
        waiter.done(true);
      }
    }
    this.emitUpdate();
  }

  /**
   * "On" time for the left-on alert: burner lit, or thermostat idling at pilot (so thermostat cycling does not
   * restart the clock). Manual standby (pilot only, no flame) does not count and resets it.
   */
  private trackLitTime(s: FireplaceStatus, now: number): void {
    if (s.state === 'on' || (s.state === 'pilot' && s.mode === 'thermostat')) {
      if (this.litSince === undefined) {
        this.litSince = now;
      }
      this.checkLeftOn();
      return;
    }
    if (s.state === 'igniting') {
      return;
    }
    this.litSince = undefined;
    if (this.leftOnAlert) {
      this.leftOnAlert = false;
      this.log.info('Fire is no longer on – left-on alert cleared');
    }
  }

  private checkLeftOn(): void {
    const limit = this.options.leftOnAlertMs ?? 0;
    if (limit <= 0 || this.litSince === undefined || this.leftOnAlert || Date.now() - this.litSince < limit) {
      return;
    }
    this.leftOnAlert = true;
    this.log.warn(`The fire has been on for ${formatDuration(Date.now() - this.litSince)} – left-on alert raised`);
    this.emit('leftOn');
    if (this.options.leftOnSwitchOff) {
      this.log.warn('Switching the fire off (left-on auto-off is enabled)');
      void this.requestOff();
    }
    this.emitUpdate();
  }

  private updateDisplayHeight(prev: FireplaceStatus | undefined, s: FireplaceStatus, now: number): void {
    // Turning down (handset or app) reads FF for a few seconds before the new value: hold the old value.
    const transient = prev !== undefined && prev.state === 'on' && s.state === 'on' && s.flameHeight === FLAME_MAX &&
      this.displayHeight < FLAME_MAX - FLAME_TOLERANCE && prev.auxOn === s.auxOn;
    if (transient) {
      if (this.ffSince === undefined) {
        this.ffSince = now;
        this.later(this.timing.transientRecheckMs, () => this.link.requestStatus());
      }
      if (now - this.ffSince < this.timing.transientFfMs) {
        return;
      }
    }
    this.ffSince = undefined;
    this.displayHeight = s.flameHeight;
  }

  private reportHandsetChange(prev: FireplaceStatus, prevDisplay: number, s: FireplaceStatus): void {
    const before = category(prev.state);
    const after = category(s.state);
    const auto = s.mode !== 'manual' && prev.mode === s.mode;
    if (auto && before !== after && (before === 'on' || before === 'pilot') && (after === 'on' || after === 'pilot')) {
      // The thermostat lighting / idling the burner by itself is not a handset change.
      this.log.info(after === 'on' ? 'Thermostat: heating' : 'Thermostat: room is warm enough, burner off (pilot on)');
    } else if (before !== after) {
      let what: string | undefined;
      switch (after) {
      case 'on':
        what = `${before === 'off' ? 'on' : 'lit'}, flame ${byteToPercent(this.displayHeight)} %`;
        break;
      case 'pilot':
        what = before === 'igniting' ? undefined : 'pilot only';
        break;
      case 'igniting':
        what = 'igniting';
        break;
      default:
        what = 'off';
      }
      if (what) {
        this.log.info(`Changed on handset: ${what}`);
      }
    } else if (after === 'on' && this.ffSince === undefined && !flameMatches(this.displayHeight, prevDisplay) &&
      !(prev.auxOn !== s.auxOn && s.flameHeight === FLAME_MAX)) {
      if (auto) {
        this.log.debug(`${s.mode}: flame ${byteToPercent(this.displayHeight)} %`);
      } else {
        this.log.info(`Changed on handset: flame ${byteToPercent(this.displayHeight)} %`);
      }
    }
    if (prev.mode === 'thermostat' && s.mode === 'thermostat' && Math.abs(prev.targetTemperature - s.targetTemperature) >= 0.1) {
      this.log.info(`Changed on handset: thermostat ${s.targetTemperature.toFixed(1)} °C`);
    }
    if (prev.auxOn !== s.auxOn) {
      this.log.info(`Changed on handset: boost ${s.auxOn ? 'on' : 'off'}`);
    }
    if (prev.mode !== s.mode && !(s.mode === 'manual' && (s.state === 'off' || s.state === 'shuttingDown'))) {
      this.log.info(`Changed on handset: ${s.mode} mode`);
    }
  }

  private onReachable(reachable: boolean): void {
    const now = Date.now();
    if (!reachable) {
      this.unreachableSince = this.lastStatusAt ?? now;
      this.log.warn('Unreachable');
    } else if (this.unreachableSince !== undefined) {
      const lostMs = now - this.unreachableSince;
      this.unreachableSince = undefined;
      if (this.everReachable) {
        this.log.info('Reachable again');
      }
      if (this.options.shutOffAfterConnectionLoss && this.everReachable && lostMs >= this.options.connectionLossMinutes * 60_000) {
        this.shutOffOnNextStatus = true;
      }
    }
    this.emitUpdate();
  }

  private describe(s: FireplaceStatus): string {
    let text: string;
    switch (s.state) {
    case 'on':
      text = `fire on, flame ${byteToPercent(s.flameHeight)} %`;
      break;
    case 'pilot':
      text = 'pilot only';
      break;
    case 'igniting':
      text = 'igniting';
      break;
    case 'shuttingDown':
      text = 'shutting down';
      break;
    default:
      text = 'fire off';
    }
    text += `, boost ${s.auxOn ? 'on' : 'off'}`;
    if (s.mode !== 'manual') {
      text += `, ${s.mode} mode`;
    }
    return text;
  }

  // ---------------------------------------------------------------- queue

  private enqueue(command: Command): Promise<boolean> {
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    this.queue.push({ command, promise, resolve });
    this.log.debug(`queued ${command.kind} (queue length ${this.queue.length})`);
    void this.pump();
    return promise;
  }

  private findItem(kind: Command['kind']): QueueItem | undefined {
    if (this.current?.command.kind === kind) {
      return this.current;
    }
    return this.queue.find((item) => item.command.kind === kind);
  }

  private removeQueued(predicate: (c: Command) => boolean): void {
    this.queue = this.queue.filter((item) => {
      if (predicate(item.command)) {
        this.log.debug(`dropping superseded ${item.command.kind}`);
        item.resolve(false);
        return false;
      }
      return true;
    });
  }

  private cancelDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    for (const r of this.debounceResolvers.splice(0)) {
      r(false);
    }
  }

  private commitFlame(): void {
    this.debounceTimer = undefined;
    const flameByte = this.pendingFlameByte;
    const resolvers = this.debounceResolvers.splice(0);
    if (flameByte === undefined) {
      resolvers.forEach((r) => r(false));
      return;
    }
    let promise: Promise<boolean>;
    const onItem = this.findItem('on');
    const offPending = this.findItem('off') !== undefined;
    const state = this.status?.state;
    if (onItem && onItem.command.kind === 'on') {
      onItem.command.flameByte = flameByte;
      onItem.command.explicitFlame = true;
      promise = onItem.promise;
    } else if (!offPending && (state === 'on' || state === 'pilot')) {
      this.removeQueued((c) => c.kind === 'flame' || c.kind === 'standby');
      promise = this.enqueue({ kind: 'flame', flameByte });
    } else {
      promise = this.enqueue({ kind: 'on', flameByte, explicitFlame: true });
    }
    this.desired = { ...this.desired, power: 'on', flameByte };
    void promise.then((ok) => resolvers.forEach((r) => r(ok)));
    this.emitUpdate();
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopped) {
        const item = this.queue.shift()!;
        const token: Token = { aborted: false, onAbort: [] };
        this.current = item;
        this.currentToken = token;
        this.link.setFastPolling(true);
        let ok = false;
        try {
          ok = await this.execute(item.command, token);
        } catch (err) {
          this.log.error(`Internal error while running ${item.command.kind}: ${String(err)}`);
          ok = false;
        }
        if (token.aborted) {
          ok = false;
        }
        this.current = undefined;
        this.currentToken = undefined;
        this.log.debug(`${item.command.kind} finished: ${ok ? 'ok' : 'failed'}`);
        item.resolve(ok);
      }
    } finally {
      this.pumping = false;
      this.link.setFastPolling(false);
      if (!this.debounceTimer && !this.targetTimer) {
        this.desired = {};
      }
      this.emitUpdate();
    }
  }

  private execute(command: Command, token: Token): Promise<boolean> {
    switch (command.kind) {
    case 'off':
      return this.execOff(token);
    case 'on':
      return this.execOn(command, token);
    case 'flame':
      return this.execFlame(command.flameByte, token);
    case 'aux':
      return this.execAux(command.on, token);
    case 'standby':
      return this.execStandby(token);
    case 'mode':
      return this.execMode(command, token);
    }
  }

  // ---------------------------------------------------------------- commands

  private async execOff(token: Token): Promise<boolean> {
    const t0 = Date.now();
    const retries = this.options.commandRetries;
    for (let attempt = 0; attempt <= retries && !token.aborted; attempt++) {
      if (attempt > 0) {
        this.log.warn(`Off not confirmed, retrying (${attempt}/${retries})`);
      }
      // Never let a hung send hold up the off (defence in depth; the real connection always settles).
      await Promise.race([this.send(token, cmd.off(), 'off'), new Promise((r) => setTimeout(r, this.timing.offResendMs))]);
      // Just after an ignite was written, an "off" frame may predate it: then require the shutdown bit
      // or two off frames in a row.
      const recentIgnite = this.lastIgniteSentAt !== undefined && Date.now() - this.lastIgniteSentAt < 15_000;
      let offFrames = 0;
      const started = await this.waitFor((s) => {
        if (s.shuttingDown) {
          return true;
        }
        if (s.state === 'off') {
          offFrames++;
          return !recentIgnite || offFrames >= 2;
        }
        offFrames = 0;
        return false;
      }, this.timing.offResendMs);
      if (token.aborted) {
        return false;
      }
      if (!started) {
        continue;
      }
      // The shutdown bit alone is not proof: wait until the fireplace actually reports off. If the shutdown ends
      // without the fire going off (two frames with no shutdown bit and not off), resend at once.
      let notShutting = 0;
      const off = this.status?.state === 'off' || await this.waitFor((s) => {
        if (s.state === 'off') {
          return true;
        }
        notShutting = s.shuttingDown ? 0 : notShutting + 1;
        return notShutting >= 2;
      }, this.timing.offCompleteMs);
      if (token.aborted) {
        return false;
      }
      if (off && this.status?.state === 'off') {
        this.log.info(`Off confirmed after ${this.secondsSince(t0)} s`);
        return true;
      }
      this.log.warn('Shutdown started but the fire did not go off');
    }
    if (token.aborted) {
      return false;
    }
    const mayBeLit = this.status !== undefined && this.status.state !== 'off';
    if (mayBeLit) {
      this.alert = true;
      this.log.error(`Off NOT confirmed after ${retries + 1} attempts – the fire may still be lit! Shutdown alert raised.`);
      this.emit('shutdownFailed');
    } else {
      this.log.warn(`Off could not be confirmed: the fireplace is unreachable (last known state: ${this.status ? 'off' : 'unknown'})`);
    }
    return false;
  }

  private async execOn(command: Extract<Command, { kind: 'on' }>, token: Token): Promise<boolean> {
    if (!this.status) {
      await this.waitFor(() => true, this.timing.unknownStateWaitMs);
      if (token.aborted) {
        return false;
      }
      if (!this.status) {
        this.log.warn('Cannot switch on: the fireplace is unreachable');
        return false;
      }
    }
    if (this.status.state === 'shuttingDown') {
      this.log.info('Waiting for the shutdown to finish before igniting');
      await this.waitFor((s) => s.state !== 'shuttingDown', this.timing.shutdownWaitMs);
      if (token.aborted) {
        return false;
      }
    }
    const state = this.status.state;
    if (state === 'on') {
      return command.explicitFlame && command.flameByte !== undefined ? this.execFlame(command.flameByte, token) : true;
    }
    if (state === 'pilot') {
      this.log.info('Relighting from pilot');
      return this.execFlame(command.flameByte ?? this.lastFlameByte ?? FLAME_MAX, token);
    }
    if (state === 'igniting') {
      this.log.info('Ignition already in progress, waiting for it');
      const done = await this.waitFor((s) => s.state === 'on' || s.state === 'pilot', this.timing.igniteTimeoutMs);
      if (!done || token.aborted) {
        return false;
      }
      if (this.status?.state === 'pilot') {
        await this.waitFor((s) => s.state === 'on', this.timing.mainBurnerWaitMs);
        if (token.aborted) {
          return false;
        }
        if (this.status?.state === 'pilot') {
          return this.execFlame(command.flameByte ?? this.lastFlameByte ?? FLAME_MAX, token);
        }
      }
    } else {
      const t0 = Date.now();
      const result = await this.execIgnite(token);
      if (result === 'failed' || token.aborted) {
        return false;
      }
      if (result === 'pilot') {
        // Pilot proven but the main burner stayed out: a flame command lights it (seen on the real unit).
        this.log.info('Pilot lit; lighting the main burner');
        const ok = await this.execFlame(command.flameByte ?? this.lastFlameByte ?? FLAME_MAX, token);
        if (ok) {
          this.log.info(`Lit after ${this.secondsSince(t0)} s`);
        }
        return ok;
      }
    }
    const target = command.flameByte;
    if (target !== undefined && this.status && !flameMatches(this.status.flameHeight, target)) {
      return this.execFlame(target, token);
    }
    return true;
  }

  private async execIgnite(token: Token): Promise<'on' | 'pilot' | 'failed'> {
    const now = Date.now();
    if (this.lastShutdownAt !== undefined && now - this.lastShutdownAt < this.timing.reigniteLockoutMs) {
      const ago = Math.round((now - this.lastShutdownAt) / 1000);
      const wait = Math.ceil((this.timing.reigniteLockoutMs - (now - this.lastShutdownAt)) / 1000);
      this.log.warn(`Ignite refused: the fire went off ${ago} s ago and needs ${Math.round(this.timing.reigniteLockoutMs / 1000)} s ` +
        `before it will light reliably (setting "reigniteWait"). Try again in ${wait} s.`);
      return 'failed';
    }
    this.log.info('Ignite requested');
    const t0 = Date.now();
    const started = (s: FireplaceStatus) => s.igniting || s.state === 'on';
    this.lastIgniteSentAt = Date.now();
    await this.send(token, cmd.ignite(), 'ignite');
    let ok = await this.waitFor(started, this.timing.igniteBitWaitMs);
    if (token.aborted) {
      return 'failed';
    }
    if (!ok) {
      this.log.warn('Ignition did not start, resending ignite');
      await this.send(token, cmd.ignite(), 'ignite (retry)');
      ok = await this.waitFor(started, this.timing.igniteBitWaitMs);
      if (token.aborted) {
        return 'failed';
      }
    }
    if (!ok) {
      this.log.error('Ignite failed: the fireplace did not start the ignition sequence');
      return 'failed';
    }
    // On the real unit the igniting bit can clear with no pilot flag for ~20 s before the pilot shows
    // (seen 15 Nov 2026), so "igniting ended" is not a failure. Only the timeout or a shutdown is.
    const remaining = Math.max(0, this.timing.igniteTimeoutMs - (Date.now() - t0));
    await this.waitFor((s) => s.state === 'on' || s.state === 'pilot' || s.shuttingDown, remaining);
    if (token.aborted) {
      return 'failed';
    }
    const state = this.status?.state;
    if (state === 'on') {
      this.displayHeight = this.status!.flameHeight;
      this.log.info(`Lit after ${this.secondsSince(t0)} s`);
      return 'on';
    }
    if (state === 'pilot') {
      const lit = await this.waitFor((s) => s.state === 'on' || s.shuttingDown, this.timing.mainBurnerWaitMs);
      if (token.aborted) {
        return 'failed';
      }
      if (lit && this.status?.state === 'on') {
        this.displayHeight = this.status.flameHeight;
        this.log.info(`Lit after ${this.secondsSince(t0)} s`);
        return 'on';
      }
      if (this.status?.state === 'pilot') {
        return 'pilot';
      }
    }
    if (this.status?.shuttingDown || this.status?.state === 'shuttingDown') {
      this.log.error(`Ignition stopped after ${this.secondsSince(t0)} s: the fire was switched off`);
    } else {
      this.log.error(`Ignition failed: no pilot flame within ${Math.round(this.timing.igniteTimeoutMs / 1000)} s`);
    }
    return 'failed';
  }

  private async execFlame(flameByte: number, token: Token, label = 'Flame'): Promise<boolean> {
    const s = this.status;
    const pct = byteToPercent(flameByte);
    if (!s || s.state === 'off' || s.state === 'shuttingDown' || s.state === 'igniting') {
      this.log.warn(`Flame ${pct} % not set: the fire is ${s ? (s.state === 'igniting' ? 'igniting' : 'off') : 'in an unknown state'}`);
      return false;
    }
    if (s.mode !== 'manual') {
      this.log.info(`Switching from ${s.mode} mode to manual`);
      await this.send(token, cmd.manualMode(), 'manual mode');
      await this.waitFor(() => false, this.timing.modeSettleMs);
      if (token.aborted) {
        return false;
      }
    }
    for (let attempt = 0; attempt < 2 && !token.aborted; attempt++) {
      if (attempt > 0) {
        this.log.warn(`${label} ${pct} % not confirmed, resending`);
      }
      await this.send(token, cmd.flameHeight(flameByte), `flame ${hexByte(flameByte)}`);
      const ok = await this.waitFor((st) => st.state === 'on' && flameMatches(st.flameHeight, flameByte), this.timing.flameTimeoutMs);
      if (token.aborted) {
        return false;
      }
      if (ok) {
        this.lastFlameByte = flameByte;
        this.ffSince = undefined;
        if (this.status) {
          this.displayHeight = this.status.flameHeight;
        }
        this.log.info(`${label} ${pct} %`);
        return true;
      }
    }
    if (!token.aborted) {
      const reported = this.status ? `${this.status.state}, height ${hexByte(this.status.flameHeight)}` : 'nothing';
      this.log.error(`${label} ${pct} % not confirmed (fireplace reports ${reported})`);
    }
    return false;
  }

  private async execAux(on: boolean, token: Token): Promise<boolean> {
    const flameBefore = this.lastFlameByte;
    const wasLit = this.status?.state === 'on';
    const word = on ? 'on' : 'off';
    const restore = this.options.restoreFlameAfterBoost && wasLit && flameBefore !== undefined && flameBefore < FLAME_MAX - FLAME_TOLERANCE;
    if (restore && this.desired.power !== 'off') {
      // The unit jumps to full on an aux change; show the level we are about to restore, not a flash of 100 %.
      this.desired = { ...this.desired, power: 'on', flameByte: flameBefore };
      this.emitUpdate();
    }
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok && !token.aborted; attempt++) {
      if (attempt > 0) {
        this.log.warn(`Boost ${word} not confirmed, resending`);
      }
      await this.send(token, cmd.aux(on), `boost (aux) ${word}`);
      ok = await this.waitFor((s) => s.auxOn === on, this.timing.auxTimeoutMs);
    }
    if (token.aborted) {
      return false;
    }
    if (!ok) {
      this.log.error(`Boost ${word} not confirmed`);
      return false;
    }
    this.log.info(`Boost ${word}`);
    if (restore && flameBefore !== undefined) {
      // The unit resets the flame to full on every aux change; wait for that before restoring.
      await this.waitFor((s) => s.state !== 'on' || s.flameHeight >= FLAME_MAX - FLAME_TOLERANCE, this.timing.auxFlameResetWaitMs);
      if (token.aborted || this.status?.state !== 'on') {
        return true;
      }
      await this.execFlame(flameBefore, token, 'Flame restored to');
    }
    return true;
  }

  private async execStandby(token: Token): Promise<boolean> {
    const s = this.status;
    if (!s) {
      this.log.warn('Standby not set: the fireplace is unreachable');
      return false;
    }
    if (s.state === 'off' || s.state === 'shuttingDown') {
      this.log.info('Standby requested but the fire is already off');
      return true;
    }
    if (s.mode !== 'manual') {
      this.log.info(`Switching from ${s.mode} mode to manual`);
      await this.send(token, cmd.manualMode(), 'manual mode');
      await this.waitFor(() => false, this.timing.modeSettleMs);
      if (token.aborted) {
        return false;
      }
    }
    if (this.status?.state === 'pilot') {
      return true;
    }
    for (let attempt = 0; attempt < 2 && !token.aborted; attempt++) {
      if (attempt > 0) {
        this.log.warn('Standby not confirmed, resending');
      }
      await this.send(token, cmd.standby(), 'standby');
      const ok = await this.waitFor((st) => st.state === 'pilot', this.timing.standbyTimeoutMs);
      if (token.aborted) {
        return false;
      }
      if (ok) {
        this.log.info('Standby (pilot only)');
        return true;
      }
    }
    if (!token.aborted) {
      this.log.error('Standby not confirmed');
    }
    return false;
  }

  private async execMode(command: Extract<Command, { kind: 'mode' }>, token: Token): Promise<boolean> {
    const want = command.mode;
    if (!this.status) {
      this.log.warn(`${want} mode not set: the fireplace is unreachable`);
      return false;
    }
    const isOff = (st: FireplaceStatus) => st.state === 'off' || st.state === 'shuttingDown';
    if (isOff(this.status)) {
      // Mode changes never light the fire (a scene or "all switches on" must not ignite a gas fire).
      if (want !== 'manual') {
        this.log.warn(`${want} mode not set: the fire is off`);
      }
      return want === 'manual';
    }
    const target = command.target !== undefined ? clampTarget(command.target) : undefined;
    const label = want === 'thermostat' && target !== undefined ? `Thermostat ${target.toFixed(1)} °C` : `${want[0].toUpperCase()}${want.slice(1)} mode`;
    const matches = (st: FireplaceStatus) => st.mode === want &&
      (target === undefined || Math.abs(st.targetTemperature - target) < 0.05);
    for (let attempt = 0; attempt < 2 && !token.aborted; attempt++) {
      if (attempt > 0) {
        this.log.warn(`${label} not confirmed, resending`);
      }
      if (want === 'thermostat') {
        if (this.status?.mode !== 'thermostat' || attempt > 0) {
          await this.send(token, cmd.thermostatMode(), 'thermostat mode');
        }
        if (target !== undefined) {
          await this.send(token, cmd.setTargetTemperature(target), `target ${target}`);
        }
      } else {
        await this.send(token, want === 'eco' ? cmd.ecoMode() : cmd.manualMode(), `${want} mode`);
      }
      const ok = (this.status !== undefined && attempt === 0 && matches(this.status) && want !== 'thermostat') ||
        await this.waitFor(matches, this.timing.modeTimeoutMs);
      if (token.aborted) {
        return false;
      }
      if (ok) {
        if (want === 'thermostat') {
          this.savedTarget = undefined;
        }
        this.log.info(label);
        return true;
      }
    }
    if (!token.aborted) {
      this.log.error(`${label} not confirmed (fireplace reports ${this.status?.mode} mode)`);
    }
    return false;
  }

  // ---------------------------------------------------------------- helpers

  private igniteTargetByte(): number {
    const level = this.options.igniteLevel;
    if (level === 'full') {
      return FLAME_MAX;
    }
    if (level === 'last') {
      return this.lastFlameByte !== undefined && this.lastFlameByte >= 0x80 ? this.lastFlameByte : FLAME_MAX;
    }
    return percentToByte(level);
  }

  /**
   * Send unless the command was aborted (an off pre-empted it). Never waits past an abort: a send that is
   * still reconnecting is abandoned and its bytes are not written.
   */
  private send(token: Token, data: Buffer, label: string): Promise<boolean> {
    if (token.aborted) {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      token.onAbort.push(() => resolve(false));
      this.link.send(data, label, () => token.aborted).then(resolve, () => resolve(false));
    });
  }

  /** Resolves true when a fresh status matches, false on timeout or abort. */
  private waitFor(predicate: (s: FireplaceStatus) => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      // A command that an off has pre-empted gets no new waits.
      if (this.stopped || this.currentToken?.aborted) {
        resolve(false);
        return;
      }
      let timer: NodeJS.Timeout | undefined = undefined;
      const waiter: Waiter = {
        predicate,
        done: (ok: boolean) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(ok);
        },
      };
      timer = setTimeout(() => waiter.done(false), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  private abortWaiters(): void {
    for (const waiter of [...this.waiters]) {
      waiter.done(false);
    }
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.guard('timer', fn);
    }, ms);
    this.timers.add(t);
  }

  private secondsSince(t0: number): number {
    return Math.round((Date.now() - t0) / 1000);
  }

  private emitUpdate(): void {
    try {
      this.emit('update', this.view);
    } catch (err) {
      this.log.error(`Internal error in update handler: ${String(err)}`);
    }
  }

  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.error(`Internal error (${what}): ${String(err)}`);
    }
  }
}
