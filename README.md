# homebridge-lg-thinq-connect

[![npm](https://badgen.net/npm/v/homebridge-lg-thinq-connect)](https://www.npmjs.com/package/homebridge-lg-thinq-connect)
[![license](https://badgen.net/github/license/zmanuel1234/homebridge-lg-thinq-connect)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-zmanuel1234-EA4AAA?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/zmanuel1234)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-zmanuel-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/zmanuel)

Shows LG ThinQ appliances in Apple Home through **LG's official ThinQ Connect API**. You sign in
with a personal access token that LG issues, not your LG password, so the plugin doesn't break
when LG changes its app's login.

This version supports **washers and dryers**: the time left, a notification when a cycle
finishes or stops on an error, and sensors for automations. Other LG appliances are planned
(see [More appliances](#more-appliances)).

## What you get

Each washer or dryer shows up as:

- **The machine** (a valve tile): on while it runs, with the **minutes left** on the tile. While
  paused, it's off and keeps the time left. For the first minute or so of a wash the machine is
  still sensing the load and hasn't worked out the time, so none is shown yet.
- **"Washer done"** (occupancy sensor): detected when the cycle finishes, until the machine
  starts again or is switched off. **Turn on notifications for it** in the Home app to be told
  when the laundry is ready.
- **"Washer problem"** (contact sensor): open while the machine reports an error (door, drain,
  water supply, unbalanced load and so on). The machine's tile also shows a fault.
- **Phase sensors** (optional): a sensor that's on during a phase you choose, such as
  *Spinning* or *Drying*, for automations like "turn on the fan while the washer spins".

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
| Phase sensors | None | Extra sensors that are on during a chosen phase |
| Leave out these appliances | None | Names, as in the ThinQ app, to keep out of the Home app |
| Check every (idle) | 60 s | How often to ask LG while nothing runs |
| Check every (during a cycle) | 30 s | How often to ask while a cycle runs |

## How it works

The plugin asks LG's ThinQ Connect API for each appliance's state on a schedule: every 60 seconds
while idle and every 30 seconds during a cycle. If LG can't be reached, the appliances stay in
the Home app and show a fault after three failed checks; the plugin keeps trying. If the
appliance list can't be fetched at startup, nothing is removed from the Home app.

The plugin has no dependencies to install: it talks to LG's API directly, with the requests and
headers LG documents and uses in its own toolkit.

## More appliances

Fridges, air conditioners, dishwashers, dehumidifiers, air purifiers, ovens and more are on
LG's API and planned. To help add yours, run the diagnostics command on your Homebridge machine:

```bash
lg-thinq-diagnostics --country US
```

It asks for your token without showing it, and saves `lg-diagnostics.json`: what LG reports
about each appliance, with device IDs and serial numbers removed. Look it over, then attach it to
a [new appliance issue](https://github.com/zmanuel1234/homebridge-lg-thinq-connect/issues/new/choose).
If Homebridge's npm isn't on your path, run
`node "$(npm root -g)/homebridge-lg-thinq-connect/dist/bin/lg-thinq-diagnostics.js"` instead.

## Coming from homebridge-lg-thinq

This plugin can run next to [homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq),
so you can compare before switching. Its accessories are new to the Home app: set up your
notifications and automations again on them, then remove the old plugin.

## Credits

LG's [ThinQ Connect](https://thinq.developer.lge.com/en/cloud/docs/thinq-connect/) documentation
and its Node toolkit [thinqconnect](https://github.com/thinq-connect/jsthinqconnect) (Apache-2.0)
describe the API. The long work in
[homebridge-lg-thinq](https://github.com/nVuln/homebridge-lg-thinq) showed which Home app tiles
suit each appliance.

## License

MIT
