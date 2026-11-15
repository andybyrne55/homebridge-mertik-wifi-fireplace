import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import * as cmd from '../src/protocol/commands.js';
import { byteToPercent, flameMatches, percentToByte } from '../src/protocol/flame.js';
import { decodeStatus, FrameSplitter, parseFrame } from '../src/protocol/status.js';
import {
  CAPTURED_OFF, CAPTURED_ON_FULL_AUX, ECO, FALSE_OFF_LIT, IGNITING, ON_AUX_OFF, ON_LOW_AUX, SHUTTING_DOWN,
  SHUTTING_DOWN_HEIGHT_ZERO, STANDBY, THERMOSTAT_HEATING,
} from './frames.js';

const PREFIX_HEX = '02' + '33303330333033303830';

function hexOf(buf: Buffer): string {
  return buf.toString('hex');
}

describe('command encoding (bytes as sent by the probe scripts)', () => {
  it('status request', () => assert.equal(hexOf(cmd.statusRequest()), PREFIX_HEX + '303303'));
  it('ignite', () => assert.equal(hexOf(cmd.ignite()), PREFIX_HEX + '314103'));
  it('off', () => assert.equal(hexOf(cmd.off()), PREFIX_HEX + '313003'));
  it('flame height FF / 80 / B9', () => {
    assert.equal(hexOf(cmd.flameHeight(0xff)), PREFIX_HEX + '3136' + '4646' + '03');
    assert.equal(hexOf(cmd.flameHeight(0x80)), PREFIX_HEX + '3136' + '3830' + '03');
    assert.equal(hexOf(cmd.flameHeight(0xb9)), PREFIX_HEX + '3136' + '4239' + '03');
  });
  it('flame height clamps', () => {
    assert.equal(hexOf(cmd.flameHeight(300)), hexOf(cmd.flameHeight(0xff)));
    assert.equal(hexOf(cmd.flameHeight(-5)), hexOf(cmd.flameHeight(0)));
  });
  it('standby', () => assert.equal(hexOf(cmd.standby()), PREFIX_HEX + '3136303003'));
  it('aux on / off end with ETX + LF', () => {
    assert.equal(hexOf(cmd.auxOn()), PREFIX_HEX + '32303031030a');
    assert.equal(hexOf(cmd.auxOff()), PREFIX_HEX + '32303030030a');
  });
  it('modes', () => {
    assert.equal(hexOf(cmd.manualMode()), PREFIX_HEX + '423003');
    assert.equal(hexOf(cmd.thermostatMode()), PREFIX_HEX + '4232303103');
    assert.equal(hexOf(cmd.ecoMode()), PREFIX_HEX + '4233303103');
  });
  it('target temperature', () => {
    assert.equal(hexOf(cmd.setTargetTemperature(15)), PREFIX_HEX + '42324644' + '30303936' + '03');
    assert.equal(cmd.setTargetTemperature(22).toString('latin1').slice(1, -1), '3030303080B2FD00DC');
  });
});

