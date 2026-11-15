/**
 * In-process TCP server that behaves like the Mertik WiFi module, reproducing behaviours 1–12 in
 * docs/DESIGN.md §3 (with shortened timings), plus fault injection for the controller tests.
 */

import { createServer, type Server, type Socket } from 'node:net';

export interface FakeTiming {
  igniteGuardMs: number;
  igniteFlameMs: number;
  offShutdownDelayMs: number;
  offHeightMs: number;
  offGuardMs: number;
  turnDownFfMs: number;
  guardGlitchMs: number;
  relightMs: number;
  auxDelayMs: number;
}

export const FAST_FAKE_TIMING: FakeTiming = {
  igniteGuardMs: 300,
  igniteFlameMs: 100,
  offShutdownDelayMs: 30,
  offHeightMs: 150,
  offGuardMs: 100,
  turnDownFfMs: 150,
  guardGlitchMs: 400,
  relightMs: 150,
  auxDelayMs: 30,
};

const PREFIX = '3030303080';

export class FakeFireplace {
  // device state
  height = 0;
  guard = false;
  igniting = false;
  shuttingDown = false;
  aux = true;
  mode = '0000';
  room = 190;
  target = 260;
  name = 'Dining Room Fire';
  private guardGlitch = false;

  // fault injection
  /** Ignore the next N off commands. */
  ignoreOff = 0;
  /** Ignore the next N ignite commands. */
  ignoreIgnite = 0;
  /** Ignition runs, then the pilot fails and the unit goes off. */
  igniteFails = false;
  /** Like the real unit on 15 Nov: igniting clears, no pilot flag for this long, then the pilot shows. */
  ignitionGapMs = 0;
  /** After ignition the main burner stays out (pilot only) until a flame command. */
  mainBurnerStaysOut = false;
  /** Leave the next N status requests unanswered. */
  dropStatusReplies = 0;
  /** Reported height = sent + skew (for lit values below FF). */
  heightSkew = -3;
  /** Split each reply into two TCP writes. */
  fragment = true;

  /** Every command payload received (after the prefix), in order. */
  readonly received: string[] = [];
  readonly clients = new Set<Socket>();
  port = 0;

  private server?: Server;
  private readonly timers = new Set<NodeJS.Timeout>();
  private ackToggle = false;

  constructor(private readonly t: FakeTiming = FAST_FAKE_TIMING) {}

