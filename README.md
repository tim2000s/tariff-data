# tariff-data

Live curated data channel for the UK Tariff Compare / Optimiser / Planner apps.

`other-tariffs.json` is fetched by the apps at runtime from GitHub Pages
(https://tim2000s.github.io/tariff-data/other-tariffs.json), so curated tariff
updates land on installed apps **without an app release**. The copy bundled in
each app at build time is only the offline fallback; whichever copy has the
newer `updated` date wins on-device.

Contents:
- `tariffs` — national-average electricity tariffs for suppliers WITHOUT open
  Kraken APIs (SVT @ Ofgem cap, British Gas, So Energy, ScottishPower, …).
  Octopus / EDF / E.ON Next are priced live in-app and are never listed here.
- `removed` — tombstoned ids; installed apps delete these from their stores.
- `closedToNew` — case-insensitive regex sources matched against Kraken
  product codes for products still in the API but closed to new sign-ups.

Updated by the monthly tariff review (scraper: `tariff-compare/scraper/`,
publish: `tariff-compare/scraper/publish-remote.sh`). Commit history doubles
as the audit log of every data change.
