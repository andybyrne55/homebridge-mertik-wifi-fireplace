import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { CONFIG_DEFAULTS, validateFireplace } from '../src/config.js';

describe('config validation', () => {
  it('applies defaults', () => {
    const { config, errors } = validateFireplace({ name: 'Fire', ip: '192.168.1.101' });
    assert.deepEqual(errors, []);
    assert.deepEqual(config, { name: 'Fire', ip: '192.168.1.101', ...CONFIG_DEFAULTS });
  });
  it('accepts every option', () => {
    const { config } = validateFireplace({
      name: 'Fire', ip: 'fire.local', port: 2001, tileType: 'fan', zeroPercent: 'pilot', igniteLevel: '60',
      auxSwitch: false, restoreFlameAfterAux: false, alertSensor: 'leak', shutOffAfterConnectionLoss: true,
      connectionLossMinutes: 10, pollInterval: 30, commandRetries: 5, debug: true, leftOnAlertHours: 0, childLockSwitch: false,
    });
    assert.equal(config?.igniteLevel, 60);
    assert.equal(config?.tileType, 'fan');
    assert.equal(config?.alertSensor, 'leak');
    assert.equal(config?.leftOnAlertHours, 0);
    assert.equal(config?.childLockSwitch, false);
  });
  it('rejects bad entries with readable errors and never throws', () => {
    assert.ok(validateFireplace(null).errors.length);
    assert.ok(validateFireplace('x').errors.length);
    const { config, errors } = validateFireplace({ ip: 'not an ip!', pollInterval: 2, commandRetries: 9, tileType: 'lightbulb', igniteLevel: 0 });
    assert.equal(config, undefined);
    assert.ok(errors.some((e) => e.includes('"name"')));
    assert.ok(errors.some((e) => e.includes('"ip"')));
    assert.ok(errors.some((e) => e.includes('"pollInterval"')));
    assert.ok(errors.some((e) => e.includes('"commandRetries"')));
    assert.ok(errors.some((e) => e.includes('"tileType"')));
    assert.ok(errors.some((e) => e.includes('"igniteLevel"')));
  });
});
