# Changelog

## 0.2.0-beta.5 - 2026-11-23

### Added
- **Check token** in the plugin's settings: step-by-step sign-in help, and a button that tries the
  token with LG and lists the appliances it can see and how well each is supported, before you
  save or restart.
- The log now starts with who LG signed in and what it found, for example
  `Signed in to LG (US): found Front Load Washer, Dryer.`
- LG's error codes now come with what to do (new terms to accept, wrong country, a missing
  permission, an offline appliance, Remote Start), and a README section on signing in.

### Fixed (from an independent code review)
- An odd or empty appliance list from LG no longer removes accessories from the Home app: an
  unreadable list is retried, and an empty one must repeat three times before anything is removed.
- An appliance whose setup fails at startup (LG not answering) now shows a fault and is set up
  again automatically, instead of staying frozen until Homebridge restarts.
- No more false "done" when a cycle is stopped in its first minute (before LG knows the time), or
  after the washer's automatic freeze protection runs.
- A malformed message from LG's message server, or an error while applying a live update, can no
  longer crash Homebridge.
- An internet outage no longer throws away a working live-update certificate.
- On a twin washer, a "complete" alert marks only the drum that was in use.
- After LG asks to slow down (too many requests), checks wait 10 minutes.
- Experimental appliances: no HAP warnings when first added; an air conditioner reporting its
  range only in °F gets the right limits; an oven "preheating complete" isn't shown as done; the
  basic appliance's problem sensor closes again.
- Check token: WashTowers and other laundry types are marked as added automatically.
- Live updates stay off, with a warning, if Homebridge gives no storage folder (they never write
  elsewhere).
- Removed a test certificate file that had been committed by mistake.

## 0.2.0-beta.4 - 2026-11-23

### Added
- **Microwaves** (experimental): running and time left to the second, a "done" sensor and LG's
  done alert, as well as the vent fan and light. LG's API doesn't give the cooking mode, power level
  or temperature.
- **Dishwashers**: the course (for example Eco) and a delayed start ("starts in 2 h 30 min") in
  the log. Time left now counts seconds where an appliance reports them.

### Fixed
- README: how to run `lg-thinq-diagnostics` on a Homebridge Raspberry Pi or Docker setup, where
  plugins are installed in Homebridge's own folder rather than globally.

## 0.2.0-beta.3 - 2026-11-23

### Added
- **Air conditioner extras** (experimental appliances), for what a unit offers through LG's official
  API: switches for air purify, energy saving, the display light, left-right swing, jet mode, dry
  mode and fan mode; air quality (PM2.5, PM10), humidity and filter sensors; and separate heating
  and cooling set points in auto mode on units with two set points.
- **Air purifier**: auto or manual mode on the tile, a sleep mode switch, and a humidity sensor.
- New setting **Extra switches for experimental appliances** (on by default) to leave the switches
  out.

## 0.2.0-beta.2 - 2026-11-23

### Added
- **Auto fan speed** (experimental appliances): for air conditioners, air purifiers and fans that
  offer it, Auto sits at the top of the speed slider, after the named speeds. A Low / Medium /
  High / Auto unit is 25 / 50 / 75 / 100 %, as in homebridge-lg-thinqconnect-ac.

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
