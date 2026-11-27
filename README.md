<p align="center">
  <img alt="LG ThinQ Connect" src="https://raw.githubusercontent.com/zmanuel1234/homebridge-lg-thinq-connect/main/branding/homebridge-lg-thinq-connect.svg" width="150">
</p>

# homebridge-lg-thinq-connect

[![npm](https://badgen.net/npm/v/homebridge-lg-thinq-connect)](https://www.npmjs.com/package/homebridge-lg-thinq-connect)
[![license](https://badgen.net/github/license/zmanuel1234/homebridge-lg-thinq-connect)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-zmanuel1234-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/zmanuel1234)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-zmanuel-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/zmanuel)

Shows LG ThinQ appliances in Apple Home through **LG's official ThinQ Connect API**. You sign in
with a personal access token that LG issues, not your LG password, and the plugin uses LG's
supported, documented API rather than the LG app's own sign-in.

**Washers and dryers** are supported: the time left, a notification when a cycle finishes or
stops on an error, and sensors for automations. **Air conditioners, dehumidifiers and range
hoods** are added too, checked against Home Assistant's data from real appliances. **Other LG
appliances** (fridges, dishwashers, air purifiers, ovens and more) can be tried with the
*Experimental appliances* setting; see [Other appliances](#other-appliances).

## What you get

Each washer or dryer shows up as:

- **The machine** (a valve tile): on while it runs, with the **minutes left** on the tile. While
  paused, it's off and keeps the time left. For the first minute or so of a wash the machine is
  still sensing the load and hasn't worked out the time, so none is shown yet.
- **"Washer Finished"** (contact sensor): open when the cycle finishes. **Turn on
  notifications for it** in the Home app (choose "Opened") to be told when the laundry is ready.
  iOS names it in the notification ("Washer Finished opened"). Many washers switch themselves off shortly after finishing (the tested one after 30 s); "Done" then stays on, so
  you can see the laundry is waiting, until the machine is next switched on or started, for 2 hours
  at most (setting: *Keep "Done" on after the machine switches itself off*), also across a
  Homebridge restart. A dryer keeps it on through wrinkle care; switching it off there ends it.
- **"Washer Error"** (contact sensor): open while the machine reports an error (door, drain,
  water supply, unbalanced load and so on), or after LG's "drying failed" or "error during
  washing" alert, until the error is over (for example the door closed and the machine back to
  ready), the next cycle starts or the machine is switched off. The machine's tile
  also shows a fault.
- **Contact or occupancy sensors**: the Finished, Error and reminder sensors (below) are contact
  sensors, open = on, because iOS names those in its notifications. For occupancy sensors it only
  says "There is activity in Utility Room", the same for each. In Eve a contact sensor reads
  backwards ("Contact: No" = open = finished, an error or due); if you mostly look at them in Eve,
  set *Sensors show as* to occupancy sensors ("Detected"). Changing it replaces these sensors: turn
  their notifications on again, and check automations that used them.
- **Phase sensors** (optional): a sensor that's on during a phase you choose, such as
  *Spinning* or *Drying*, for automations like "turn on the fan while the washer spins".
- **"Washer Tub Clean Due"** (optional, washers that count their cycles): on once LG's cycle
  count reaches the number you set (LG suggests a Tub Clean about every 30 washes). Turn on
  notifications for it as a reminder. The count is LG's own, and starts again after a Tub Clean
  (checked on the tested washer: 23 → 0 at its end; the log says so).
- **"Dryer Clean Lint Filter"** (optional, dryers): on after the number of dries you set, with a
  **"Dryer Lint Filter Cleaned"** button (a switch that turns itself off) that starts the count
  again. LG's API doesn't report the filter, so the plugin counts the finished dries itself (a dry
  stopped half way doesn't count), and keeps the count across Homebridge restarts. Or, as a simple
  reminder without the button, turn on **Lint filter reminder goes off when the dryer starts
  again**: with the reminder after 1 dry, it comes on after every dry and goes off when you start
  the next one.
- **"Dryer Check Vent"** (optional, dryers): on when recent dries take clearly longer than
  this dryer usually needs, a common sign of a clogged lint filter or a blocked vent. LG's dryers
  warn about restricted airflow only on their display, not through LG's API, so the plugin times
  each finished dry (pauses and wrinkle care left out) and compares: it learns the usual time from
  the first 8 dries, and turns on when two of the latest three take the set percentage longer
  (30 % is a good start). One big or wet load doesn't set it off; it goes off again once dries are
  back to usual, for example after the vent is cleaned. It's an estimate, not a reading from the
  dryer, so check the vent when it comes on rather than trusting it blindly.
- **"Washer Ready To Start"** (occupancy sensor, with *Allow starting and pausing* on, for
  machines that report it; dishwashers and Stylers too): detected while Remote Start is on and the
  machine is waiting to be started, so an automation or a notification can tell you it's ready
  to be started from the Home app. It isn't detected during a cycle, while paused, or after it
  finished, even though LG keeps Remote Start on then (and a dryer turns it on by itself during
  wrinkle care, where a start would begin a new cycle), nor during a delayed start.

The log also notes LG's cycle count when it goes up, for machines that keep one, and when a Tub
Clean starts it again. With debug logging on, it notes each dry's time and the usual one.

The names follow your machines' names in the ThinQ app, in title case ("Washer Finished", "Dryer Clean Lint Filter"). Renaming a
tile in the Home app is kept.

**Tips for the Home app.** You get one notification per finish. The Home app's notification names
the room and the sensor, so keep the machine's name in each sensor's name (the default) if several
appliances share a room. Sensors you only use for automations can be taken off the Home view
(the sensor's settings, *Include in Favorites* off); the Remote Start sensor can be left out per
appliance, and the phase, tub-clean, lint filter and vent check sensors are off unless you set them.

Machines with two drums (wash combos) show one set per drum. WashTower units, wash combos and
other laundry models are **experimental** until someone with one confirms they work. The
washer and dryer types are tested on an LG front-load washer (F3P2CYVAT) and dryer (RV13D4AMH).

### Starting and pausing (optional)

With **Allow starting and pausing** on, tapping the machine's tile in the Home app pauses a
running cycle, resumes a paused one, or starts a machine that's ready. LG only accepts this
after **Remote Start** is turned on at the machine itself, a safety rule of LG's. Without it,
the tap is refused, the tile goes back within a few seconds, and the log says why.

How Remote Start is turned on depends on the model; the manual says which button. On the tested
machines: on the washer, hold *Pre-wash* for 3 seconds (after choosing the program); on the
dryer, hold *Energy Saver* for 3 seconds, with the door closed. A Wi-Fi or remote symbol lights up,
and the **Remote Start** sensor turns on. LG turns it off again after a while.

LG sometimes answers a start or pause with *2211 "Device Timeout"* even though the machine did
it. The plugin doesn't treat that as a failure: it logs it at info level and checks the machine,
and the tile follows what the machine reports.

You can't pick the program, temperature or spin speed from the Home app: LG's API doesn't offer
that. Choose those on the machine. **A start from the Home app may run the machine's default
program instead of the one on the dial**: LG's API can only send "start". Seen on an LG washer
(F3P2CYVAT): Speed Wash on the dial, started from the Home app, ran Normal; Home Assistant users
report the same (Cotton on European models). When a washer's cycle time jumps right after a start
like that, the log says so. Pausing and resuming aren't affected. So a remote start suits loads you'd
run on the default program anyway; for anything else, start on the machine and use the Home app
for pause, resume and the notifications.

## Requirements

- An LG account with your appliances in the **LG ThinQ** app.
- A **personal access token** for that account (below).
- Homebridge 1.6 or later (including 2.x), Node.js 22 (22.19 or later), 24 or 26.
- Internet access: the appliances report to LG's cloud, and the plugin asks LG.

## Setup

1. Go to **[connect-pat.lgthinq.com](https://connect-pat.lgthinq.com)**. First choose your
   **country** at the top of the page (it's required, and decides which LG sign-in you get), then
   sign in with the LG account your appliances are on (see [Signing in](#signing-in) if you're not
   sure which one).
2. Choose **ADD NEW TOKEN**, name it (for example *Homebridge*), and **tick every permission**
   under *Scope of authority*.
3. Choose **CREATE TOKEN** and copy it. Keep it private: it gives access to your appliances.
4. Install the plugin: search for **LG ThinQ Connect** in the Homebridge UI's Plugins tab, or run
   `npm install -g homebridge-lg-thinq-connect`.
5. In the plugin's settings, paste the token, set your **country** (the one your LG account
   is registered in, for example US), and press **Check token**: it lists the appliances LG
   shows for that token, and how well each is supported. Then save.
6. Restart Homebridge. The log starts with `Signed in to LG (US): found Front Load Washer, Dryer.`
   and then adds each appliance.

### Signing in

- **Which account?** The token must come from the LG account the ThinQ app shows your
  appliances on. Many people have more than one (an old one, or one made for an integration).
  The ThinQ app shows the email of the account it's signed in to.
- **Signed up with Google, Apple or Facebook, or a password that doesn't work?** On the token
  page choose **sign in with QR code** and scan it with the phone that has the ThinQ app. This
  always signs in to the app's own account.
- **Permissions:** tick every one. With some left out, LG refuses part of what the plugin asks
  (often starting and pausing, or live updates).
- **Country:** the country the LG account was created in. LG serves each account from one region.
  Choose the same country at the top of the token page before signing in, and in this plugin's
  settings. With another country selected there, sign-in can fail even with the right password.
- **No appliances found?** The token is on a different LG account than the app (use the QR code),
  or the appliances aren't registered in the ThinQ app yet.
- The token keeps working until you delete it on the token page. To replace it, create a new one,
  paste it, and delete the old one.

What LG's error codes in the log mean:

| Code | Meaning | What to do |
|---|---|---|
| 1103, 1218, 1302 | The token isn't valid | Copy it again whole, or create a new one |
| 1303 | LG doesn't know this account | Create the token on the account the app uses |
| 1304 | New LG terms to accept | Open the ThinQ app and accept them |
| 1305, 1308 | The token lacks a permission | Create a new token with every permission ticked |
| 1306 | Too many requests | Nothing: the plugin slows down and retries |
| 1307, 1309 | Wrong country for this account | Set the country the account was created in |
| 1222 | The appliance isn't connected | Check it's on and on Wi-Fi in the ThinQ app |
| 2211 | LG didn't hear back from the appliance in time | Usually nothing: the command often worked anyway, and the tile follows the machine |
| 2301 | Remote control is off | Turn on Remote Start at the appliance |
| 2302, 2304 | Not possible right now (state, or switched off) | Try again when the appliance is ready |

### Settings

| Setting | Default | What it does |
|---|---|---|
| Personal access token | | Your token from connect-pat.lgthinq.com |
| Country | US | The country of your LG account (two letters) |
| Allow starting and pausing | Off | Tapping a machine's tile starts, pauses or resumes it (needs Remote Start on the machine) |
| Experimental appliances | Off | Also add the appliance types that are still experimental (see [Other appliances](#other-appliances)). Air conditioners, dehumidifiers and range hoods are added without it |
| Extra switches | On | Air conditioner, air purifier and cooktop switches; turn off for a tidier Home app |
| Live updates from LG | On | Changes and alerts arrive the moment they happen; scheduled checks continue as a backup |
| Energy use in the Eve app | On | This month's energy use for appliances LG reports it for, shown in the Eve app (see [Energy use](#energy-use)) |
| Phase sensors | None | Extra sensors that are on during a chosen phase |
| Tub clean reminder after | 0 (off) | Cycles counted by LG at which the washer's tub-clean sensor turns on |
| Lint filter reminder after | 0 (off) | Dries after which the dryer's lint filter sensor turns on; its "cleaned" button starts the count again |
| Lint filter reminder goes off when the dryer starts again | Off | No "cleaned" button: the reminder goes off when the next dry starts |
| Dryer vent check | 0 (off) | How much longer (%) recent dries must take than usual for the vent check sensor; 30 is a good start |
| Keep "Done" on after the machine switches itself off | 120 min | How long at most "Done" stays on after a machine switches itself off straight from finished (until it's next switched on or started); 0 = off together with the machine |
| Sensors show as | Contact sensors | Contact sensors (open = on; named in iOS's notifications) or occupancy sensors (detected = on; read better in Eve) for the Finished, Error and reminder sensors. Changing it replaces them: set their notifications and automations again |
| Leave out these appliances | None | Names, as in the ThinQ app, to keep out of the Home app |
| Options per appliance | None | Air conditioner modes, swing direction and room sensor, and extra switches, for one appliance (see [Options per appliance](#options-per-appliance)) |
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

The plugin's only dependency is Homebridge's own helper for the settings page. It talks to LG's
API and message server directly, with the requests and headers LG documents and uses in its own
toolkit.

## What the plugin can change on your appliances

The plugin only reads, unless you allow more. Everything that changes something on a real
appliance, and what has to be true first:

| Appliance | What it can do from the Home app | Needs |
|---|---|---|
| Washer, dryer, WashTower | Start, pause, resume | **Allow starting and pausing** on, and **Remote Start** pressed on the machine (LG refuses otherwise) |
| Dishwasher, Styler | Start, pause, resume | The same, and **Experimental appliances** on |
| Oven | Start at a temperature, change the temperature while cooking, stop | **Experimental appliances** and **Allow starting and pausing** on, and remote control on at the oven. Never restarts a paused or self-cleaning oven |
| Cooktop | Switch every burner off | Models LG allows it for. It can never switch a burner on |
| Air conditioner, dehumidifier, range hood | On/off, modes, temperature, fan speed, the extra switches (as LG's own app allows) | Nothing: added like washers and dryers. Leave one out with **Leave out these appliances** |
| Air purifier, humidifier, fan | On/off, modes, fan speed, the extra switches | **Experimental appliances** on (as LG's own app allows) |
| Fridge, wine cellar, water heater, heat pump | Set temperatures, express and eco modes, water heater modes, the wine cellar light | **Experimental appliances** on |
| Over-the-range microwave | Vent fan speed and light (never cooking) | **Experimental appliances** on, where LG allows it |
| Robot vacuum | Start, resume, send home | **Experimental appliances** on |
| Other appliances with a basic tile (kimchi fridge, plant cultivator…) | On/off, where LG allows it | **Experimental appliances** on |

Stick vacuums are read-only, and so is anything LG marks read-only, such as a
fridge's Sabbath mode. LG also refuses any command an appliance can't take in its current state;
the Home app then shows an error and the log says why.

## Other appliances

The plugin also adds the LG appliance types below: the **checked** ones (air conditioners,
dehumidifiers, range hoods) always, the **experimental** ones with **Experimental appliances** on.
They're built from LG's documentation, Home Assistant's LG integration and its sample data from real
appliances, and two other plugins on the same API (credits below). If you try one, please
[report how it works](https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues/new/choose).

Each type has one of three levels:

- **Tested**: confirmed on a real appliance by someone using this plugin.
- **Checked**: matches Home Assistant's LG integration on data captured from a real appliance.
  The plugin's tests feed it the same LG answers Home Assistant's tests use and compare what the
  Home app gets with what Home Assistant shows (`test/ha-parity.test.ts`), so it
  stays in step as either side changes. Controls are built the same way, but not yet confirmed on
  a real one.
- **Experimental**: built from LG's documentation and its own toolkits; not yet confirmed.

| Appliance | In the Home app | Status |
|---|---|---|
| Washer, dryer | Tile with time left; done, problem, phase and tub-clean sensors; start and pause; dryers: lint filter reminder and vent check (worked out by the plugin) | **Tested** |
| WashTower, wash combo | As washer and dryer, one set per drum | Experimental (always on) |
| Dishwasher | As a washer, plus door and "rinse aid low" sensors; the course and a delayed start in the log | Experimental |
| Styler | As a washer: time left, done, problem | Experimental |
| Oven (each cavity) | As a washer: time left, done, problem; and a thermostat: heat (or the main tile) starts the oven at the set temperature (350 °F or 175 °C until you choose one; in its current cook mode, or bake), off stops it, and a new temperature while it's cooking is sent at once. A paused or self-cleaning oven is never restarted from the Home app. LG doesn't report the oven's actual temperature, so the thermostat shows the set one. Needs "Allow starting and pausing" and remote control on at the oven | Experimental (from LG's documentation) |
| Cooktop | "In use" sensor (any burner on) and one per burner, for "the stove is still on" notifications and automations; an "all burners off" button on models LG allows it for; each burner's level and time left in the log | Experimental (from LG's documentation) |
| Air conditioner | Heater/cooler: on/off, cool / heat / auto (as the unit offers), room and set temperature (separate heating and cooling set points in auto, on units with two-set), fan speed (Auto at the top of the slider), swing. Switches, where the unit offers them: air purify, energy saving, display light, the other swing direction, jet mode, dry mode, fan mode, and newer units' airflow styles (forest wind, air guide, high ceiling, swirl…). Air quality, humidity and filter sensors; "problem" for a full water tank, or an error where the unit reports one. Picking a mode while it's off switches it on in that mode. Per appliance: cooling or heating only, which way the tile's swing moves, and a room temperature sensor (see [Options per appliance](#options-per-appliance)) | **Checked** (Home Assistant's three samples) |
| Refrigerator, wine cellar | Door-open sensor per door; set temperature per compartment; express modes, eco and power saving as switches (as status sensors where LG doesn't allow changing them, such as Sabbath mode); up to three water filters and the air filter; wine cellar light and optimal humidity | Experimental |
| Dehumidifier, humidifier | Humidifier tile: on/off, humidity now and target, fan speed; "problem" for a full tank. Humidifiers: auto, sleep, hygiene dry, warm mist, mood lamp and display light switches; temperature and air quality | Dehumidifier **checked**, humidifier experimental |
| Air purifier, AeroTower | Air purifier tile: on/off, auto or manual, fan speed (Auto at the top); sleep mode and turbo switches; AeroTower warm mode, UV nano and display light switches; air quality (PM2.5, PM10), temperature, humidity and filter life when reported | Experimental (Home Assistant's purifier sample has nothing to compare with yet) |
| Ceiling fan, ventilator | Fan: on/off and speed. Ventilators: CO₂ (with the Home app's alarm above 1,000 ppm), PM2.5/PM10 and temperature | Experimental |
| Range hood | Fan with speed steps, and the light with brightness | **Checked** (the fan, against Home Assistant's sample; the light is experimental) |
| Over-the-range microwave | Running and time left (to the second), "done" sensor, vent fan and light. LG's API has no cooking mode, power level or temperature | Experimental |
| Water heater | Thermostat: on/off, tank and set temperature; its modes (heat pump, turbo, vacation…) as switches | Experimental |
| Heat pump (system boiler) | Thermostat for room heating or cooling, and one for hot water | Experimental |
| Robot vacuum | Switch, on while cleaning (on starts or resumes, off sends it home); battery | Experimental |
| Stick vacuum | Battery and charging (LG's API has no control for it) | Experimental |
| Anything else | What its profile shows: on/off, temperatures, humidity, LG's problem alerts | Experimental (basic) |

Some air conditioners don't report air purify back; its switch then shows the last command. LG's
official API has no quiet mode, and no light for air purifiers. It doesn't cover older (ThinQ1)
appliances, microwave cooking, or a washer's door lock.

### LG quirks

Things LG's API does that the plugin works around or can't fix (from Home Assistant's and LG's own
issue reports): below an hour, live updates leave the hours out of the time left (the plugin reads
that as 0); some washers send "washing is complete" while still weighing the load (ignored); water
heater and heat pump temperatures can stay stale until someone opens the ThinQ app; older Wi-Fi
modules answer slowly; some models (often dryers) have no energy figures or cycle count.

Seen on the tested washer and dryer, all handled: the time left jumps in the first minutes while
the washer weighs the load (both ways: 65 → 53 or 65 → 80 minutes), and rinse or spin can drop a
few minutes at once; at power-on LG briefly reports a cycle count of 0 (ignored); a dryer turns
Remote Start on by itself during wrinkle care; the dryer reports no door state, so opening its
door isn't a "problem"; the washer's door locks during a cycle.

Fridges report each compartment's **set** temperature, not the measured one, so that's what their
tiles show. LG's API can't choose wash programs on any appliance.

### Options per appliance

Under **Advanced → Options per appliance**, add an appliance by its name exactly as in the ThinQ
app, then choose:

| Option | For | What it does |
|---|---|---|
| Extra switches | Any | Overrides the "Extra switches" setting for this one |
| Modes on the tile | Air conditioner | All it has, cooling only, or heating only (for a unit used one way) |
| The tile's swing moves | Air conditioner | Up and down (default), left and right, or both; the other direction gets a switch |
| Room temperature sensor | Air conditioner | The room temperature as a sensor of its own, for automations |
| Leave out the Remote Start sensor | Washer, dryer (and other cycle appliances) | No Remote Start sensor for this one; the others keep theirs |

### Energy use

For appliances LG keeps energy figures for, this month's use (kWh) is added for the **Eve** app
(free on the App Store; Apple's Home app doesn't show energy and adds no tile for it). In Eve,
open the appliance: **Total Consumption** is listed with its other values. If you don't see it,
check every room: Eve may list the energy figure in a different room from the appliance. LG updates the figure with a
delay, often a day, so the plugin checks it once at startup and then once a day, at a random
time between 1 and 6 am (as Home Assistant does, to spread the load on LG's servers). It's this month's figure, so it starts
again from 0 on the 1st (Eve treats it as a running total). Turn it off with **Energy use in the
Eve app**; the figure is then taken off.

### Help add or fix an appliance

Run the diagnostics command on your Homebridge machine. Homebridge installs plugins in its own
folder, so the command is run from there:

```bash
# Homebridge on a Raspberry Pi or Debian/Ubuntu (the official image or apt package)
cd ~ && PATH=/opt/homebridge/bin:$PATH /var/lib/homebridge/node_modules/.bin/lg-thinq-diagnostics --country US

# Homebridge in Docker (inside the container, for example with docker exec -it homebridge bash)
cd /homebridge && node node_modules/homebridge-lg-thinq-connect/dist/bin/lg-thinq-diagnostics.js --country US

# Plugin installed globally with npm install -g
lg-thinq-diagnostics --country US
```

Use your LG account's country instead of US. It asks for your token without showing it, and prints
what LG reports about each appliance, with device IDs and serial numbers removed. It writes nothing
to disk unless you ask: add `--out lg-diagnostics.json` to save it to that file instead. Look it
over, then paste or attach it to a
[new appliance issue](https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues/new/choose),
with what works and what doesn't. (The settings screen's **Copy diagnostics** gives the same
report without a command.)

## Troubleshooting

Most problems come from LG's side; these are the ones Home Assistant's and this plugin's users
run into most.

| What you see | What to do |
|---|---|
| Every notification says "There is activity in <room>" | Those are occupancy sensors: set *Sensors show as* to Contact sensors (the default since 2.0), so iOS names the sensor; then turn their notifications on again |
| "LG error 1103", "1218" or "1302" (often with HTTP 401) | The token isn't valid: create a new one, with every permission ticked (see [Signing in](#signing-in)) |
| No appliances found, or not all of them | The token is on a different LG account than the ThinQ app's: sign in to the token page with the QR code. Check the country |
| "LG error 1307 / 1309" | The country doesn't match the LG account: set the one the account was created in |
| "LG error 1304" | LG has new terms: open the ThinQ app and accept them |
| "LG error 1222" or the tile shows "No Response" | The appliance is off or offline: check it's on and connected in the ThinQ app |
| Start or pause refused | Turn on **Remote Start** at the machine (see [Starting and pausing](#starting-and-pausing-optional); dryers need the door closed), and check "Allow starting and pausing" |
| "LG didn't confirm it (2211)" in the log | Usually nothing: LG answered late, and the tile shows what the machine actually did |
| A tile shows "No Response" after a refused tap | Fixed in 1.0.6: update the plugin |
| "Done" didn't turn off when the machine switched itself off | As designed: it stays on until the machine is next switched on or started, for at most the time set in *Keep "Done" on…* |
| No energy figure in Eve | Look in every room in Eve: it can show the figure in another room than the appliance |
| A start ran a different program | Reported on some washers with LG's official API: start on the machine, and use the Home app for pause, resume and notifications |
| Time left or status a little behind | Updates come live from LG; scheduled checks correct anything missed within 2 minutes during a cycle. Older Wi-Fi modules report less often |
| Water heater or heat pump temperatures stale | An LG limit: they often update only when the ThinQ app is opened |
| Energy shows nothing | LG updates energy daily, with a delay; some models (often dryers) have none |

**Debug logging.** For a closer look, turn on debug logging for this plugin only: run it as a
child bridge (in the Homebridge UI, the plugin's **Bridge Settings**), then turn on debug mode
for that bridge, either there or by adding `"_bridge": { "debugModeEnabled": true }` to the
plugin's config (with the child bridge's other `_bridge` settings). The log then also shows
each live update from LG, appliances that still couldn't be set up, and energy checks. Turn it
off again afterwards: it writes several lines a minute during a cycle.

To save the plugin's lines from the log on a Raspberry Pi with the official image:
`grep -a '\[LG ThinQ\]' /var/lib/homebridge/homebridge.log > ~/lg-log.txt` (the `-a` is needed
because grep otherwise takes the log for a binary file).

**Reporting a problem.** Open a
[bug report](https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues/new?template=problem.yml)
with the versions, what you did, and the plugin's log lines (debug logging helps). For a problem
with one appliance's data, also press **Copy diagnostics** in the plugin's settings: it collects
what LG says about each appliance, with device IDs, serial numbers and the token removed, and
only copies it to your clipboard. Look it over before pasting. Never paste your token.

## Updates and compatibility

Your scenes and automations are built on the tiles and sensors this plugin adds, so within a
major version (now 2.x):

- **Updates never rename or remove** a tile, sensor or switch, or a setting. They may add new ones
  (often off by default, or behind a setting).
- Anything that would break that waits for the next major version (**3.0**), with a migration
  note in the CHANGELOG. 2.0's is there: the Finished, Error and reminder sensors became contact
  sensors, under one setting.
- **Betas** (versions like `2.1.0-beta.1`) are published under npm's `beta` tag, so you only get
  them if you ask for them; the Homebridge UI's normal update installs stable versions only.

The plugin's tests hold every appliance's tiles and settings to a recorded list
(`test/surface.snapshot.json`), so a change can't slip through by accident.

**Homebridge and Node.js.** Works with Homebridge 1.6 or later and Homebridge 2.0, on Node.js 22,
24 or 26. Every change is tested on Homebridge 2 and Node.js 22, 24 and 26; before each release
the tests are also run on Homebridge 1.8 (`npm run test:homebridge1`).

## Privacy

- Your token is kept only in your Homebridge settings. The plugin sends it only to LG's ThinQ
  Connect servers, the same ones LG's own app uses.
- The plugin talks to nobody but LG: no analytics, no tracking, no update checks of its own.
- For live updates the plugin creates a private key on your Homebridge, and LG signs a
  certificate for it. Both are kept in Homebridge's storage folder, readable only by the
  Homebridge user; the private key never leaves it.
- **Copy diagnostics** removes the token, device IDs and serial numbers, and only copies to your
  clipboard: nothing is sent anywhere until you paste it yourself.

## Coming from homebridge-lg-thinq

This plugin can run next to [homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq)
(or one of its forks), so you can switch at your own pace:

1. Install this plugin, create a token (see [Setup](#setup)) and add it. Both plugins now show
   your appliances; this one's tiles are new to the Home app.
2. To keep the Home app tidy meanwhile, add the appliances to **Leave out these appliances** in
   one of the two plugins.
3. Compare for a few cycles. The tiles map like this:

   | homebridge-lg-thinq | This plugin |
   |---|---|
   | Washer/dryer valve (time left) | The same kind of tile, `<name>` |
   | "Program finished" sensor (`washer_trigger`) | `<name> Done` (always on) |
   | Tub clean event (`washer_tub_clean`) | `<name> Tub Clean`, after the cycles you set |
   | Door lock (`washer_door_lock`) | Not available: LG's official API doesn't report it |
   | AC options (`ac_mode`, `ac_swing_mode`, `ac_temperature_sensor`) | **Options per appliance** |
   | Fridge express/eco switches | The same switches, added automatically |

4. Move your notifications, scenes and automations to the new tiles. The Home app doesn't carry
   them over between plugins.
5. Remove the old plugin. Its accessories disappear from the Home app.

Older appliances that only work with LG's previous system (ThinQ1) aren't reachable through LG's
official API: keep the old plugin for those, and leave them out of this one.

## Compared with other HomeKit plugins for LG

Checked November 2026. Plugins that use **LG's official ThinQ Connect API** (a token from LG)
rely on LG's supported, documented API; the others sign in the way LG's app does, with your LG
password, and depend on that sign-in staying the same.

| Plugin | LG API | Appliances |
|---|---|---|
| **This plugin** | Official | 26 appliance types mapped (others get a basic tile when LG reports something usable): washer and dryer tested on real machines, air conditioner, dehumidifier and range hood checked against Home Assistant's data, the rest experimental. Energy use, live updates, settings screen with a token check and Copy diagnostics |
| [homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) and its forks (homebridge-lg-thinq-2, @rnikoopour, @bvksound and others) | LG app login | Many types, including older ThinQ1 appliances this API can't reach, and a few details the official API doesn't report (such as the washer's door lock) |
| [@0modfather0/homebridge-lg-thinq](https://www.npmjs.com/package/@0modfather0/homebridge-lg-thinq) | Official | Washers, dryers and a few others, read-only |
| [homebridge-lg-thinqconnect-ac](https://www.npmjs.com/package/homebridge-lg-thinqconnect-ac) | Official | Air conditioners |
| [homebridge-lg-thinq-system-boiler](https://www.npmjs.com/package/homebridge-lg-thinq-system-boiler) | Official | Heat pumps and hot water |

## Home Assistant parity

Home Assistant's [LG ThinQ integration](https://www.home-assistant.io/integrations/lg_thinq/) is
the most used project on LG's official API, so this plugin keeps track of it:

- **Same data.** The tests run Home Assistant's own sample data from real appliances through this
  plugin and compare what the Home app gets with what Home Assistant shows for the same sample:
  power, mode, temperatures and their limits, fan speed, swing, humidity (`test/ha-parity.test.ts`).
  An appliance type is marked *checked* once that passes. Values Home Assistant doesn't show
  (such as a range hood's light) aren't part of the comparison.
- **Same known quirks.** LG problems reported by Home Assistant users are handled here too (see
  [LG quirks](#lg-quirks)), such as the time left jumping when it drops below an hour and the
  "finished" alert LG sends while a washer is still weighing the load.
- **Intentional differences.** For air conditioners with both a fan speed and a detailed fan speed,
  the plugin uses the plain one, so *Auto* stays available (Home Assistant shows the detailed
  one). Some values have no Home app tile, such as the program name, filter dates or a fridge's
  door alarm history; these are in the log instead.
- **Not covered yet.** The kimchi refrigerator shows nothing beyond its basic tile.

Each week an automated check, run by the maintainer, looks at new Home Assistant changes and LG
toolkit releases, and opens a "Parity check" issue here when something needs a look.

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
