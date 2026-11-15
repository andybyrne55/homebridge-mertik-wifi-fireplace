/**
 * Socket lifecycle, framing, status polling and reconnect/backoff for one fireplace.
 * See docs/DESIGN.md §4 (connection.ts).
 */

import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';

import type { FireplaceLogger } from './logger.js';
import { statusRequest } from './protocol/commands.js';
import { FrameSplitter, parseFrame, type FireplaceStatus } from './protocol/status.js';

export interface ConnectionTiming {
  /** Idle poll interval. */
  pollIntervalMs: number;
  /** Poll interval while a command is being verified. */
  fastPollMs: number;
  /** No frame this long after a status request counts as a miss. */
  responseTimeoutMs: number;
  /** Consecutive misses before the socket is dropped and reopened. */
  maxMisses: number;
  /** Reachable = a status frame within this window. */
  reachableWindowMs: number;
  /** Before sending a command, reconnect if no frame within this window. */
  healthyWindowMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  connectTimeoutMs: number;
}

export const DEFAULT_CONNECTION_TIMING: ConnectionTiming = {
  pollIntervalMs: 15_000,
  fastPollMs: 2_000,
  responseTimeoutMs: 10_000,
  maxMisses: 2,
  reachableWindowMs: 60_000,
  healthyWindowMs: 30_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 30_000,
  connectTimeoutMs: 5_000,
};

/** What the controller needs from a connection (lets tests swap it). */
export interface FireplaceLink {
  readonly reachable: boolean;
  /** `cancelled` is checked just before writing (after any reconnect); if it returns true nothing is sent. */
  send(data: Buffer, label: string, cancelled?: () => boolean): Promise<boolean>;
  setFastPolling(on: boolean): void;
  requestStatus(): void;
  on(event: 'status', listener: (status: FireplaceStatus) => void): this;
  on(event: 'reachable', listener: (reachable: boolean) => void): this;
}

export class Connection extends EventEmitter implements FireplaceLink {
  private readonly timing: ConnectionTiming;
  private socket?: Socket;
  private connected = false;
  private connecting?: Promise<boolean>;
  private stopped = true;
  private readonly splitter = new FrameSplitter();

  private pollTimer?: NodeJS.Timeout;
  private responseTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private watchdogTimer?: NodeJS.Timeout;

