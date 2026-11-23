# Changelog

## 0.1.0 - unreleased

First version.

### Added
- LG washers and dryers in Apple Home through LG's official ThinQ Connect API, signed in with a
  personal access token: time left on the machine's tile, a "done" sensor for a notification
  when a cycle finishes, a "problem" sensor for errors, and optional phase sensors (for example
  spinning) for automations.
- Optional starting, pausing and resuming from the Home app, accepted by LG after Remote Start
  is pressed on the machine.
- Two-drum machines (wash combos) and WashTower units, experimental until confirmed.
- `lg-thinq-diagnostics`: saves what LG reports about each appliance, with IDs removed, to attach
  to an issue for adding new appliances.
