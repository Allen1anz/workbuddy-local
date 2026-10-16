# Source preview 0.1.0

Published scope: independently implemented `server/`, `tools/`, `desktop/`, `public/`, workspace assembly, dependency lockfile and tests. The public desktop server defaults to the independent web UI. The local private product tree is preserved separately.

Excluded: original renderer, expert/skill catalogs, artwork, fonts, extracted vendor code, native original runtime, model weights, virtual environments, node_modules, packaged apps, QA captures, chat databases, user configuration and keys.

## Validation on 2026-10-16

`npm ci` completed using the official npm registry. Public suite: 258 tests, **249 passed, 0 failed, 9 skipped**. This is not the private full-product suite's 297-test result.

The public test runner excludes these complete files because they inspect external proprietary resources or the installed original application:

- `server/desktop-static.test.mjs`
- `server/renderer-capabilities.test.mjs`
- `server/resources.test.mjs`
- `server/expert-resources.test.mjs`
- `server/skill-resources.test.mjs`
- `tools/mcp-app-http.test.mjs`
- `tools/mcp-app-catalog.test.mjs`

Six individual fixture-dependent tests in the desktop dispatcher, expert refresh/SDK/switch and skill SDK suites are explicitly skipped under `WORKBUDDY_PUBLIC_TESTS=1`. Three DSH runtime integration tests skip unless a built DSH repository is supplied with `DSH_REPOSITORY`. The remaining tests still run, including product approval, media protocol validation, expert/skill management and cancellation coverage.

`npm run test:all` also runs external-resource tests. It is expected to fail when those external fixtures are absent; they are deliberately not bundled into the public source release.

The original local environment separately passed real Qwen conversation, approval-gated writes and selected skill invocation using DSH. A fresh public clone needs its own model endpoint, optionally a separately built DSH tree, and optional media dependencies/weights. No real model service is started automatically by this release.

## Remaining work

- Expert-team execution and full expert workflows under DSH.
- Full WorkBuddy 5.8.3 compatibility and newer UI/media flows.
- Independent desktop UI feature parity and portable packaging validation.

The project does not include official account, subscription, WeChat or cloud-marketplace services.
