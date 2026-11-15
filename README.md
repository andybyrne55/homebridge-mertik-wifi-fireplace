# homebridge-mertik-wifi-fireplace

[![Build, lint and test](https://github.com/andybyrne55/homebridge-mertik-wifi-fireplace/actions/workflows/build.yml/badge.svg)](https://github.com/andybyrne55/homebridge-mertik-wifi-fireplace/actions/workflows/build.yml)
[![npm](https://img.shields.io/npm/v/homebridge-mertik-wifi-fireplace/beta)](https://www.npmjs.com/package/homebridge-mertik-wifi-fireplace)

HomeKit control for gas fireplaces with a **Mertik Maxitrol WiFi module** (GV60 family), through [Homebridge](https://homebridge.io).

The goal is reliability first: every command is checked against what the fireplace itself reports, and
retried if it did not take effect. If the fire cannot be confirmed off, you get an alert in the Home app.

> **Safety.** This plugin is a convenience, not a safety device. Keep the handset within reach, follow the
> manufacturer's instructions, and never rely on HomeKit automations to switch a gas fire off when nobody
> is at home.

## Features

- **On / off, verified.** Off is sent immediately (no debounce), jumps ahead of anything queued, is sent even if
  the plugin believes the fire is already off, and is retried until the fireplace confirms it.
- **Flame height 0–100 %.** 1–100 % covers the fireplace's whole usable range. Dragging the slider sends one command.
- **Aux burner switch** (second burner row). The fireplace jumps to full flame when aux changes; the plugin puts
  your flame level back.
- **The real state in HomeKit**, including changes made with the handset. While a command is running, HomeKit
  shows what you asked for and does not flip back.
- **Shutdown alert sensor** (contact or leak sensor) that trips **only** when the fire could not be confirmed off
  after all retries. It does not trip because the fireplace is merely unreachable while off, and it clears by
  itself once the fire is confirmed off.
- **Left-on alert:** a second sensor that trips when the fire has been on continuously for 4 hours (configurable),
  in case it was forgotten or something is wrong. Optionally switches the fire off too.
- **Child lock:** a switch that stops HomeKit and automations from lighting the fire or changing it. Switching off
  always works, and the handset is not affected.
- **Thermostat:** set a target temperature on the Fire tile and the fireplace holds the room at it, lighting and idling
  the burner by itself. Move the flame slider to go back to manual.
- **Eco mode** switch: the fireplace sets the flame itself to save gas.
- **Clear logs:** one line per event and its outcome ("Ignite requested", "Lit after 38 s", "Off confirmed after
  9 s", "Changed on handset: flame 60 %"). Packet-level logging is available with the `debug` option.
- No runtime dependencies, no analytics, writes no files.

## Requirements

- A Mertik Maxitrol WiFi module already set up on your network (with the Mertik / fireplace app).
- A **fixed IP address** for the module: set a DHCP reservation on your router.
- Homebridge 1.8 or 2.x, Node.js 22, 24 or 26.

## Installation

Search for **Mertik WiFi Fireplace** in the Homebridge UI plugins tab, or:

```sh
npm install -g homebridge-mertik-wifi-fireplace@beta
```

If another plugin controlled your fireplace before, remove it first (see [Troubleshooting](#troubleshooting)).

## Configuration

Use the plugin's settings in the Homebridge UI, or add this to `config.json`:

```json
{
  "platform": "MertikWifiFireplace",
  "name": "Mertik WiFi Fireplace",
  "fireplaces": [
    { "name": "Living Room Fire", "ip": "192.168.1.101" }
  ]
}
```

| Option | Default | What it does |
|---|---|---|
| `name` | – (required) | Accessory name in HomeKit. |
| `ip` | – (required) | Fixed IP address (or host name) of the WiFi module. |
| `port` | `2000` | TCP port of the module. |
| `tileType` | `heater` | `heater`: on/off, flame as "fan speed", room temperature. `fan`: on/off and flame only. Never a light bulb, so "turn off all the lights" cannot touch the fire. |
| `zeroPercent` | `off` | What setting the flame to 0 % does: `off` (switch off) or `pilot` (standby: main burner out, pilot stays lit). |
| `igniteLevel` | `last` | Flame after switching on: `last` (the last level used, from HomeKit or the handset), `full`, or a percentage `1`–`100`. |
| `thermostatControl` | `true` | Heater tile: setting the target temperature switches to thermostat mode. |
| `ecoSwitch` | `true` | Show the eco switch. |
| `auxSwitch` | `true` | Show a switch for the second burner row. |
| `restoreFlameAfterAux` | `true` | Put the flame back after an aux change (the fireplace resets it to full). |
| `alertSensor` | `contact` | Shutdown alert: `none`, `contact` (opens on alert) or `leak` (leak detected on alert). |
| `leftOnAlertHours` | `4` | Raise the left-on alert after the fire has been on (lit or idling at pilot) continuously this long (hours, 0 = off). Same sensor type as `alertSensor`. |
| `leftOnSwitchOff` | `false` | Also switch the fire off when the left-on alert is raised. |
| `childLockSwitch` | `true` | Show the child lock switch. |
| `shutOffAfterConnectionLoss` | `false` | When contact returns after a loss of at least `connectionLossMinutes`, switch the fire off. |
| `connectionLossMinutes` | `5` | See above. |
| `pollInterval` | `15` | Seconds between status checks when idle (5–60). While a command is checked, the plugin polls every 2 s. |
| `commandRetries` | `3` | How many times an unconfirmed off is resent before the alert trips (0–5). |
| `reigniteWait` | `180` | Seconds after the fire goes off before it may be lit again (30–900). Re-igniting sooner failed or stopped at pilot on the test unit. |
| `debug` | `false` | Log every packet and status frame. |

Invalid entries are reported in the log and skipped; the plugin does not crash on bad config.

## How it behaves in HomeKit

| You do | The plugin |
|---|---|
| Switch on while off | Ignites (≈ 40 s), then sets `igniteLevel`. The tile shows on immediately; "Heating" once the burner is lit. |
| Switch on from pilot | Relights the main burner with a flame command (no ignition needed, ≈ 6 s). |
| Switch off | Sends off at once, retries until confirmed, raises the alert if it cannot be confirmed. |
| Set flame 1–100 % while off | Ignites first, then sets the flame. |
| Set flame 0 % | Off, or pilot only (`zeroPercent`). |
| Toggle Aux | Switches the back burner row, then restores your flame level. |
| Set the target temperature (heater tile) | Thermostat mode: lights the fire first if needed, then the fireplace heats until the room reaches the target and idles at pilot (tile shows on, not heating). |
| Turn Eco on / off | Eco mode / back to manual, keeping the fire lit. |
| Turn on the child lock | HomeKit and automations can no longer light the fire or change it; off still works. |
| Use the handset | HomeKit follows within a few seconds and the log says "Changed on handset: …". |
| Switch on within 3 minutes of switching off | Refused, with a log line saying when to try again. The fireplace does not light reliably sooner (`reigniteWait`). |

When the fireplace cannot be reached the tile shows **No Response**. The plugin keeps reconnecting in the
background.

## Troubleshooting

- **"Unreachable" or No Response.** Check that the module still has the IP address in your config (DHCP
  reservation), that it is powered, and that you can reach it from the Homebridge machine
  (`nc -vz <ip> 2000`). A brief outage is normal; the plugin reconnects by itself.
- **"Ignite refused …".** The plugin waits `reigniteWait` (3 minutes by default) between the fire going off and igniting again.
  The plugin only knows about an off it has seen; after a Homebridge restart, a quick re-ignite may fail and is reported.
- **"Ignition failed … reports the fire is off".** The fireplace ran its ignition sequence but the pilot did not
  stay lit. The plugin does not retry automatically. Check the gas supply and try the handset.
- **"Off NOT confirmed".** The fireplace did not confirm the off after all retries. Check the fire and use the
  handset. The alert sensor clears itself as soon as the fire is confirmed off.
- **Two Fire tiles, or a tile stuck showing the fire on.** If another plugin controlled the fireplace before, uninstall it,
  or disable it and remove its accessory (Homebridge UI → Settings → Remove single cached accessory). Homebridge can keep
  showing a disabled plugin's accessory with its last state frozen. Rebuild scenes and automations with the new tile.
- **Something else.** Turn on `debug` for the fireplace, reproduce the problem and open an issue with the log.

## Protocol notes

The module listens on TCP port 2000 and speaks a plain-text protocol: `STX` + ASCII + `ETX`. Commands are the
prefix `3030303080` plus a short code (`03` status, `1A` ignite, `10` off, `16xx` flame height, `2001`/`2000` aux).
The status reply is a 106-character hex string with the flame height, a flags word (shutting down, pilot,
igniting, aux), the mode, room and target temperature, and the device name.

Things this plugin relies on, all measured on a real fireplace:

- Acknowledgements are unreliable, so success is always read from status.
- The reported flame height differs slightly from what was sent; compare with a tolerance.
- Turning the flame down reads full (`FF`) for a few seconds before the new value.
- After a turn-down the pilot ("guard flame") bit can read 0 for 20–30 s while the fire is clearly lit, so
  "off" is never derived from that bit alone.
- Values below `80` are reachable only going down and look the same as `80`; 1–100 % therefore maps to `80`–`FF`.
- Changing aux, from WiFi or the handset, resets the flame to full.

The full specification, with captured frames, is in [docs/DESIGN.md](docs/DESIGN.md).

## Development

```sh
npm install
npm run lint
npm run build
npm test        # protocol tests on captured frames + controller tests against a simulated fireplace
```

`test/fake-fireplace.ts` is an in-process TCP server that reproduces the measured behaviour of the module
(split TCP reads, dropped replies, transient readings, guard-bit glitch, handset pushes, failed ignitions).

## Credits

Thanks to [tritter/homebridge-mertik-fireplace](https://github.com/tritter/homebridge-mertik-fireplace) and
[erdebee/homey-mertik-wifi](https://github.com/erdebee/homey-mertik-wifi), whose protocol work this plugin builds on.

## Disclaimer

Not affiliated with, endorsed by or supported by Maxitrol. "Mertik" and "Maxitrol" are trademarks of their
respective owners. Use at your own risk.

## Licence

[Apache-2.0](LICENSE)