  private backoffMs: number;
  private misses = 0;
  private fastPolling = false;
  private connectedAt = 0;
  private lastFrameAt = 0;
  private lastStatusAt = 0;
  private _reachable = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly log: FireplaceLogger,
    timing: Partial<ConnectionTiming> = {},
  ) {
    super();
    this.timing = { ...DEFAULT_CONNECTION_TIMING, ...timing };
    this.backoffMs = this.timing.backoffMinMs;
  }

  get reachable(): boolean {
    return this._reachable;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.watchdogTimer = setInterval(() => this.checkReachable(), Math.min(5_000, this.timing.reachableWindowMs / 4));
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.watchdogTimer);
    clearTimeout(this.reconnectTimer);
    this.teardown();
  }

  setFastPolling(on: boolean): void {
    if (this.fastPolling === on) {
      return;
    }
    this.fastPolling = on;
    if (on) {
      this.requestStatus();
    } else {
      this.schedulePoll();
    }
  }

  /** Ask for a status frame now (and restart the poll cycle). */
  requestStatus(): void {
    if (!this.connected || !this.socket) {
      return;
    }
    this.write(statusRequest(), undefined);
    if (!this.responseTimer) {
      this.responseTimer = setTimeout(() => this.onMiss(), this.timing.responseTimeoutMs);
    }
    this.schedulePoll();
  }

  /**
   * Send a command. Reconnects first if the socket is not healthy. Resolves false if it could not be sent
   * (never rejects). Success of the command itself must be verified from status.
   */
  async send(data: Buffer, label: string, cancelled?: () => boolean): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    if (!this.connected && this.connecting) {
      await this.connecting;
    }
    if (!this.isHealthy()) {
      this.log.debug(`socket not healthy before "${label}", reconnecting`);
      this.teardown();
      clearTimeout(this.reconnectTimer);
      const ok = await this.connect();
      if (!ok) {
        this.log.debug(`could not connect to send "${label}"`);
        return false;
      }
    }
    if (cancelled?.()) {
      this.log.debug(`"${label}" cancelled before sending`);
      return false;
    }
    return this.write(data, label);
  }

  private isHealthy(): boolean {
    if (!this.connected || !this.socket) {
      return false;
    }
    const lastSign = Math.max(this.lastFrameAt, this.connectedAt);
    return Date.now() - lastSign < this.timing.healthyWindowMs;
  }

  private write(data: Buffer, label: string | undefined): boolean {
    const socket = this.socket;
    if (!socket || !this.connected || socket.destroyed) {
      return false;
    }
    if (label) {
      this.log.debug(`send ${label}: ${data.toString('hex')}`);
    }
    try {
      socket.write(data);
      return true;
    } catch (err) {
      this.log.debug(`write failed: ${String(err)}`);
      return false;
    }
  }

  private connect(): Promise<boolean> {
    if (this.connected) {
      return Promise.resolve(true);
    }
    if (this.connecting) {
      return this.connecting;
    }
    const attempt: Promise<boolean> = new Promise<boolean>((resolve) => {
      const socket = new Socket();
      this.socket = socket;
      let settled = false;
      let connectTimer: NodeJS.Timeout | undefined = undefined;
      const settle = (ok: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          if (this.connecting === attempt) {
            this.connecting = undefined;
          }
          resolve(ok);
        }
      };
      connectTimer = setTimeout(() => {
        this.log.debug(`connect to ${this.host}:${this.port} timed out`);
        socket.destroy();
      }, this.timing.connectTimeoutMs);

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 10_000);
      socket.on('connect', () => {
        if (this.socket !== socket) {
          return;
        }
        this.connected = true;
        this.connectedAt = Date.now();
        this.misses = 0;
        this.backoffMs = this.timing.backoffMinMs;
        this.splitter.reset();
        this.log.debug(`connected to ${this.host}:${this.port}`);
        settle(true);
        this.requestStatus();
      });
      socket.on('data', (chunk: Buffer) => {
        if (this.socket === socket) {
          this.onData(chunk);
        }
      });
      socket.on('error', (err) => {
        this.log.debug(`socket error: ${err.message}`);
      });
      socket.on('close', () => {
        settle(false);
        if (this.socket === socket) {
          this.log.debug('socket closed');
          this.teardown();
          this.scheduleReconnect();
        }
      });
      try {
        socket.connect(this.port, this.host);
      } catch (err) {
        this.log.debug(`connect failed: ${String(err)}`);
        socket.destroy();
      }
    });
    this.connecting = attempt;
    return attempt;
  }

  private teardown(): void {
    clearTimeout(this.pollTimer);
    clearTimeout(this.responseTimer);
    this.pollTimer = undefined;
    this.responseTimer = undefined;
    this.connected = false;
    this.connecting = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners('data');
      socket.on('error', () => undefined);
      socket.destroy();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.timing.backoffMaxMs);
    this.log.debug(`reconnecting in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private reconnectNow(reason: string): void {
    this.log.debug(`dropping connection: ${reason}`);
    this.teardown();
    this.scheduleReconnect();
  }

  private schedulePoll(): void {
    clearTimeout(this.pollTimer);
    if (!this.connected) {
      return;
    }
    const delay = this.fastPolling ? this.timing.fastPollMs : this.timing.pollIntervalMs;
    this.pollTimer = setTimeout(() => this.requestStatus(), delay);
  }

  private onMiss(): void {
    this.responseTimer = undefined;
    this.misses++;
    this.log.debug(`no reply to status request (miss ${this.misses}/${this.timing.maxMisses})`);
    if (this.misses >= this.timing.maxMisses) {
      this.misses = 0;
      this.reconnectNow('no replies');
    } else {
      this.requestStatus();
    }
  }

  private onData(chunk: Buffer): void {
    for (const payload of this.splitter.push(chunk)) {
      this.lastFrameAt = Date.now();
      this.misses = 0;
      clearTimeout(this.responseTimer);
      this.responseTimer = undefined;
      let parsed;
      try {
        parsed = parseFrame(payload);
      } catch (err) {
        this.log.debug(`could not parse frame ${payload}: ${String(err)}`);
        continue;
      }
      if (parsed.type === 'status') {
        this.lastStatusAt = this.lastFrameAt;
        this.log.debug(`status ${payload}`);
        this.setReachable(true);
        this.safeEmit('status', parsed.status);
      } else if (parsed.type === 'ack') {
        this.log.debug(`ack ${parsed.echo}`);
        this.safeEmit('ack', parsed.echo);
      } else {
        this.log.debug(`unknown frame ${payload}`);
      }
    }
  }

  private checkReachable(): void {
    if (this._reachable && Date.now() - this.lastStatusAt > this.timing.reachableWindowMs) {
      this.setReachable(false);
    }
  }

  private setReachable(value: boolean): void {
    if (this._reachable !== value) {
      this._reachable = value;
      this.safeEmit('reachable', value);
    }
  }

  private safeEmit(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args);
    } catch (err) {
      this.log.error(`internal error in ${event} handler: ${String(err)}`);
    }
  }
}
