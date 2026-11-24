# Changelog

## Unreleased

### Changed
- The program-switch warning after a washer start from the Home app only looks at the first 15
  seconds (was 3 minutes). LG reports a program switch within about a second; the washer's own
  adjustment for the load comes later (seen: 65 → 53 min after 43 seconds) and could have set off a
  false warning.

## 1.0.6 - 2026-11-24

### Fixed
- **A refused tap no longer leaves the tile at "No Response".** After the plugin or LG refused a
  command (for example a start without Remote Start), HomeKit kept the error and the tile showed
  "No Response" (Eve: "The read/write operation failed") until Homebridge restarted. The tile now
  shows the error briefly and then works again, for every appliance type.
- **LG's "device timeout" (error 2211) isn't treated as a refusal any more.** LG sometimes answers
  with it although the appliance did what was asked (seen: the washer started). The plugin now
  logs that LG didn't confirm it and checks the appliance's state right away (a command that got
  no answer at all in time is handled the same way, logged as a warning).

- **A start or pause from the Home app shows on the tile at once**, until LG reports it (up to 30
  s), and more taps meanwhile don't send it again. A dryer took 7 seconds to report running, the
  tile stayed off, and four more starts were sent.

### Changed
- **A washer start from the Home app that switches program is logged.** LG's API can only send
  "start", and some washers then run their default program instead of the one on the dial (seen:
  Speed Wash became Normal). When the cycle time jumps by 10 minutes or more right after a start,
  the log says so. The README
  and the "Allow starting and pausing" description explain it.

## 1.0.5 - 2026-11-24

### Added
- **Options per appliance → "Washer, dryer: leave out the Remote Start sensor"**: no Remote Start
  sensor for that machine, while the others keep theirs (for example, keep the washer's and leave
  out the dryer's).

## 1.0.4 - 2026-11-24

### Changed
- **Tile and sensor names in title case**: "Washer Done", "Washer Remote Start", "AC Energy
  Saving". The appliance's own name stays as in the ThinQ app. Names you changed in the Home app
  are kept; the earlier lower-case defaults update on their own.
- The energy section in Eve is named "<name> Energy" (it showed Eve's internal type name).

### Fixed
- The Homebridge settings screen no longer warns "config validation failed" because of an empty
  **Options per appliance** entry: entries without an appliance name are now allowed (the plugin
  ignores them, as before).

## 1.0.3 - 2026-11-24

### Changed
- **Energy use without an extra Home app tile.** Back to 1.0.1's energy section (Eve's own
  Consumption service), which Eve may list in a different room from the appliance; 1.0.2's
  "<name> energy" outlet tile is removed on its own.

## 1.0.2 - 2026-11-24

### Fixed
- **Energy use in the Eve app, for real this time.** Eve didn't show 1.0.1's energy section either:
  it only shows energy on outlets. Appliances LG keeps energy figures for now get a read-only
  **"<name> energy"** outlet in the Home app (on and *in use* while the appliance runs; tapping it
  changes nothing), with this month's use as **Total Consumption** in Eve. Where 1.0.0 and 1.0.1
  put the figure is cleared on its own. Turn it off with **Energy use in the Eve app**.

## 1.0.1 - 2026-11-24

### Fixed
- **Energy use now shows in the Eve app.** 1.0.0 put it on the appliance's main tile, which Eve
  doesn't show for washers and dryers (they appear as a valve). It's now on Eve's own Consumption
  service, which Eve shows for any accessory and the Home app ignores. Nothing changes in the Home
  app; the figure moves on its own after updating.

## 1.0.0 - 2026-11-23

The first stable release: everything from the betas below, with no changes since 1.0.0-beta.1.

- **LG's official ThinQ Connect API**, signed in with a personal access token from LG (not your
  LG password), with live updates from LG and scheduled checks as a fallback.
- **Washers and dryers** (tested on real machines): time left on the tile, a "done" sensor for
  notifications, a problem sensor, optional phase sensors, a tub-clean reminder, a remote start
  sensor, and optional start, pause and resume from the Home app.
