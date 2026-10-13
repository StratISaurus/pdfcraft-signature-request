# Independent-review blocker regression evidence

Scope: local-only synthetic approval prototype. No commit, push, deployment, native signature claim, or production-readiness claim.

## TDD evidence

1. Added a real browser regression using a synthetic 2600 × 792 PDF. Before the fix, `npm run test:browser` failed with `actual: 'submitted', expected: 'waiting'` after PDF.js rejected the page and a synthetic approval click was dispatched. After the fix, both oversized-first-page (zero canvases) and oversized-second-page (one canvas) cases remain `waiting`, consent stays hidden, and approval stays disabled. A delayed document fetch additionally checks initial hidden/disabled state; an observer checks approval cannot enable before both normal pages render.
2. Added real HTTP chunked-body tests. With TTL 500 ms and the final body chunk delayed 750 ms, submission originally returned 201; revocation during an incomplete body also returned 201. After fixing submission, both tests passed. Added acceptance regressions next: both originally returned 200 after expiry/revoke; after fixing acceptance, all four return 404 with `not_found`. A subsequent authenticated GET also returns 404. Both mutation routes recheck map record identity and expiry after body awaits.
3. Added an 80-character all-W name receipt regression. Before the fix, PDF.js extraction failed `Complete name must survive PDF text extraction`. Wrapping uses font-measured width inside explicit 40-point horizontal margins, including unbroken names. PDF.js now extracts the entire name and every nonempty text item satisfies x >= 40, x + width <= 572, and vertical margin bounds. Browser PDF.js renders the receipt; `artifacts/receipt-wide-name.png` was visually inspected: two name lines, no clipping or overlap.

## Final executed verification

- `npm test`: **26 tests, 26 pass, 0 fail, 0 skipped** (Node v22.23.2).
- `npm run test:browser`: exit 0, headless Microsoft Edge. Actual output:
  `PASS: browser sender -> two gated recipients -> encrypted returns -> downloaded 4-page PDF; failed/partial renders cannot approve; 80-W receipt rendered within margins; document/response keys absent from HTTP URLs, headers and bodies; no page errors.`
- Browser checks cover captured request URLs, complete request headers and bodies, plus API response URLs, headers and bodies, for document and response encryption keys (raw and URL-encoded). Raw traffic/secrets are not written to artifacts.
- `npm run demo`: exit 0; local encryption / HTTP create / authorized fetch / local decryption passed; revoked envelope returned 404.
- `git diff --check`: exit 0. Git reported existing LF-to-CRLF warnings for `.gitignore` and `package.json`, which this blocker fix did not edit.

## Files changed by this blocker fix

- `web/app.js`: review readiness/reset and guarded approval.
- `web/index.html`: consent initially hidden, approval initially disabled.
- `src/local-app.js`: post-await record identity/expiry checks in both mutation routes.
- `src/approval-pdf.js`: font-measured wrapping and receipt margins.
- `test/local-app-race.test.js`: new four-case real chunked HTTP regression suite.
- `test/approval-pdf.test.js`: full-name extraction and measured receipt bounds.
- `scripts/browser-test.js`: failure/partial-render gating, initial readiness, wide-name rendering and stronger key-leak checks.
- `docs/independent-review-regressions.md`: this evidence record.

Generated local artifacts: `artifacts/browser-result.json`, `artifacts/completed-synthetic.pdf`, `artifacts/recipient-desktop.png`, `artifacts/recipient-mobile.png`, `artifacts/sender-complete.png`, and new `artifacts/receipt-wide-name.png`.

Pre-existing uncommitted prototype work was preserved. These regressions address the specified review blockers only; broader architecture and production gates remain unchanged.

## Document-selection race follow-up

- **RED, real headless Edge:** `node scripts/document-selection-races.js` failed both delayed `File.arrayBuffer` upload → sample → preview/place → release, and two uploads released newest-first. Decrypting the actual created invitation yielded **1 page instead of the selected 2 pages** in both cases. A second RED pass reproduced a detached old canvas placing a field on the new document (**1 field instead of 0**) and a delayed old preview appending **2 canvases instead of 0** after document replacement.
- **Fix, `web/app.js` only:** advance a document-selection generation before any upload/sample await; invalidate bytes/fields immediately; validate local candidate bytes before atomic publication; discard stale success and failure. Preview generations and document revisions gate rendering, detached-canvas placement, and creation (including synthetic disabled-button clicks). Creation snapshots fields and does not publish a result for a superseded revision. Recipient rendering, expiry, tamper, and encryption logic are unchanged.
- **GREEN:** `npm test` reports **29 passed, 0 failed, 0 skipped**. `npm run test:browser` passes the existing sender/two-recipient/4-page flow and **7 selection race cases**: delayed upload/sample, reordered uploads, replaced-document fields/detached canvas/synthetic create, delayed preview, delayed validation success, delayed validation failure, and delayed sample generation. Standalone `node scripts/document-selection-races.js` also passes all seven. Tests use explicit promise gates, not timing sleeps; created PDFs are fetched/decrypted and independently parsed. During pending validation, preview rejects unpublished bytes and creation stays disabled.
- Full browser checks still pass failed/partial-render approval gating, positioned-field/text bounds, 80-W receipt rendering, and document/response-key absence from HTTP URLs, headers and bodies (including race-created invitations); no page errors or unexpected console errors. `artifacts/browser-result.json` now records the selection case names/count.
- Files touched in this follow-up: `web/app.js`, `scripts/browser-test.js`, new `scripts/document-selection-races.js`, and this document. No desktop edits, commit, push, or deployment.
