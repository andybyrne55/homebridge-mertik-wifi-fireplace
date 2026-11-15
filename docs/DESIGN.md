# homebridge-mertik-wifi-fireplace – design and build spec (v1)

Self-contained hand-off document: everything needed to build v1 is here. All protocol facts below were
measured on a real Mertik Maxitrol WiFi module (GV60 family, two-burner gas fire) on 14–15 Nov 2026 and,
where it says "camera-verified", confirmed by watching the flame.

## 1. Goal and scope

A Homebridge dynamic-platform plugin for Mertik Maxitrol WiFi gas fireplaces that is reliable first and
feature-rich second.

v1 (manual control only):
- on / off, verified and retried
- flame height 0–100 %
- aux (second burner row) on / off
- true state in HomeKit, including changes made with the handset
- alert when the fire cannot be confirmed off
- recognises thermostat / eco mode (set from the handset) and reports it, but does not control it

v2 backlog (do not build in v1): thermostat and eco control, a "left on too long" alert, child lock, then a Homebridge "verified" application. See §11.

## 2. Standards (checked against homebridge-plugin-template @ 2026-11-01 and the verified criteria)

- ESM (`"type": "module"`), TypeScript 6, `module`/`moduleResolution: nodenext`, target ES2022, `strict`.
- ESLint 10 flat config, `eslint . --max-warnings=0`.
- `engines`: node `^22.12.0 || ^24.0.0 || ^26.0.0`, homebridge `^1.8.0 || ^2.0.0`.
- `keywords`: `homebridge-plugin`, `supports-hap`. `main`: `dist/index.js`. Licence Apache-2.0 + NOTICE.
- Dynamic platform. Must not start unless configured. No post-install scripts. No analytics.
  Files only in the Homebridge storage dir (v1 writes none). Never throw unhandled exceptions.
- Settings GUI via `config.schema.json` (every option below, with titles, descriptions, defaults).
- CI on Node 22, 24, 26: install, lint, build, test.
- A GitHub release with notes for every version. npm publish from GitHub Actions (see §9).
- No runtime dependencies if avoidable (`node:net` only). Do not pull in `homebridge-lib`.

## 3. Wire protocol

TCP, port 2000, plain text. One connection per client. Several clients can be connected at once.

Frame: `STX (0x02)` + ASCII payload + `ETX (0x03)`.

### Commands (client → fireplace)
Payload = `"3030303080"` + command. (Aux commands are followed by an extra `LF 0x0A` after ETX.)

| Command | ASCII after prefix | Notes |
|---|---|---|
| Status request | `03` | read-only |
| Ignite | `1A` | acked `…1A` |
| Off (pilot + burner off) | `10` | |
| Flame height | `16` + 2 hex chars | `80`–`FF` usable; acked `…16` |
| Standby (pilot only) | `1600` | flame height 00 |
| Aux on / off | `2001` / `2000` | then LF; ack `…2000`-style frame only sometimes |
| Manual mode | `B0` | no ack |
| Thermostat mode | `B201` | no ack (v2) |
| Eco mode | `B301` | no ack (v2) |
| Set target temp | `B2FD` + 4 hex chars of °C×10 | e.g. 22.0 °C = `00DC`; no ack (v2) |

Acks are short frames `0303000000` + echo (e.g. `030300000016`). They are NOT reliable (mode, target and
sometimes aux commands return nothing). Never treat an ack as success; verify from status.

### Status frame (fireplace → client): 106 ASCII chars
Example (fire off): `0303000000034400820A0000000000BE010444696E696E6720526F6F6D2046697265FFFFFFFF000000000000000000000000FF4400`

| Chars (0-based, end exclusive) | Meaning |
|---|---|
| 0–14 | header `03030000000344` |
| 14–16 | flame height, hex byte. `00` = main burner out; `80` = lowest lit; `FF` = full |
| 16–20 | flags, 16-bit hex (bit index 0 = MSB): bit 7 shutting down, bit 8 guard/pilot flame, bit 11 igniting, bit 12 aux on |
| 24–28 | mode: `0000` manual (or thermostat idle – ambiguous), `1002` thermostat heating, `2000` eco |
| 28–32 | room temperature, hex, °C × 10 |
| 32–36 | target temperature, hex, °C × 10 |
| 36–68 | device name, ASCII as hex (16 characters on the test unit; length on other units unverified), followed by `FFFFFFFF` |
| last 4 | varies frame to frame (`4400`, `4600`, …) – ignore |

