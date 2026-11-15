import { strict as assert } from 'node:assert';
import { after, afterEach, describe, it } from 'node:test';

import { Connection, type ConnectionTiming } from '../src/connection.js';
import { FireplaceController, type ControllerOptions, type ControllerTiming, type FireplaceView } from '../src/controller.js';
import { FireplaceLogger, type LogSink } from '../src/logger.js';
import { byteToPercent } from '../src/protocol/flame.js';
import { FakeFireplace } from './fake-fireplace.js';

const FAST_CONN: Partial<ConnectionTiming> = {
  pollIntervalMs: 300,
  fastPollMs: 50,
  responseTimeoutMs: 200,
  maxMisses: 2,
  reachableWindowMs: 1_000,
  healthyWindowMs: 800,
  backoffMinMs: 50,
  backoffMaxMs: 200,
  connectTimeoutMs: 500,
};

const FAST_CTRL: Partial<ControllerTiming> = {
  offResendMs: 300,
  igniteTimeoutMs: 3_000,
  igniteBitWaitMs: 300,
  flameTimeoutMs: 600,
  transientFfMs: 400,
  auxTimeoutMs: 500,
  auxFlameResetWaitMs: 300,
  standbyTimeoutMs: 600,
  sliderDebounceMs: 50,
  reigniteLockoutMs: 600,
  shutdownWaitMs: 1_500,
  modeSettleMs: 50,
  firstContactWarnMs: 5_000,
  transientRecheckMs: 150,
  unknownStateWaitMs: 500,
};

const DEFAULT_OPTIONS: ControllerOptions = {
  commandRetries: 3,
  igniteLevel: 'last',
  restoreFlameAfterAux: true,
  shutOffAfterConnectionLoss: false,
  connectionLossMinutes: 5,
};

interface Rig {
  fake: FakeFireplace;
  conn: Connection;
  ctrl: FireplaceController;
  logs: string[];
  views: FireplaceView[];
}

const rigs: Rig[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(cond: () => boolean, timeoutMs = 3_000, what = 'condition'): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(10);
  }
}

async function setup(
  prepare: (fake: FakeFireplace) => void = () => undefined,
  options: Partial<ControllerOptions> = {},
  connTiming: Partial<ConnectionTiming> = {},
): Promise<Rig> {
  const fake = new FakeFireplace();
  prepare(fake);
  await fake.start();
  const logs: string[] = [];
  const sink: LogSink = {
    info: (m) => logs.push('INFO ' + m),
    warn: (m) => logs.push('WARN ' + m),
    error: (m) => logs.push('ERROR ' + m),
    debug: () => undefined,
  };
  const log = new FireplaceLogger(sink, 'Fire', false);
  const conn = new Connection('127.0.0.1', fake.port, log, { ...FAST_CONN, ...connTiming });
  const ctrl = new FireplaceController(conn, log, { ...DEFAULT_OPTIONS, ...options }, FAST_CTRL);
  const views: FireplaceView[] = [];
  ctrl.on('update', (v: FireplaceView) => views.push(v));
  conn.start();
  const rig = { fake, conn, ctrl, logs, views };
  rigs.push(rig);
  await waitUntil(() => ctrl.view.known && ctrl.view.reachable, 3_000, 'first status');
  return rig;
}

async function teardown(): Promise<void> {
  for (const r of rigs.splice(0)) {
    r.ctrl.stop();
    r.conn.stop();
    await r.fake.stop();
  }
}

function has(logs: string[], text: string): boolean {
  return logs.some((l) => l.includes(text));
}

afterEach(teardown);
after(teardown);