- **Air conditioners, dehumidifiers and range hoods**, checked against Home Assistant's data from
  real appliances, added automatically. Fridges, dishwashers, ovens, air purifiers and more with
  **Experimental appliances** on.
- **Energy use** in the Eve app, for appliances LG reports it for.
- A settings screen with a token check and **Copy diagnostics** for bug reports.
- **A compatibility promise**: 1.x updates never rename or remove a tile, sensor, switch or
  setting, so your scenes and automations keep working.
- Homebridge 1.6+ and 2.0, Node.js 22, 24 and 26.

## 1.0.0-beta.1 - 2026-11-23

### Changed
- **Air conditioners, dehumidifiers and range hoods are added without "Experimental appliances"**:
  they're checked against Home Assistant's data from real appliances. After this update they
  appear in the Home app on their own; to keep one out, add it to **Leave out these appliances**.
  The "Extra switches for experimental appliances" setting is now just "Extra switches" (same
  setting, nothing to change).

### Added
- Washers, dryers, dishwashers and Stylers: a **remote start** sensor, on while Remote Start is on
  at the machine (with "Allow starting and pausing" on). The log notes LG's cycle count when a cycle finishes.
- README: comparison with the other LG plugins, Home Assistant parity, privacy, and Homebridge and
  Node.js compatibility. `docs/verified-checklist.md` tracks the Homebridge Verified requirements.
- `npm run test:homebridge1` runs the tests on Homebridge 1.8.
- **Copy diagnostics** on the settings page: what LG says about each appliance, with device IDs,
  serial numbers and the token removed, ready to paste into an issue (no terminal needed).
- README: what the plugin can change on your appliances and what each needs; troubleshooting
  (from Home Assistant's and this plugin's issues); debug logging for this plugin only; a step-by-
  step move from homebridge-lg-thinq, with how the tiles map.
- **Support levels** (README, the log, the settings page's Check token): **tested** on a real
  appliance, **checked** against Home Assistant's LG integration on real-appliance data, or
  **experimental**. The tests compare what the Home app gets with what Home Assistant shows for its
  samples (air conditioners, dehumidifier, range hood, washer), read
  straight from Home Assistant's own snapshot files; the one intentional difference (air
  conditioner fan speed on units with two speed fields) is listed with its reason.
- A compatibility promise for 1.0 (README, "Updates and compatibility"): 1.x never renames or
  removes a tile, sensor, switch or setting. The tests now hold every appliance's HomeKit tiles
  and the settings to a recorded list, so a change fails until it's deliberately approved
  (`npm run surface:update`).

## 0.2.0-beta.8 - 2026-11-23

From a pass through Home Assistant's LG integration (its 127 issues and its fixes) and LG's own
toolkit and its issues: what real users of LG's official API ran into, and what Home Assistant
offers that HomeKit can show.

### Fixed (washers, dryers and other cycle appliances)
- Time left could read an hour too long below one hour: LG's live updates leave the hours out
  when they drop (instead of sending 0). Minutes that wrap round without hours now take the hour
  down by one; otherwise the hour is kept (unchanged fields are left out too).
- Some washers send "washing is complete" while still weighing the load: no longer a false "done".
  It's ignored while the machine is detecting the load; with more than 10 minutes still shown, the
  next state decides.
- Energy (Eve) is checked once a day at a random time between 1 and 6 am instead of hourly, as
  Home Assistant does, to spread the load on LG's servers; LG updates it daily.
  A failed check is tried again within the hour.

### Added (experimental appliances)
- Air conditioners: fan speed on units that report it as `windStrengthDetail` (`windStrength`
  stays preferred where both exist, as it has Auto); newer units' airflow styles as switches
  (forest wind, air guide, high ceiling, swirl…); errors on the problem sensor, where the unit reports them;
  picking a mode while it's off switches it on in that mode (LG refuses a mode change while off).
- Humidifiers: auto, sleep, hygiene dry, warm mist, mood lamp and display light switches;
  temperature and air quality sensors.
