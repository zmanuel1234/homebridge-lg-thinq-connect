# Changelog

## 0.1.0-beta.3 - 2026-11-23

### Added
- **Tub clean reminder** (optional, off by default): a "tub clean" sensor on washers that count
  their cycles, detected once LG's count reaches the number you set (for example 30). Turn on
  notifications for it as a reminder. The log notes when it's due.

## 0.1.0-beta.2 - 2026-11-23

### Added
- **Live updates from LG** (on by default): state changes and alerts arrive the moment they
  happen, instead of at the next check. LG's "washing complete" and "drying complete" alerts
  trigger the done sensor right away; "drying failed" and "error during washing" open the problem
  sensor until the next cycle starts or the machine is switched off. Scheduled checks continue as a
  backup (every 10 minutes idle, 2 minutes during a cycle, while live updates work). The plugin
  reconnects on its own after a drop and still has no dependencies to install.

### Changed
- Friendlier words in the log and phase sensor names: Paused, Ready, Detecting load, Finished, and
  Washing or Drying for the main phase.

## 0.1.0-beta.1 - 2026-11-23

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
