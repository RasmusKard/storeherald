# Changelog

## [2.2.0](https://github.com/RasmusKard/storeherald/compare/v2.1.0...v2.2.0) (2026-11-07)


### Features

* Link App Store Connect messages to the app from asc.appId when the lookup gives no app id ([#26](https://github.com/RasmusKard/storeherald/issues/26)) ([d41bcc9](https://github.com/RasmusKard/storeherald/commit/d41bcc96baf439b29cdf3c02450010a6f03ae39f))


### Bug Fixes

* Answer 404 to a POST for an unknown path without reading its body ([#20](https://github.com/RasmusKard/storeherald/issues/20)) ([e183a81](https://github.com/RasmusKard/storeherald/commit/e183a81f8c6c5ca83f296f50063ee181f0177b82))
* Drop a half-cut Slack escape before the ellipsis of cut text ([#25](https://github.com/RasmusKard/storeherald/issues/25)) ([678333d](https://github.com/RasmusKard/storeherald/commit/678333d1e0c207269d844a2510aa51bd7257a7bf))
* Percent-encode /ingest link URLs so each target's URL cap counts what it sends ([#22](https://github.com/RasmusKard/storeherald/issues/22)) ([3549859](https://github.com/RasmusKard/storeherald/commit/3549859308fbf02d4df7869c74f300b60d6833b8))
* Post a batch's messages one at a time ([#18](https://github.com/RasmusKard/storeherald/issues/18)) ([e71e269](https://github.com/RasmusKard/storeherald/commit/e71e269428af5f1ae76f749dd36c6c17b0c03af5))
* Reject a Discord threadId that isn't the thread's numeric id ([#24](https://github.com/RasmusKard/storeherald/issues/24)) ([d1804bd](https://github.com/RasmusKard/storeherald/commit/d1804bd3faca85567a4288876e21fc4eabd320c0))
* Reject an empty Teams mention id or name ([#23](https://github.com/RasmusKard/storeherald/issues/23)) ([964deb5](https://github.com/RasmusKard/storeherald/commit/964deb50618c750c030df7e202144e9228685882))
* Start a poll from a fresh baseline when its app, track or option comes back ([#21](https://github.com/RasmusKard/storeherald/issues/21)) ([c3624a5](https://github.com/RasmusKard/storeherald/commit/c3624a58fc316aaf32a0aa99fd85cd3a47fadf88))
* Store vitals names in a stable order, so a re-ranking isn't a KV write ([#19](https://github.com/RasmusKard/storeherald/issues/19)) ([1e73f8d](https://github.com/RasmusKard/storeherald/commit/1e73f8d0955331d4b3a153f1c983ccdc08d0842f))

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
