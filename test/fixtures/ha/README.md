# Sample appliance data from Home Assistant

These files (`device.json`, `profile.json`, `status.json` per appliance) are copied unchanged from
Home Assistant's LG ThinQ integration tests,
<https://github.com/home-assistant/core/tree/dev/tests/components/lg_thinq/fixtures>, under the
Apache License 2.0 (`LICENSE-Apache-2.0.md` here). Copyright the Home Assistant authors.

They are LG ThinQ Connect API answers for real appliance models, used here only as test data for
the stand-in LG server.

`washer/` and `snapshots/` (the `*.ambr` files: what Home Assistant shows for each sample) were
added later, copied unchanged from the same place
(<https://github.com/home-assistant/core/tree/dev/tests/components/lg_thinq/snapshots>). They're
what `test/ha-parity.test.ts` compares this plugin with. To bring them up to date, copy the
current files from Home Assistant over these and run the tests.
