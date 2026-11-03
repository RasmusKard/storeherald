# Changelog

## [2.1.0](https://github.com/RasmusKard/storeherald/compare/v2.0.0...v2.1.0) (2026-11-03)


### Features

* Notify on TestFlight external beta review and when a build reaches external testers ([d856274](https://github.com/RasmusKard/storeherald/commit/d8562741faf074a76f5ba984285bbb6961a3a79e))
* Notify when App Review sends back a submission the version webhook doesn't report ([d856274](https://github.com/RasmusKard/storeherald/commit/d8562741faf074a76f5ba984285bbb6961a3a79e))
* Post Android vitals anomalies and new crash and ANR issues from Google Play ([d856274](https://github.com/RasmusKard/storeherald/commit/d8562741faf074a76f5ba984285bbb6961a3a79e))
* Post App Store phased release progress ([d856274](https://github.com/RasmusKard/storeherald/commit/d8562741faf074a76f5ba984285bbb6961a3a79e))
* Post new App Store and Google Play reviews ([d856274](https://github.com/RasmusKard/storeherald/commit/d8562741faf074a76f5ba984285bbb6961a3a79e))
* Post TestFlight tester feedback and crash reports ([d856274](https://github.com/RasmusKard/storeherald/commit/d8562741faf074a76f5ba984285bbb6961a3a79e))

## [2.0.0](https://github.com/RasmusKard/storeherald/compare/v1.0.0...v2.0.0) (2026-11-02)


### ⚠ BREAKING CHANGES

* Run as a Cloudflare Worker ([#13](https://github.com/RasmusKard/storeherald/issues/13))

### Features

* Run as a Cloudflare Worker ([#13](https://github.com/RasmusKard/storeherald/issues/13)) ([bbdbc4a](https://github.com/RasmusKard/storeherald/commit/bbdbc4a273766cbb1cb0be5c37608e133be66769))

## 1.0.0 (2026-10-30)


### Features

* Add Google Play release polling with a pluggable state store ([22af418](https://github.com/RasmusKard/storeherald/commit/22af418db58b5c9a31e8ea514d5be44fe1234ba9))
* Add Slack, Discord and Teams targets ([fa42b73](https://github.com/RasmusKard/storeherald/commit/fa42b739f6708ca184346cd448b9b2c47c285600))
* Add the EAS, App Store Connect and custom event webhook sources ([8251725](https://github.com/RasmusKard/storeherald/commit/825172553d313bd1e70904cd1868c88b07551e24))
* Add the webhook server with /eas, /asc and /ingest endpoints ([733f0fd](https://github.com/RasmusKard/storeherald/commit/733f0fd8065cf22c47bafc3b6d89fcdaeb39fe2f))
* Add YAML config and event routing by target type, label and severity ([753801e](https://github.com/RasmusKard/storeherald/commit/753801e458819186cfbbf9bae8c111ed64e4eabe))
