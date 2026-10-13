# Routing-intent race and isolated-listener verification

## Routing creation

`npm run test:routing` uses real headless Microsoft Edge and an isolated `startDemo({port:0,writeLaunch:false})`. It holds the creation POST response **after the real server has created the request**, changes routing intent while pending, then releases the response.

Before the fix, the any-order → sequential case failed: `stale invitations must not publish`, actual 2, expected 0. After the fix the mode and grouped `1,1` → `1,2` cases pass. Controls for mode, stages, recipient names/add/remove are frozen while creation is pending. Publication additionally checks document/preview generations and a snapshot of labels, mode, stages and fields, including DOM writes without input/change events. Disabled controls alone are not the integrity guard.

Obsolete successfully created requests are revoked without displaying invitations. A user must explicitly create again; synthetic repeated clicks cannot launch concurrent POSTs. If revocation fails, the request's administration handle is retained and the next explicit attempt must finish cleanup before creating anything new. The cleanup-failure case checks two failed DELETE attempts cause no second POST; a later explicit successful cleanup/retry creates exactly one current request. Each successful retry decrypts the actual invitation and verifies the requested mode and stages `[0,1]`. Server readback verifies stale requests return `not_found`.

Existing document-generation checks and all seven document-selection race tests remain intact. Creation transport failures with an unknown server result remain a separate limitation: this prototype has no creation idempotency-key protocol, so a lost creation acknowledgement may leave an undistributed record until expiry. No automatic POST retries were added.

## Fetch failure investigation

The first routing test execution hit real Edge `net::ERR_UNSAFE_PORT` on an OS-assigned ephemeral port 2049, before reaching the regression. `netsh int ipv4 show dynamicport tcp` reported start 1024, count 64511 on this host. A real relay bound to 2049 reproduced Node 22.23.2 `fetch failed` with nested cause `bad port` from Undici `mainFetch`. This is a client port-policy refusal, not malformed-body parsing or HTTP response truncation.

A bounded pre-fix stress run of 1,200 fresh ephemeral relay listeners/health fetches had zero failures; one ordinary pre-fix full suite passed 35/35. Thus the original reviewer failures at relay.test creation/body-budget calls cannot be conclusively attributed from their generic `fetch failed` alone. The observed unsafe allocation is fixed, but this is not proof that every historical flake had that cause. Relay test errors now include the allocated port and nested cause (without secrets) for any recurrence.

Two deterministic real-socket regressions force the first ephemeral allocation to 2049, for both relay and browser service. Both failed before the fix because the unusable URL was published; both pass after it. `listenLoopback` now excludes Fetch's bad-port table before returning a URL, rejects explicitly requested blocked ports, removes temporary error listeners, and bounds allocation attempts to 16. Only an unusable **listener allocation** is discarded; no HTTP request or failed assertion is retried. No machine port-range settings were changed.

## Verification

- Five consecutive independent `npm test` runs: **37/37 passed each**, no retries of failed tests. Logs: ignored `artifacts/routing-full-suite-1.log` through `routing-full-suite-5.log`.
- `npm run test:routing`: mode, grouped stages and failed-cleanup/explicit-retry cases passed; listener closure verified.
- `npm run test:ux`: clipboard, auto/manual collection lock, visibility pause, error stop/manual retry, lost acceptance ACK, terminal stop passed. Time/visibility are browser-hook simulations, not physical window tests.
- `npm run test:browser`: all seven selection races plus encrypted two-recipient workflow, PDF rendering/finalisation and key-leak checks passed; listener/private temporary launcher cleanup verified.

No live 8788 listener, existing `.local` launcher, desktop source, commits, pushes or deployment were changed. Browser evidence regenerates only the existing ignored `artifacts/` outputs and an OS-temporary launcher.
