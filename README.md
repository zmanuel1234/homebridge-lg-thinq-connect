<p align="center">
  <img alt="LG ThinQ Connect" src="https://raw.githubusercontent.com/zmanuel1234/homebridge-lg-thinq-connect/main/branding/homebridge-lg-thinq-connect.svg" width="150">
</p>

# homebridge-lg-thinq-connect

[![npm](https://badgen.net/npm/v/homebridge-lg-thinq-connect)](https://www.npmjs.com/package/homebridge-lg-thinq-connect)
[![license](https://badgen.net/github/license/zmanuel1234/homebridge-lg-thinq-connect)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-zmanuel1234-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/zmanuel1234)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-zmanuel-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/zmanuel)

Shows LG ThinQ appliances in Apple Home through **LG's official ThinQ Connect API**. You sign in
with a personal access token that LG issues, not your LG password, so the plugin doesn't break
when LG changes its app's login.

**Washers and dryers** are supported: the time left, a notification when a cycle finishes or
stops on an error, and sensors for automations. **Other LG appliances** (air conditioners, fridges,
dishwashers, dehumidifiers, air purifiers and more) can be tried with the *Experimental
appliances* setting; see [Other appliances](#other-appliances).

## What you get

Each washer or dryer shows up as:

- **The machine** (a valve tile): on while it runs, with the **minutes left** on the tile. While
  paused, it's off and keeps the time left. For the first minute or so of a wash the machine is
  still sensing the load and hasn't worked out the time, so none is shown yet.
- **"Washer done"** (occupancy sensor): detected when the cycle finishes, until the machine
  starts again or is switched off. **Turn on notifications for it** in the Home app to be told
  when the laundry is ready.
- **"Washer problem"** (contact sensor): open while the machine reports an error (door, drain,
  water supply, unbalanced load and so on), or after LG's "drying failed" or "error during
  washing" alert, until the next cycle starts or the machine is switched off. The machine's tile
  also shows a fault.
- **Phase sensors** (optional): a sensor that's on during a phase you choose, such as
  *Spinning* or *Drying*, for automations like "turn on the fan while the washer spins".
- **"Washer tub clean"** (optional, washers that count their cycles): detected once LG's cycle
  count reaches the number you set (LG suggests a Tub Clean about every 30 washes). Turn on
  notifications for it as a reminder. The count is LG's own; it's expected to start again after a
  Tub Clean.

The names follow your machines' names in the ThinQ app.

Machines with two drums (wash combos) show one set per drum. WashTower units, wash combos and
other laundry models are **experimental** until someone with one confirms they work. The
washer and dryer types are tested on an LG front-load washer (F3P2CYVAT) and dryer (RV13D4AMH).

### Starting and pausing (optional)

With **Allow starting and pausing** on, tapping the machine's tile in the Home app pauses a
running cycle, resumes a paused one, or starts a machine that's ready. LG only accepts this
after **Remote Start** is pressed on the machine itself, a safety rule of LG's. Without it,
the tap is refused and the log says why.

You can't pick the program, temperature or spin speed from the Home app: LG's API doesn't offer
that. Choose those on the machine.

## Requirements

- An LG account with your appliances in the **LG ThinQ** app.
- A **personal access token** for that account (below).
- Homebridge 1.6 or later (including 2.x), Node.js 22 (22.19 or later), 24 or 26.
- Internet access: the appliances report to LG's cloud, and the plugin asks LG.

## Setup

1. Go to **[connect-pat.lgthinq.com](https://connect-pat.lgthinq.com)** and sign in with the LG
   account your appliances are on. Signing in with the QR code from the ThinQ app works too.
2. Choose **ADD NEW TOKEN**, name it (for example *Homebridge*), and **tick every permission**
   under *Scope of authority*.
3. Choose **CREATE TOKEN** and copy it. Keep it private: it gives access to your appliances.
4. Install the plugin: search for **LG ThinQ Connect** in the Homebridge UI's Plugins tab, or run
   `npm install -g homebridge-lg-thinq-connect`.
5. In the plugin's settings, paste the token and set your **country** (the one your LG account
   is registered in, for example US).
6. Restart Homebridge. The log lists each appliance it found.

If LG rejects the token, the log says so. Check it was copied whole, still exists on the token
page, and has every permission ticked. You can delete a token on that page at any time and
create a new one.

### Settings

| Setting | Default | What it does |
|---|---|---|
| Personal access token | | Your token from connect-pat.lgthinq.com |
| Country | US | The country of your LG account (two letters) |
| Allow starting and pausing | Off | Tapping a machine's tile starts, pauses or resumes it (needs Remote Start on the machine) |
| Experimental appliances | Off | Also add appliance types not yet confirmed on real hardware (see [Other appliances](#other-appliances)) |
| Live updates from LG | On | Changes and alerts arrive the moment they happen; scheduled checks continue as a backup |
| Phase sensors | None | Extra sensors that are on during a chosen phase |
| Tub clean reminder after | 0 (off) | Cycles counted by LG at which the washer's tub-clean sensor turns on |
| Leave out these appliances | None | Names, as in the ThinQ app, to keep out of the Home app |
| Check every (idle) | 60 s | How often to ask LG while nothing runs (at least 10 min while live updates work) |
| Check every (during a cycle) | 30 s | How often to ask while a cycle runs (at least 2 min while live updates work) |

## How it works

**Live updates.** The plugin connects to LG's message server, the way LG's own toolkit and Home
Assistant do: LG signs a certificate for a key made on your Homebridge machine, and then sends
each change (phase, time left, finished, error) and each alert (cycle complete, drying failed) the
moment it happens. The key and certificate are kept in Homebridge's storage folder
(`lg-thinq-connect/`), readable only by Homebridge's user, so a restart reconnects without a new
certificate. If the connection drops, the plugin reconnects on its own, and checks on a schedule
meanwhile.

**Scheduled checks.** The plugin also asks LG for each appliance's state: every 60 seconds while
idle and every 30 seconds during a cycle, or every 10 and 2 minutes as a backup while live
updates work. If LG can't be reached, the appliances stay in the Home app and show a fault after
three failed checks; the plugin keeps trying. If the appliance list can't be fetched at startup,
nothing is removed from the Home app.

The plugin has no dependencies to install: it talks to LG's API and message server directly,
with the requests and headers LG documents and uses in its own toolkit.

## Other appliances

With **Experimental appliances** on, the plugin also adds the LG appliance types below. They're
built from LG's documentation, Home Assistant's LG integration and its sample data from real
appliances, and two other plugins on the same API (credits below), but not yet confirmed by
anyone using this plugin. If you try one, please
[report how it works](https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues/new/choose).

| Appliance | In the Home app | Status |
|---|---|---|
| Washer, dryer | Tile with time left; done, problem, phase and tub-clean sensors; start and pause | **Tested** |
| WashTower, wash combo | As washer and dryer, one set per drum | Experimental (always on) |
| Dishwasher | As a washer, plus door and "rinse aid low" sensors | Experimental |
| Styler, oven | As a washer: time left, done, problem | Experimental |
| Air conditioner | Heater/cooler: on/off, cool / heat / auto (as the unit offers), room and set temperature, fan speed (Auto at the top of the slider), swing; "problem" for a full water tank | Experimental (from real sample data) |
| Refrigerator, wine cellar | Door-open sensor per door; set temperature per compartment; express modes as switches; water filter | Experimental |
| Dehumidifier, humidifier | Humidifier tile: on/off, humidity now and target, fan speed; "problem" for a full tank | Experimental (dehumidifier from real sample data) |
| Air purifier | Air purifier tile: on/off, fan speed (Auto at the top); air quality (PM2.5, PM10) and filter life when reported | Experimental (from real sample data) |
| Ceiling fan, ventilator | Fan: on/off and speed | Experimental |
| Range hood, over-the-range microwave | Fan with speed steps, and the light with brightness | Experimental (hood from real sample data) |
| Water heater | Thermostat: on/off, tank and set temperature | Experimental |
| Heat pump (system boiler) | Thermostat for room heating or cooling, and one for hot water | Experimental |
| Robot vacuum | Switch, on while cleaning (on starts or resumes, off sends it home); battery | Experimental |
| Anything else | What its profile shows: on/off, temperatures, humidity, LG's problem alerts | Experimental (basic) |

Fridges report each compartment's **set** temperature, not the measured one, so that's what their
tiles show. LG's API can't choose wash programs, cooking modes and the like on any appliance.

### Help add or fix an appliance

Run the diagnostics command on your Homebridge machine:

```bash
lg-thinq-diagnostics --country US
```

It asks for your token without showing it, and saves `lg-diagnostics.json`: what LG reports
about each appliance, with device IDs and serial numbers removed. Look it over, then attach it to
a [new appliance issue](https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues/new/choose),
with what works and what doesn't. If Homebridge's npm isn't on your path, run
`node "$(npm root -g)/homebridge-lg-thinq-connect/dist/bin/lg-thinq-diagnostics.js"` instead.

## Coming from homebridge-lg-thinq

This plugin can run next to [homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq),
so you can compare before switching. Its accessories are new to the Home app: set up your
notifications and automations again on them, then remove the old plugin.

## Credits

- LG's [ThinQ Connect](https://thinq.developer.lge.com/en/cloud/docs/thinq-connect/) documentation
  and its Node toolkit [thinqconnect](https://github.com/thinq-connect/jsthinqconnect) (Apache-2.0)
  describe the API and each appliance type's properties.
- Home Assistant's [LG ThinQ integration](https://github.com/home-assistant/core/tree/dev/homeassistant/components/lg_thinq)
  (Apache-2.0) showed how each appliance type behaves; its sample data from real appliances is
  used in this plugin's tests (`test/fixtures/ha`, with its licence).
- [homebridge-lg-thinqconnect-ac](https://www.npmjs.com/package/homebridge-lg-thinqconnect-ac) (MIT)
  for the air conditioner mapping, including sending commands one at a time, and
  [homebridge-lg-thinq-system-boiler](https://www.npmjs.com/package/homebridge-lg-thinq-system-boiler)
  (MIT) for the heat pump mapping.
- The long work in [homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) showed which
  Home app tiles suit each appliance.

## License

MIT