- Ventilators: CO₂ (the Home app's alarm above 1,000 ppm), PM2.5/PM10 and temperature.
- AeroTower: display light switch.
- Fridges: power saving as a switch, Sabbath mode as a status sensor (LG doesn't allow changing
  it), up to three water filters plus the air filter, ON/OFF settings such as rapid freeze as
  switches.
- Wine cellars: the light (refused, with a message, while LG blocks light control) and optimal
  humidity.
- Water heaters: their modes (heat pump, turbo, vacation…) as switches.
- Cooktops: each burner's level and time left in the log.
- Stick vacuums: battery and charging.

### Checked
- An independent review before release; fixed from it: a scene that switches an air conditioner
  off while setting its mode no longer switches it back on (a mode picked while off waits briefly
  for the same action's on/off), the hour rule above, a held instead of dropped early "finished"
  alert, energy retries, water heater mode switches only undoing their own mode, and the wine
  cellar light kept within LG's range.

### Notes
- Home Assistant users report that on some washers a start through LG's official API runs the
  default program instead of the one on the dial (LG hasn't answered); see the README.

## 0.2.0-beta.7 - 2026-11-23

Closing the gap with the other LG plugins, where LG's official API allows it.

### Added
- **Ovens** (experimental): a thermostat per cavity. Heat (or the main tile) starts the oven at the
  set temperature (350 °F or 175 °C until one is chosen; in its current cook mode, or bake), off
  stops it, and a new temperature while it's cooking is sent at once, in the oven's own unit. A
  paused or self-cleaning oven is never restarted from the Home app. LG doesn't report the actual
  oven temperature, so the set one shows. Needs "Allow starting and pausing" and remote control on
  at the oven.
- **Cooktops** (experimental): an "in use" sensor and one per burner, for "the stove is still on"
  notifications and automations, and an "all burners off" button on models LG allows it for.
  Before, cooktops only got the basic tile.
- **Options per appliance** (Advanced): extra switches on or off for one appliance; for air
  conditioners, cooling or heating only, which way the tile's swing moves (up-down, left-right
  or both; the other direction gets a switch), and a room temperature sensor.
- **Energy use** in the Eve app: this month's kWh on the main tile, for appliances LG keeps it for
  (checked hourly; LG updates it with a delay). On by default; a setting turns it off and takes
  the figure off the tiles.
- Air purifiers: a **turbo** switch (the fastest setting stays off the speed slider). AeroTower:
  **warm mode** and **UV nano** switches, its own modes, and a temperature sensor.

### Checked
- An independent review of these additions, before release; its findings are fixed here: a
  paused oven isn't resumed by a temperature change, self-cleaning isn't treated as cooking, the
  main tile can't start an oven without a temperature, a temperature chosen in the Home app isn't
  replaced by an old one, the cooktop "all off" button is found where LG puts it, TURBO stays off
  the speed slider, energy is retried after a failure, and a cooling- or heating-only air
  conditioner left in another mode is switched to it when turned on.

### Fixed
- Ovens and microwaves: DONE and CLEANING_IS_DONE count as finished, PAUSED as paused, and an
  oven cooling down after cooking no longer shows as running.

## 0.2.0-beta.6 - 2026-11-23

### Fixed (from an independent code review; these were listed by mistake in 0.2.0-beta.5's release notes)
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

### Changed
- Sign-in steps (README, settings page): choose your country at the top of the token page first,
  since it decides which LG sign-in you get; use the same country in the plugin's settings.

## 0.2.0-beta.5 - 2026-11-23

### Added
- **Check token** in the plugin's settings: step-by-step sign-in help, and a button that tries the
  token with LG and lists the appliances it can see and how well each is supported, before you
  save or restart.
- The log now starts with who LG signed in and what it found, for example
  `Signed in to LG (US): found Front Load Washer, Dryer.`
- LG's error codes now come with what to do (new terms to accept, wrong country, a missing
  permission, an offline appliance, Remote Start), and a README section on signing in.

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