Observed flag values: `820A` off (aux on), `821A` igniting, `828A` on + aux on, `8282` on + aux off,
`838A` shutting down. Example frames for tests:
- on, full, aux on: `03030000000344FF828A0000000000BE010444696E696E6720526F6F6D2046697265FFFFFFFF000000000000000000000000FF4400`
- standby: height `00`, flags `8282`/`828A` (guard on, no shutdown)

### Measured behaviour (all must be handled)
1. Replies to a status request go to the requesting connection. The module also pushes status frames
   unprompted when the handset changes something (seen once, treat as likely): accept status frames at any time.
2. TCP reads do not align with frames: buffer and split on ETX; a frame can be split or several can arrive together.
3. Status requests occasionally time out. Retry; do not mark unreachable on one miss.
4. Reported flame height differs slightly from what was sent (97→91, AE→AB, D0→CC, B9→B8). Compare with a
   tolerance of ±8.
5. Turning the flame DOWN: status reads `FF` for ~2–5 s, then the new value. Turning UP is direct. Do not send
   "full first" yourself. While confirming a turn-down, ignore transient `FF` for up to 8 s.
6. False "off": after a turn-down the guard bit (bit 8) can read 0 for ~20–30 s while the fire is clearly lit
   (height ≥ 80). Seen minutes after ignition and again 14 min later. Never derive "off" from the guard bit alone.
7. Below `80`: values `51`–`7F` are reachable only going down and look the same as `80` (camera-verified).
   At `3D` the main burner is out (pilot still on). Going up from there, the unit snaps to `80`.
   So map 1–100 % to `80`–`FF`.
8. Aux off → back row goes out, front row stays; flame commands still work. Changing aux (either way, from
   WiFi or the handset) resets flame height to `FF`. The unit beeps on aux and ignite, not on flame changes.
9. Standby (`1600`): height `00`, guard bit on, no flame visible. A flame command relights the burner in ~6 s
   without an ignite.
10. Ignite: igniting bit at once; guard on after ~25–35 s; height `FF` ~4–7 s later. Total ≈ 40 s.
11. Off: shutdown bit within ~1–2 s, height `00` within ~10 s, then guard off.
12. Handset changes appear in status (flame down → `77`, `64`; aux on → aux bit + `FF`).
13. (15 Nov, first plugin test) Status is pushed to every connected client when anything changes: a second
    client polling every 15 s logged each change made by another client within 1–2 s.
14. (15 Nov) Ignition is not always the clean sequence in 10. Re-igniting ~45 s after an off: igniting for ~27 s,
    then igniting cleared with NO guard bit for ~19 s, then guard on but the main burner stayed out (pilot only)
    until a flame command (relit in ~9 s). A second re-ignite ~60 s after an off: igniting for ~40 s (top flag bit
    cleared after 30 s, flags `021A`), then off with no pilot – a real failed ignition. Handle: never treat
    "igniting ended" as failure; wait for pilot/on until the timeout; from pilot, send a flame command.
15. (15 Nov) The reported flame height settles a few counts below what was sent (D9 → D5 → D2 if you keep
    re-sending the reported value). Remember the level that was asked for, not the reported one.

### State derivation (from one status frame + short history)
- `shuttingDown` if bit 7.
- `igniting` if bit 11.
- `on` if height ≥ `50` (regardless of guard bit – see 6).
- `pilot` (standby) if height < `50` and guard bit on and not igniting/shutting down.
- `off` if height < `50` and guard bit off and not igniting.
- `mode`: manual / thermostat / eco from chars 24–28 (first char `1` / `2`).

## 4. Architecture

