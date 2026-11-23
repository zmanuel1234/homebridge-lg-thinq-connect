# Homebridge Verified checklist

The [Verified requirements](https://github.com/homebridge/homebridge/wiki/verified-Plugins), checked
against this plugin. Last checked November 2026.

| Requirement | Status |
|---|---|
| Passes the Homebridge plugin checks (`homebridge-plugin` keyword, `main`, engines) | Yes: `package.json` |
| Dynamic platform, set up through the Homebridge UI | Yes: `LGThinQConnect` platform with `config.schema.json` and a custom settings screen |
| Doesn't start without a configuration, and doesn't crash Homebridge without one | Yes: logs what's missing and adds nothing (tested in `test/platform.test.ts`) |
| No post-install scripts, nothing that edits files outside its storage | Yes: no `install`/`postinstall` scripts |
| Published on npm, with the source and issues on GitHub | GitHub: yes. npm: after the first publish |
| GitHub releases with release notes | Yes: each release has its notes from `CHANGELOG.md` |
| Runs on the Node.js versions Homebridge supports | Node.js 22, 24 and 26, tested on each in CI |
| Works on Homebridge 1.6+ and 2.0 | Yes: CI on Homebridge 2, and `npm run test:homebridge1` on 1.8 |
| No analytics or tracking | Yes: the plugin talks only to LG (see [Privacy](../README.md#privacy)) |
| Keeps its files in Homebridge's storage folder | Yes: the live-update key and certificate, readable only by the Homebridge user |
| No unhandled exceptions or rejections | Yes: every LG request and timer is caught and logged; tested for outages, rate limits and bad replies |
| Doesn't log secrets | Yes: the token and certificate are never logged; Copy diagnostics removes them |
| Accessories keep their identity across restarts | Yes: cached accessories are restored, and the HomeKit surface is frozen for 1.x |

**Still to do before applying:** the first npm publish, and a few weeks of the 1.0 release on real
washers and dryers.
