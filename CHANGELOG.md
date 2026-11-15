# Changelog

All notable changes to this project are documented here. This project uses [semantic versioning](https://semver.org).

## [0.1.0-beta.1]

First public beta. Manual control only.

### Added
- On / off, each verified from the fireplace's own status and retried; off jumps the queue and is always sent.
- Flame height 0–100 % (1–100 % = the fireplace's full usable range), with slider drags coalesced.
- Aux (second burner row) switch; the flame level is restored after an aux change.
- True state in HomeKit, including changes made on the handset; no flip-back while a command is running.
- Shutdown alert sensor (contact or leak) that trips only when the fire could not be confirmed off.
- Thermostat / eco mode set on the handset is recognised and logged (not controlled yet).
- "No Response" in HomeKit when the fireplace is unreachable; reconnects with backoff.
- Waits 3 minutes (configurable) between the fire going off and re-igniting; sooner, the test unit failed to light.
- Ignition copes with the unit's real behaviour: a pause with no pilot signal after igniting, and stopping at pilot
  (the plugin then lights the main burner itself).
- Settings GUI for every option.