```
src/
  index.ts            registers the platform
  settings.ts         PLATFORM_NAME = 'MertikWifiFireplace', PLUGIN_NAME = 'homebridge-mertik-wifi-fireplace'
  platform.ts         config validation, accessory discovery/restore/removal
  accessory.ts        HomeKit services <-> FireplaceController
  protocol/
    commands.ts       pure encoders (Buffer) for every command
    status.ts         pure decoder: frame string -> FireplaceStatus; frame splitter
  connection.ts       socket lifecycle, framing, status polling, reconnect/backoff
  controller.ts       state machine, verified commands, retries, command queue, events
  logger.ts           thin wrapper: info = user-level events, debug gated by config
test/
  protocol.test.ts    real captured frames
  controller.test.ts  against a fake fireplace
  fake-fireplace.ts   in-process TCP server reproducing behaviours 1–12 above
```

### connection.ts
- One socket per fireplace. Connect on start; on error/close/timeout reconnect with backoff 1 s → 30 s.
- Idle poll: status request every `pollInterval` s (default 15). While a command is being verified: every 2 s.
- If nothing received for 10 s after a request, count a miss; after 2 misses destroy and reconnect.
- `reachable` = a status frame received in the last 60 s. Emits `status`, `reachable`.
- Before sending any command: if the socket is not healthy (no frame in the last 30 s), reconnect first.

### controller.ts
- Serial command queue. `off` clears the queue and runs next. Newer flame targets replace queued older ones.
- No fixed debounce delay before sending. Coalesce slider drags with a 400 ms trailing debounce (flame only).
- Every command = send → verify from status → retry → result:
  - off: success when shuttingDown seen or state `off`; check every 2 s; resend after 6 s; up to
    `commandRetries` (default 3) resends; then `shutdownFailed` event.
  - ignite: only from `off`. Success when state `on`. Timeout 90 s. If the igniting bit never appears within
    8 s, resend once. If ignition ran and failed, do NOT loop: report failure, state stays as reported.
  - flame: if mode ≠ manual, send manual mode first. If state `pilot`, just send the flame command.
    Success when |reported − sent| ≤ 8; timeout 12 s; one resend.
  - aux: success when bit 12 matches; timeout 10 s; one resend; then re-apply the remembered flame level.
  - standby: success when state `pilot`; timeout 12 s; one resend.
- Remembers the last flame level set (by HomeKit or seen from the handset while on).
- Never throws; all failures are logged and surfaced as events.

## 5. HomeKit mapping

One accessory per configured fireplace.

- Main service, selected by `tileType`:
  - `heater` (default): `HeaterCooler` – `Active`, `CurrentHeaterCoolerState` (INACTIVE / IDLE for pilot /
    HEATING), `TargetHeaterCoolerState` restricted to HEAT, `CurrentTemperature` (from status),
    `RotationSpeed` 0–100 = flame.
  - `fan`: `Fanv2` – `Active`, `RotationSpeed`.
  - Never a Lightbulb ("turn on all the lights" must not ignite a gas fire).
- `Active` ON while off → ignite, then apply `igniteLevel`. `Active` OFF → off (always sent, even if believed off).
- `RotationSpeed` 1–100 → `80`–`FF` (`byte = 0x80 + round(pct × 127 / 100)`, inverse rounds and clamps).
  Setting > 0 while off → ignite first. 0 → per `zeroPercent`: `off` (default) or `pilot` (standby).
- While a command is pending, HomeKit shows the target, not a stale reading (no flip-back).
- `Switch` "Aux" (if `auxSwitch`): second burner row.
- Alert sensor (if `alertSensor` ≠ `none`): `ContactSensor` (default) or `LeakSensor`. Trips ONLY on
  `shutdownFailed`. Clears when the fire is confirmed off. Never trips for mere unreachability.
- `StatusFault` on the main service when unreachable.

## 6. Configuration (`config.schema.json`, all with defaults)

Platform: `MertikWifiFireplace`. `fireplaces[]`:

| Key | Default | Meaning |
|---|---|---|
| `name` | – (required) | accessory name |
| `ip` | – (required) | fixed IP of the WiFi module |
| `port` | 2000 | |
| `tileType` | `heater` | `heater` / `fan` |
| `zeroPercent` | `off` | what 0 % does: `off` / `pilot` |
| `igniteLevel` | `last` | flame after ignition: `last` / `full` / 1–100 |
| `auxSwitch` | true | expose the aux switch |
| `restoreFlameAfterAux` | true | re-apply flame level after an aux change |
| `alertSensor` | `contact` | `none` / `contact` / `leak` |
| `shutOffAfterConnectionLoss` | false | switch the fire off when contact returns after `connectionLossMinutes` |
| `connectionLossMinutes` | 5 | |
| `pollInterval` | 15 | seconds, 5–60 |
| `commandRetries` | 3 | 0–5 |
| `debug` | false | log packets and every status frame |

Invalid entries are logged and skipped; the plugin never crashes on bad config.

## 7. Logging

Info (default): one line per user-level event and its outcome – "Ignite requested", "Lit after 38 s",
"Off confirmed after 9 s", "Off not confirmed, retrying (2/3)", "Flame 45 %", "Aux on", "Changed on handset:
flame 60 %", "Unreachable", "Reachable again". Warnings/errors for failures. No periodic status lines.
Debug (config `debug`): raw frames, queue activity, state transitions.

## 8. Tests

- `protocol.test.ts`: decode the captured frames above (off, igniting, on, aux off, standby, shutting down,
  thermostat, eco); encode every command and compare to the hex in §3; frame splitter with split/merged reads.
- `controller.test.ts` with `fake-fireplace.ts`: off retry + failure alert; ignite success/timeouts; turn-down
  with transient FF; guard-bit glitch does not report off; tolerance; aux resets flame and is restored; dropped
  status replies; reconnect; handset push updates state; queue priority of off.
- Run with `node --test` (or vitest). CI must run them.

## 9. Release

- `build.yml`: push/PR, Node 22/24/26, lint + build + test.
- `release.yml`: on a `v*` tag – build, test, `npm publish --provenance`, create the GitHub release.
  Use npm trusted publishing (OIDC) so no token is stored. CHECK the current npm docs when setting this up:
  the first publish of a new package may have to be done once by the owner before a trusted publisher can
  be attached.
- First release: `0.1.0-beta.1` under the `beta` dist-tag. Repo goes public at that point (owner's approval).
- README: features, install, config table, HomeKit behaviour, troubleshooting, protocol notes, and a one-line
  credit to the projects whose protocol work this builds on. No comparisons, and no mention of other plugins
  anywhere else in the code or docs (owner, 15 Nov). Not affiliated with Maxitrol.

## 10. Milestones

1. Scaffold from the template + protocol layer + tests.
2. Connection + controller + fake fireplace + tests.
3. HomeKit accessory + config schema.
4. Real-hardware test on the owner's Homebridge (needs owner's OK: install on the Pi).
5. README, CI, release workflow.
6. Publish `0.1.0-beta.1` (needs owner: npm account, OK to make the repo public, OK to publish).

## 11. Open questions / v2

- Thermostat idle vs manual standby are indistinguishable in status (mode `0000`, height `00`). Resolve before
  thermostat control.
- ~~Does the unit enforce a wait between off and re-ignite?~~ Effectively yes (15 Nov): re-ignite ~45 s after an
  off stopped at pilot, ~60 s failed, 3 min and from cold lit cleanly (30–35 s). Default lockout is now 180 s,
  configurable as `reigniteWait` (30–900 s). The exact threshold between 60 s and 3 min is unknown.
- ~~Confirm unprompted status pushes with more than one observation.~~ Confirmed 15 Nov (behaviour 13).

- v2: thermostat + eco control, child lock, timers if the protocol has them, Matter, verified application.
- v2: "left on too long" alert (owner's request, 15 Nov). A configurable time (e.g. `onAlertHours`, off by default)
  after which the plugin raises an alert if the main burner has been lit continuously, in case something
  malfunctions or it was forgotten. To decide: its own sensor or shared with the shutdown alert (keep the two
  distinguishable in the log either way); whether pilot-only time counts; whether handset or thermostat
  re-lights restart the clock; whether it may also switch the fire off (opt-in only, never by default);
  how it clears (fire off, or the user acknowledging it).
