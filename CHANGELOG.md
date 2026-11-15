# Changelog

All notable changes to this project are documented here. This project uses [semantic versioning](https://semver.org).

## [1.0.0]

First release.

### Added
- On / off, each verified from the fireplace's own status and retried. Off is sent at once, ahead of anything else,
  and is only confirmed when the fireplace reports the fire off.
- Flame height 0–100 % across the fireplace's full usable range, with slider drags coalesced into one command.
- Boost switch (the second, back row of burners; "aux" on the remote); the flame level is restored after a boost change.
- Thermostat control on the heater tile: setting the target temperature switches to thermostat mode. A target set
  while the fire is off is saved and applied at the next switch-on; it never lights the fire.
- Child lock switch: HomeKit and automations cannot light or change the fire; off always works.
- Shutdown alert sensor (contact or leak) that trips only when the fire could not be confirmed off.
- Left-on alert sensor after the fire has been on for a set time (default 4 h), with optional auto-off.
- True state in HomeKit, including changes made on the handset; no flip-back while a command is running.
- Copes with the fireplace's real behaviour: a pause with no pilot signal during ignition, ignition stopping at pilot,
  transient full-flame readings when turning down, and a 3-minute wait needed between off and re-ignition
  (`reigniteWait`).
- "No Response" in HomeKit when the fireplace is unreachable; reconnects with backoff.
- Settings GUI for every option; invalid settings fall back to their defaults with a warning.