  // ---------------------------------------------------------------- lifecycle

  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.onClient(socket));
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : port;
        this.server = server;
        resolve(this.port);
      });
    });
  }

  stop(): Promise<void> {
    for (const t of this.timers) {
      clearTimeout(t);
    }
    this.timers.clear();
    this.dropClients();
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  /** Stop listening and drop clients but keep the device state (simulates the module going offline). */
  async goOffline(): Promise<void> {
    this.dropClients();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = undefined;
  }

  dropClients(): void {
    for (const c of this.clients) {
      c.destroy();
    }
    this.clients.clear();
  }

  count(prefix: string): number {
    return this.received.filter((c) => c.startsWith(prefix)).length;
  }

  // ---------------------------------------------------------------- state helpers

  get lit(): boolean {
    return this.height >= 0x50;
  }

  setOn(height = 0xff, aux = true): void {
    this.height = height;
    this.guard = true;
    this.aux = aux;
    this.igniting = false;
    this.shuttingDown = false;
  }

  statusPayload(): string {
    let flags = 0x8202;
    if (this.shuttingDown) {
      flags |= 0x0100;
    }
    if (this.guard && !this.guardGlitch) {
      flags |= 0x0080;
    }
    if (this.igniting) {
      flags |= 0x0010;
    }
    if (this.aux) {
      flags |= 0x0008;
    }
    const h = (n: number, d: number) => n.toString(16).toUpperCase().padStart(d, '0');
    const name = Buffer.from(this.name.padEnd(16, ' ').substring(0, 16), 'ascii').toString('hex').toUpperCase();
    return '03030000000344' + h(this.height, 2) + h(flags, 4) + '0000' + this.mode + h(this.room, 4) + h(this.target, 4) +
      name + 'FFFFFFFF' + '000000000000000000000000FF' + '4400';
  }

  // ---------------------------------------------------------------- handset (pushes status to every client)

  handsetFlame(value: number): void {
    this.applyFlame(value, true);
  }

  handsetAux(on: boolean): void {
    this.applyAux(on, true);
  }

  handsetOff(): void {
    this.applyOff(true);
  }

  // ---------------------------------------------------------------- protocol

  private onClient(socket: Socket): void {
    this.clients.add(socket);
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let i: number;
      while ((i = buffer.indexOf('\x03')) !== -1) {
        let frame = buffer.substring(0, i);
        buffer = buffer.substring(i + 1).replace(/^\n/, '');
        const stx = frame.lastIndexOf('\x02');
        if (stx !== -1) {
          frame = frame.substring(stx + 1);
        }
        if (frame.startsWith(PREFIX)) {
          this.onCommand(socket, frame.substring(PREFIX.length));
        }
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => this.clients.delete(socket));
  }

  private onCommand(socket: Socket, command: string): void {
    this.received.push(command);
    if (command === '03') {
      if (this.dropStatusReplies > 0) {
        this.dropStatusReplies--;
        return;
      }
      this.reply(socket, this.statusPayload());
      return;
    }
    if (command === '1A') {
      this.reply(socket, '03030000001A');
      if (this.ignoreIgnite > 0) {
        this.ignoreIgnite--;
        return;
      }
      this.applyIgnite();
      return;
    }
    if (command === '10') {
      if (this.ignoreOff > 0) {
        this.ignoreOff--;
        return;
      }
      this.applyOff(false);
      return;
    }
    if (command.startsWith('16') && command.length === 4) {
      this.reply(socket, '030300000016');
      this.applyFlame(parseInt(command.substring(2), 16), false);
      return;
    }
    if (command === '2001' || command === '2000') {
      this.ackToggle = !this.ackToggle;
      if (this.ackToggle) {
        this.reply(socket, '0303000000' + command);
      }
      this.applyAux(command === '2001', false);
      return;
    }
    if (command === 'B0') {
      this.mode = '0000';
    } else if (command === 'B201') {
      if (this.guard && !this.shuttingDown) {
        this.mode = '1002';
        this.thermostatTick();
      }
    } else if (command.startsWith('B2FD') && command.length === 8) {
      this.target = parseInt(command.substring(4), 16);
      this.thermostatTick();
    } else if (command === 'B301') {
      if (this.guard && !this.shuttingDown) {
        this.mode = '2000';
        if (this.lit) {
          this.after(this.t.relightMs, () => {
            this.height = 0xbc;
          });
        }
      }
    }
  }

  /** Thermostat mode: light the burner while the room is below the target, idle at pilot above it (seen 15 Nov). */
  thermostatTick(push = false): void {
    if (this.mode !== '1002' || !this.guard || this.shuttingDown) {
      return;
    }
    const wantLit = this.room < this.target;
    if (wantLit && !this.lit) {
      this.after(this.t.relightMs, () => {
        this.height = 0xff;
      }, push);
    } else if (!wantLit && this.lit) {
      this.after(this.t.relightMs, () => {
        this.height = 0;
      }, push);
    }
  }

  private applyIgnite(): void {
    if (this.lit || this.igniting || this.shuttingDown) {
      return;
    }
    this.igniting = true;
    this.after(this.t.igniteGuardMs, () => {
      if (!this.igniting) {
        return;
      }
      this.igniting = false;
      if (this.igniteFails) {
        this.guard = false;
        return;
      }
      const pilot = () => {
        if (this.shuttingDown) {
          return;
        }
        this.guard = true;
        if (this.mainBurnerStaysOut) {
          return;
        }
        this.after(this.t.igniteFlameMs, () => {
          if (this.guard && !this.shuttingDown) {
            this.height = 0xff;
          }
        });
      };
      if (this.ignitionGapMs > 0) {
        this.after(this.ignitionGapMs, pilot);
      } else {
        pilot();
      }
    });
  }

  private applyOff(push: boolean): void {
    this.after(this.t.offShutdownDelayMs, () => {
      this.igniting = false;
      this.shuttingDown = true;
      this.after(this.t.offHeightMs, () => {
        this.height = 0;
        this.after(this.t.offGuardMs, () => {
          this.guard = false;
          this.shuttingDown = false;
          this.mode = '0000';
        }, push);
      }, push);
    }, push);
  }

  private reported(value: number): number {
    if (value >= 0xff || value < 0x80) {
      return value;
    }
    return Math.max(0x80, Math.min(0xfe, value + this.heightSkew));
  }

  private applyFlame(value: number, push: boolean): void {
    if (!this.guard || this.shuttingDown || this.igniting) {
      return; // off: flame commands do nothing
    }
    if (value === 0) {
      this.height = 0; // standby, guard stays on
      this.changed(push);
      return;
    }
    if (!this.lit) {
      // relight from pilot; below 80 snaps up to 80
      this.after(this.t.relightMs, () => {
        this.height = this.reported(Math.max(0x80, value));
      }, push);
      return;
    }
    if (value < this.height) {
      // turn-down: reads FF for a while, and the guard bit glitches to 0
      this.height = 0xff;
      this.guardGlitch = true;
      this.changed(push);
      this.after(this.t.turnDownFfMs, () => {
        this.height = this.reported(value);
      }, push);
      this.after(this.t.guardGlitchMs, () => {
        this.guardGlitch = false;
      });
    } else {
      this.height = this.reported(value);
      this.changed(push);
    }
  }

  private applyAux(on: boolean, push: boolean): void {
    this.after(this.t.auxDelayMs, () => {
      this.aux = on;
      if (this.lit) {
        this.height = 0xff;
      }
    }, push);
  }

  // ---------------------------------------------------------------- plumbing

  private after(ms: number, fn: () => void, push = false): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
      this.changed(push);
    }, ms);
    this.timers.add(t);
  }

  private changed(push: boolean): void {
    if (push) {
      for (const c of this.clients) {
        this.reply(c, this.statusPayload());
      }
    }
  }

  private readonly chains = new WeakMap<Socket, Promise<void>>();

  private reply(socket: Socket, payload: string): void {
    const data = Buffer.from('\x02' + payload + '\x03', 'latin1');
    const write = (part: Buffer) => {
      if (!socket.destroyed) {
        socket.write(part);
      }
    };
    const previous = this.chains.get(socket) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.fragment && data.length > 20) {
        write(data.subarray(0, 17));
        await new Promise((r) => setTimeout(r, 3));
        write(data.subarray(17));
      } else {
        write(data);
      }
    });
    this.chains.set(socket, next);
  }
}