describe('off', () => {
  it('is verified and the view shows off', async () => {
    const { ctrl, logs } = await setup((f) => f.setOn());
    assert.equal(ctrl.view.power, 'on');
    assert.equal(await ctrl.requestOff(), true);
    assert.ok(has(logs, 'Off confirmed after'));
    await waitUntil(() => ctrl.lastStatus?.state === 'off', 2_000, 'state off');
    assert.equal(ctrl.view.power, 'off');
    assert.equal(ctrl.view.alert, false);
  });

  it('is sent even when believed off', async () => {
    const { ctrl, fake } = await setup();
    assert.equal(await ctrl.requestOff(), true);
    assert.equal(fake.count('10'), 1);
  });

  it('retries when the fireplace ignores it', async () => {
    const { ctrl, fake, logs } = await setup((f) => {
      f.setOn();
      f.ignoreOff = 2;
    });
    assert.equal(await ctrl.requestOff(), true);
    assert.equal(fake.count('10'), 3);
    assert.ok(has(logs, 'Off not confirmed, retrying (1/3)'));
    assert.ok(has(logs, 'Off not confirmed, retrying (2/3)'));
    assert.equal(ctrl.view.alert, false);
  });

  it('raises the alert after all retries fail, and clears it when the fire is confirmed off', async () => {
    const { ctrl, fake, logs } = await setup((f) => {
      f.setOn();
      f.ignoreOff = 99;
    });
    let failed = 0;
    ctrl.on('shutdownFailed', () => failed++);
    assert.equal(await ctrl.requestOff(), false);
    assert.equal(fake.count('10'), 4);
    assert.equal(failed, 1);
    assert.equal(ctrl.view.alert, true);
    assert.equal(ctrl.view.power, 'on', 'shows the true state, not the target');
    assert.ok(has(logs, 'Off NOT confirmed'));
    fake.handsetOff();
    await waitUntil(() => !ctrl.view.alert, 2_000, 'alert cleared');
    assert.ok(has(logs, 'shutdown alert cleared'));
  });

  it('does not raise the alert for mere unreachability when the fire was off', async () => {
    const { ctrl, fake, logs } = await setup();
    await fake.goOffline();
    await waitUntil(() => !ctrl.view.reachable, 3_000, 'unreachable');
    assert.equal(await ctrl.requestOff(), false);
    assert.equal(ctrl.view.alert, false);
    assert.ok(has(logs, 'Unreachable'));
    assert.ok(has(logs, 'Off could not be confirmed'));
  });

  it('jumps the queue and pre-empts a running ignite', async () => {
    const { ctrl, fake } = await setup();
    const on = ctrl.requestOn();
    await waitUntil(() => fake.igniting, 2_000, 'igniting');
    const flame = ctrl.requestFlame(0x90);
    const off = ctrl.requestOff();
    assert.equal(ctrl.view.power, 'off', 'HomeKit shows the target at once');
    assert.equal(await off, true);
    assert.equal(await on, false);
    assert.equal(await flame, false);
    await waitUntil(() => ctrl.lastStatus?.state === 'off', 2_000, 'off');
    assert.equal(fake.count('16'), 0, 'no flame command after off');
  });
});

describe('ignite', () => {
  it('lights and reports on', async () => {
    const { ctrl, logs } = await setup();
    const seen: string[] = [];
    ctrl.on('update', (v: FireplaceView) => seen.push(v.power));
    assert.equal(await ctrl.requestOn(), true);
    assert.equal(ctrl.lastStatus?.state, 'on');
    assert.ok(has(logs, 'Ignite requested'));
    assert.ok(has(logs, 'Lit after'));
    assert.ok(!seen.includes('off'), 'no flip-back to off while igniting');
  });

  it('resends once if the igniting bit never appears', async () => {
    const { ctrl, fake, logs } = await setup((f) => {
      f.ignoreIgnite = 1;
    });
    assert.equal(await ctrl.requestOn(), true);
    assert.equal(fake.count('1A'), 2);
    assert.ok(has(logs, 'resending ignite'));
  });

  it('fails if the ignition never starts', async () => {
    const { ctrl, fake, logs } = await setup((f) => {
      f.ignoreIgnite = 99;
    });
    assert.equal(await ctrl.requestOn(), false);
    assert.equal(fake.count('1A'), 2);
    assert.ok(has(logs, 'did not start the ignition sequence'));
    assert.equal(ctrl.view.power, 'off');
  });

  it('does not loop when an ignition runs and fails', async () => {
    const { ctrl, fake, logs } = await setup((f) => {
      f.igniteFails = true;
    });
    assert.equal(await ctrl.requestOn(), false);
    assert.equal(fake.count('1A'), 1);
    assert.ok(has(logs, 'Ignition failed'));
    assert.equal(ctrl.view.power, 'off');
  });

  it('times out if the fire never lights', async () => {
    const { ctrl } = await setup((f) => {
      f.igniteFails = false;
    });
    // freeze the fake mid-ignition
    const fake = rigs[0].fake;
    (fake as unknown as { applyIgnite: () => void }).applyIgnite = () => {
      fake.igniting = true;
    };
    const t0 = Date.now();
    assert.equal(await ctrl.requestOn(), false);
    assert.ok(Date.now() - t0 >= 2_500, 'waited for the ignite timeout');
  });

  it('refuses to re-ignite within the lockout after a shutdown', async () => {
    const { ctrl, logs } = await setup((f) => f.setOn());
    assert.equal(await ctrl.requestOff(), true);
    assert.equal(await ctrl.requestOn(), false);
    assert.ok(has(logs, 'Ignite refused'));
  });

  it('applies the ignite level after lighting', async () => {
    const { ctrl, fake } = await setup(undefined, { igniteLevel: 40 });
    assert.equal(await ctrl.requestOn(), true);
    assert.equal(fake.count('16'), 1);
    assert.equal(byteToPercent(ctrl.lastStatus!.flameHeight), 38 /* skew -3 */);
  });

  it('a flame request while off ignites first, then sets the flame', async () => {
    const { ctrl, fake } = await setup();
    assert.equal(await ctrl.requestFlame(0xa0), true);
    assert.equal(fake.count('1A'), 1);
    assert.ok(Math.abs(ctrl.lastStatus!.flameHeight - 0xa0) <= 8);
  });
});

