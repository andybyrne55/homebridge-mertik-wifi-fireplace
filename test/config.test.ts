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
  it('rejects an entry only for a bad name or ip, and never throws', () => {
    assert.ok(validateFireplace(null).errors.length);
    assert.ok(validateFireplace('x').errors.length);
    const { config, errors } = validateFireplace({ ip: 'not an ip!' });
    assert.equal(config, undefined);
    assert.ok(errors.some((e) => e.includes('"name"')));
    assert.ok(errors.some((e) => e.includes('"ip"')));
  });
  it('replaces bad optional settings with defaults and warns', () => {
    const { config, errors, warnings } = validateFireplace({
      name: 'Fire', ip: '192.168.1.101', pollInterval: 2, commandRetries: 9, tileType: 'lightbulb', igniteLevel: 0, debug: 'yes',
    });
    assert.deepEqual(errors, []);
    assert.equal(config?.pollInterval, CONFIG_DEFAULTS.pollInterval);
    assert.equal(config?.commandRetries, CONFIG_DEFAULTS.commandRetries);
    assert.equal(config?.tileType, 'heater');
    assert.equal(config?.igniteLevel, 'last');
    assert.equal(config?.debug, false);
    for (const key of ['pollInterval', 'commandRetries', 'tileType', 'igniteLevel', 'debug']) {
      assert.ok(warnings.some((w) => w.includes(`"${key}"`)), key);
    }
  });
});