describe('status decoding', () => {
  it('captured off frame', () => {
    assert.equal(CAPTURED_OFF.length, 106);
    const s = decodeStatus(CAPTURED_OFF)!;
    assert.equal(s.flameHeight, 0);
    assert.equal(s.flags, 0x820a);
    assert.equal(s.state, 'off');
    assert.equal(s.auxOn, true);
    assert.equal(s.guardFlame, false);
    assert.equal(s.mode, 'manual');
    assert.equal(s.roomTemperature, 19);
    assert.equal(s.targetTemperature, 26);
    assert.equal(s.deviceName, 'Dining Room Fire');
  });
  it('captured on, full, aux on', () => {
    const s = decodeStatus(CAPTURED_ON_FULL_AUX)!;
    assert.equal(s.flameHeight, 0xff);
    assert.equal(s.state, 'on');
    assert.equal(s.auxOn, true);
    assert.equal(s.guardFlame, true);
  });
  it('igniting', () => {
    const s = decodeStatus(IGNITING)!;
    assert.equal(s.igniting, true);
    assert.equal(s.state, 'igniting');
  });
  it('on, aux off', () => {
    const s = decodeStatus(ON_AUX_OFF)!;
    assert.equal(s.state, 'on');
    assert.equal(s.auxOn, false);
    assert.equal(s.flameHeight, 0xb8);
  });
  it('on at minimum', () => assert.equal(decodeStatus(ON_LOW_AUX)!.state, 'on'));
  it('shutting down (height still 80, and later 00)', () => {
    assert.equal(decodeStatus(SHUTTING_DOWN)!.state, 'shuttingDown');
    assert.equal(decodeStatus(SHUTTING_DOWN_HEIGHT_ZERO)!.state, 'shuttingDown');
  });
  it('standby = pilot', () => {
    const s = decodeStatus(STANDBY)!;
    assert.equal(s.state, 'pilot');
    assert.equal(s.guardFlame, true);
  });
  it('guard-bit glitch while lit is still "on"', () => {
    const s = decodeStatus(FALSE_OFF_LIT)!;
    assert.equal(s.guardFlame, false);
    assert.equal(s.state, 'on');
  });
  it('heights 51–7F count as lit, 3D as out', () => {
    assert.equal(decodeStatus(FALSE_OFF_LIT.substring(0, 14) + '51' + FALSE_OFF_LIT.substring(16))!.state, 'on');
    assert.equal(decodeStatus(STANDBY.substring(0, 14) + '3D' + STANDBY.substring(16))!.state, 'pilot');
  });
  it('thermostat and eco modes', () => {
    assert.equal(decodeStatus(THERMOSTAT_HEATING)!.mode, 'thermostat');
    assert.equal(decodeStatus(ECO)!.mode, 'eco');
    assert.equal(decodeStatus(ECO)!.flameHeight, 0xbb);
  });
  it('rejects non-status payloads', () => {
    assert.equal(decodeStatus('030300000016'), undefined);
    assert.equal(decodeStatus('hello'), undefined);
    assert.equal(decodeStatus(CAPTURED_OFF.replace('0303', 'ZZZZ')), undefined);
  });
  it('classifies acks', () => {
    assert.deepEqual(parseFrame('030300000016'), { type: 'ack', payload: '030300000016', echo: '16' });
    assert.equal(parseFrame('03030000001A').type, 'ack');
    assert.equal(parseFrame(CAPTURED_OFF).type, 'status');
    assert.equal(parseFrame('garbage').type, 'unknown');
  });
});

describe('frame splitter', () => {
  const wrap = (p: string) => Buffer.concat([Buffer.from([2]), Buffer.from(p, 'latin1'), Buffer.from([3])]);

  it('joins a frame split across reads', () => {
    const f = new FrameSplitter();
    const whole = wrap(CAPTURED_OFF);
    assert.deepEqual(f.push(whole.subarray(0, 10)), []);
    assert.deepEqual(f.push(whole.subarray(10, 50)), []);
    assert.deepEqual(f.push(whole.subarray(50)), [CAPTURED_OFF]);
  });
  it('splits merged frames, including a trailing partial one', () => {
    const f = new FrameSplitter();
    const data = Buffer.concat([wrap('030300000016'), wrap(CAPTURED_ON_FULL_AUX), wrap(CAPTURED_OFF)]);
    const cut = data.length - 5;
    assert.deepEqual(f.push(data.subarray(0, cut)), ['030300000016', CAPTURED_ON_FULL_AUX]);
    assert.deepEqual(f.push(data.subarray(cut)), [CAPTURED_OFF]);
  });
  it('ignores LF and junk before STX', () => {
    const f = new FrameSplitter();
    const data = Buffer.concat([Buffer.from('\n'), Buffer.from('xx'), wrap(CAPTURED_OFF), Buffer.from([0x0a])]);
    assert.deepEqual(f.push(data), [CAPTURED_OFF]);
  });
  it('drops runaway garbage without ETX', () => {
    const f = new FrameSplitter(64);
    f.push(Buffer.alloc(100, 0x41));
    assert.deepEqual(f.push(wrap(CAPTURED_OFF)), [CAPTURED_OFF]);
  });
});

describe('flame mapping', () => {
  it('maps 1–100 % to 80–FF', () => {
    assert.equal(percentToByte(100), 0xff);
    assert.equal(percentToByte(1), 0x81);
    assert.equal(percentToByte(50), 0x80 + 64);
    assert.equal(percentToByte(0), 0x81);
  });
  it('inverse rounds and clamps', () => {
    assert.equal(byteToPercent(0xff), 100);
    assert.equal(byteToPercent(0x80), 1);
    assert.equal(byteToPercent(0x64), 1);
    assert.equal(byteToPercent(0x3d), 0);
    assert.equal(byteToPercent(0x00), 0);
    for (let p = 1; p <= 100; p++) {
      assert.equal(byteToPercent(percentToByte(p)), p);
    }
  });
  it('tolerance ±8 (measured offsets)', () => {
    assert.ok(flameMatches(0x91, 0x97));
    assert.ok(flameMatches(0xab, 0xae));
    assert.ok(flameMatches(0xcc, 0xd0));
    assert.ok(!flameMatches(0xff, 0x97));
  });
});