describe('flame', () => {
  it('turn-down: ignores the transient FF, one command, HomeKit never shows 100 %', async () => {
    const { ctrl, fake, logs } = await setup((f) => f.setOn(0xff));
    const shown: number[] = [];
    ctrl.on('update', (v: FireplaceView) => shown.push(v.flamePercent));
    assert.equal(await ctrl.requestFlame(0x90), true);
    assert.equal(fake.count('16'), 1);
    assert.ok(has(logs, `Flame ${byteToPercent(0x90)} %`));
    assert.ok(!shown.includes(100), 'no flash of 100 %');
  });

  it('guard-bit glitch after a turn-down does not report off', async () => {
    const { ctrl, logs } = await setup((f) => f.setOn(0xff));
    const powers: string[] = [];
    let sawGlitch = false;
    ctrl.on('update', (v: FireplaceView) => {
      powers.push(v.power);
      if (ctrl.lastStatus && !ctrl.lastStatus.guardFlame && ctrl.lastStatus.flameHeight >= 0x80) {
        sawGlitch = true;
      }
    });
    assert.equal(await ctrl.requestFlame(0x90), true);
    await sleep(500);
    assert.ok(sawGlitch, 'the fake produced the glitch');
    assert.ok(!powers.includes('off'));
    assert.ok(!has(logs, 'Changed on handset: off'));
  });

  it('compares with a tolerance', async () => {
    const { ctrl, fake } = await setup((f) => {
      f.setOn(0x80);
      f.heightSkew = -6;
    });
    assert.equal(await ctrl.requestFlame(0xd0), true);
    assert.equal(fake.count('16'), 1);
  });

  it('resends once, then reports failure', async () => {
    const { ctrl, fake, logs } = await setup((f) => {
      f.setOn(0x80);
      f.heightSkew = -20;
    });
    assert.equal(await ctrl.requestFlame(0xd0), false);
    assert.equal(fake.count('16'), 2);
    assert.ok(has(logs, 'not confirmed, resending'));
  });

  it('coalesces slider drags into one command', async () => {
    const { ctrl, fake } = await setup((f) => f.setOn(0x80));
    const results = [0x90, 0xa0, 0xb0, 0xc0, 0xd0].map((b) => ctrl.requestFlame(b));
    assert.equal(ctrl.view.flamePercent, byteToPercent(0xd0), 'shows the target at once');
    assert.deepEqual(await Promise.all(results), [true, true, true, true, true]);
    assert.equal(fake.count('16'), 1);
  });

  it('switches to manual mode first when the handset left it in thermostat mode', async () => {
    const { ctrl, fake, logs } = await setup((f) => {
      f.setOn(0xff);
      f.mode = '1002';
    });
    assert.equal(ctrl.view.mode, 'thermostat');
    assert.equal(await ctrl.requestFlame(0xa0), true);
    const b0 = fake.received.indexOf('B0');
    const flame = fake.received.findIndex((c) => c.startsWith('16'));
    assert.ok(b0 !== -1 && b0 < flame);
    assert.ok(has(logs, 'Switching from thermostat mode to manual'));
  });

  it('from pilot: the flame command relights without an ignite', async () => {
    const { ctrl, fake } = await setup((f) => f.setOn(0xff));
    assert.equal(await ctrl.requestStandby(), true);
    assert.equal(ctrl.lastStatus?.state, 'pilot');
    assert.equal(ctrl.view.power, 'pilot');
    assert.equal(await ctrl.requestOn(), true);
    assert.equal(ctrl.lastStatus?.state, 'on');
    assert.equal(fake.count('1A'), 0);
  });
});

