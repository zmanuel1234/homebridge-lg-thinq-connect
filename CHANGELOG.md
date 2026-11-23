# Changelog

## 0.2.0-beta.1 - 2026-11-23

### Added
- **Experimental appliances** (new setting, off by default): air conditioners, refrigerators and wine
  cellars, dishwashers, Stylers, ovens, dehumidifiers, humidifiers, air purifiers, ceiling fans,
  ventilators, range hoods and over-the-range microwaves, water heaters, heat pumps and robot vacuums,
  plus a basic fallback (on/off, temperatures, humidity, problem alerts) for any other type. See the
  README's table for what each shows. Built from LG's documentation, Home Assistant's integration and
  its sample data from real air conditioners, an air purifier, a dehumidifier and a range hood, and
  the MIT-licensed air conditioner and heat pump plugins. Not yet confirmed by users: reports welcome.
- Dishwashers get door and "rinse aid low" sensors.
- LG alerts about a full or empty tank now open the problem sensor too.

### Changed
- Appliance types other than washers and dryers are no longer just named in the log: with the new
  setting on, they're added; without it, the log says how to try them.

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
