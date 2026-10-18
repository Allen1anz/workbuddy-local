# Desktop preview 0.2.0

The Apple Silicon macOS desktop installer contains Electron 37.10.3, Node 24.19.0, Python 3.12.15 and Ollama 0.40.6. The two Apache-2.0 skill packages in `open-skills/` are included with their licenses. Qwen3 1.7B weights download on explicit user request; the base installer contains no model weights or user data. Windows and Intel Mac binaries are not provided. Apple notarization is not available for this preview; the app is ad-hoc signed and signature-verified locally.

## Validation on 2026-10-18

Public suite: 260 tests, **251 passed, 0 failed, 9 skipped**. New tests cover isolated local-model launch policy, explicitly requested model pulls, incomplete-download failure, cancellation, licensed skill registration and preservation of user edits.

On a clean CI machine without the separately installed REA checkout, one additional stdio integration test is explicitly skipped: expected totals are 250 passed, 0 failed and 10 skipped. HTTP/SSE MCP protocol, approval and credential-redaction tests continue to run. The initial CI run exposed this missing external-test guard; it was corrected without changing product behavior.

Real integration: the private bundled Ollama runtime downloaded Qwen3 1.7B from its upstream registry and answered a product chat with `本地模型安装验收通过。`. Native desktop first launch exposed the settings page, licensed skills, default workspace, actual model-download progress and successful cancellation. This is actual model inference, separate from scripted protocol tests.

The final DMG was checksum-verified, mounted read-only, copied into an isolated installation directory and launched there with the same isolated test profile. The stored local-model selection restored to a new private endpoint after restart; a new product chat replied `重启成功。`. Word, Excel and PowerPoint generation used the bundled Python. The private model API reported zero loaded models after the answer. Normal desktop exit was also checked to close the backend listener and terminate its model process.

The desktop host uses a separate bundle identifier, data directory and port from the earlier private compatibility app. Quitting terminates its private backend/model processes. Model concurrency is one; keep-alive is zero and context length is 8192. This limits residency and concurrency, not a hard process-memory cap.

## Build the Mac installer

The repository workflow `.github/workflows/release-macos.yml` performs the pinned runtime download, source tests, packaging and packaged-runtime smoke test on a standard macOS arm64 runner, then publishes a prerelease with DMG/ZIP/checksums. It runs when the package version or release workflow changes, or by manual dispatch. It refuses to replace an already existing release tag. Exact embedded Node hashes are recorded inside each app at `Contents/Resources/runtime/runtime-manifest.json`.

1. Run `npm ci` with Node 24.11+.
2. Install the pinned Electron runtime under `desktop/runtime`, or set `WORKBUDDY_ELECTRON_DIST` to its `dist` directory. Verify it against `desktop/runtime-manifest.json`.
3. Download the pinned Ollama and Python archives listed in `desktop/runtime-manifest.json`, verify their SHA256 values, and extract them under `.release-cache/ollama` and `.release-cache/python`. Retain all bundled license/notice files. Place the Ollama project's MIT license at `.release-cache/OLLAMA-LICENSE`, and retain Python/dependency notices under `.release-cache/python/share/runtime-licenses` from the exact upstream release tag.
4. Run `npm run package:mac`. The builder refuses to replace an existing output folder. `WORKBUDDY_RELEASE_DIR` selects another build output; `WORKBUDDY_NODE` selects the Node binary to embed.
5. Verify the signature, mount and install the DMG into an isolated directory, and exercise first launch before publishing DMG/ZIP plus SHA256SUMS to GitHub Releases.

The runtime sources are public upstream releases. `.release-cache`, installed dependencies, model caches, QA profiles and built applications are ignored in Git.

## Original source preview 0.1.0

Published scope: independently implemented `server/`, `tools/`, `desktop/`, `public/`, workspace assembly, dependency lockfile and tests. The public desktop server defaults to the independent web UI. The local private product tree is preserved separately.

Excluded from Git: original renderer, catalogs except the two explicitly licensed skills, artwork, fonts, extracted vendor code, native original runtime, model weights, virtual environments, node_modules, packaged apps, QA captures, chat databases, user configuration and keys. Installer binaries are distributed as release assets.

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

The original local environment separately passed real Qwen conversation, approval-gated writes and selected skill invocation using DSH. A fresh source clone needs its own model endpoint, optionally a separately built DSH tree, and optional media dependencies/weights. The 0.2.0 desktop installer adds its own optional local model service; the source-only 0.1.0 preview did not bundle one.

## Remaining work

- Expert-team execution and full expert workflows under DSH.
- Full WorkBuddy 5.8.3 compatibility and newer UI/media flows.
- Independent desktop UI feature parity, Windows/Intel Mac packaging and Apple notarization.

The project does not include official account, subscription, WeChat or cloud-marketplace services.