describe('aux', () => {
  it('aux change resets the flame to FF and the plugin restores it', async () => {
    const { ctrl, fake, logs } = await setup((f) => f.setOn(0xff, true));
    assert.equal(await ctrl.requestFlame(0xa0), true);
    assert.equal(await ctrl.requestAux(false), true);
    assert.equal(fake.aux, false);
    assert.ok(Math.abs(ctrl.lastStatus!.flameHeight - 0xa0) <= 8, 'flame restored');
    assert.ok(has(logs, 'Aux off'));
    assert.ok(has(logs, 'Flame restored to'));
  });

  it('does not restore when restoreFlameAfterAux is off', async () => {
    const { ctrl } = await setup((f) => f.setOn(0xff, true), { restoreFlameAfterAux: false });
    assert.equal(await ctrl.requestFlame(0xa0), true);
    assert.equal(await ctrl.requestAux(false), true);
    await sleep(200);
    assert.equal(ctrl.lastStatus!.flameHeight, 0xff);
  });

  it('works while the fire is off', async () => {
    const { ctrl, fake } = await setup();
    assert.equal(await ctrl.requestAux(false), true);
    assert.equal(fake.aux, false);
  });
});

describe('connection', () => {
  it('survives dropped status replies', async () => {
    const { ctrl, fake } = await setup((f) => f.setOn());
    fake.dropStatusReplies = 1;
    assert.equal(await ctrl.requestOff(), true);
    assert.equal(ctrl.view.reachable, true);
  });

  it('reconnects after the module drops the connection', async () => {
    const { ctrl, fake } = await setup((f) => f.setOn());
    fake.dropClients();
    await sleep(100);
    assert.equal(await ctrl.requestOff(), true);
  });

  it('reports unreachable and reachable again', async () => {
    const { ctrl, fake, logs } = await setup();
    const port = fake.port;
    await fake.goOffline();
    await waitUntil(() => !ctrl.view.reachable, 3_000, 'unreachable');
    await fake.start(port);
    await waitUntil(() => ctrl.view.reachable, 3_000, 'reachable');
    assert.ok(has(logs, 'Reachable again'));
  });

  it('shutOffAfterConnectionLoss switches off when contact returns', async () => {
    const { ctrl, fake, logs } = await setup((f) => f.setOn(), { shutOffAfterConnectionLoss: true, connectionLossMinutes: 0.001 });
    const port = fake.port;
    await fake.goOffline();
    await waitUntil(() => !ctrl.view.reachable, 3_000, 'unreachable');
    await fake.start(port);
    await waitUntil(() => fake.count('10') > 0, 3_000, 'off sent');
    assert.ok(has(logs, 'Connection was lost'));
  });
});

describe('handset', () => {
  it('unprompted status pushes update the state', async () => {
    // long poll interval: updates must come from the pushes
    const { ctrl, fake, logs } = await setup((f) => f.setOn(0xc0, true), {}, { pollIntervalMs: 60_000 });
    const shown: number[] = [];
    ctrl.on('update', (v: FireplaceView) => shown.push(v.flamePercent));
    fake.handsetFlame(0x90);
    await waitUntil(() => ctrl.view.flamePercent === byteToPercent(0x8d), 2_000, 'handset flame');
    assert.ok(!shown.includes(100), 'transient FF not shown');
    assert.ok(has(logs, `Changed on handset: flame ${byteToPercent(0x8d)} %`));
    assert.ok(!has(logs, 'Changed on handset: flame 100 %'));

    fake.handsetAux(false);
    await waitUntil(() => !ctrl.view.aux, 2_000, 'aux off');
    assert.ok(has(logs, 'Changed on handset: aux off'));

    fake.handsetOff();
    await waitUntil(() => ctrl.view.power === 'off', 2_000, 'off');
    assert.ok(has(logs, 'Changed on handset: off'));
  });

  it('remembers the handset flame level for the next ignition (igniteLevel last)', async () => {
    const { ctrl, fake } = await setup((f) => f.setOn(0xc0, true));
    fake.handsetFlame(0xa0);
    await waitUntil(() => Math.abs(ctrl.lastStatus!.flameHeight - 0xa0) <= 8 && ctrl.lastStatus!.flameHeight !== 0xff, 2_000);
    await sleep(500);
    fake.handsetOff();
    await waitUntil(() => ctrl.lastStatus?.state === 'off', 2_000);
    await sleep(700); // lockout
    assert.equal(await ctrl.requestOn(), true);
    assert.ok(Math.abs(ctrl.lastStatus!.flameHeight - 0x9d) <= 8, 'relit at the remembered level');
  });
});
