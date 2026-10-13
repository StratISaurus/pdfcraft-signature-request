# Positioned typed-signature slice (local browser only)

This extends the receipt-only browser prototype. It does not complete desktop integration. Synthetic documents only; no deployment, certificate signature, verified identity, OTP, recovery, durable storage, or native desktop handoff is supplied.

## Run

From `C:/Users/Josh/Projects/pdfcraft-signature-request` with Node 22+:

```sh
npm test
npm run test:browser
npm run demo:browser
```

The browser test uses installed Microsoft Edge, starts its own ephemeral loopback server, and closes both browser and server in `finally`. The manual demo command starts the server intentionally: open `.local/open-sender.html` and follow its private sender link. Keep that file/link private and keep the sender tab open. Stop the manual server with Ctrl+C.

1. Use sample PDF, enter recipient labels and select any/sequential/grouped order.
2. Choose **Preview and place fields**. Select **Field recipient**, then click the desired location on the desired rendered PDF page. One 220 × 60 PDF-point rectangle per recipient.
3. Click elsewhere to move the selected recipient's field, including to another page. **Remove selected field** removes it. Changing PDF or recipient labels clears placements; preview again. Create requires a field for every recipient.
4. Create the encrypted request; distribute the private invitation links locally yourself.
5. Recipient reviews all pages, sees only their assigned rectangle, enters a printable Latin name and explicitly consents. Name is embedded in that rectangle on the original page; a separate evidence receipt remains appended.
6. Sender **Check responses** decrypts and reconstructs each artifact from original PDF plus validated evidence before accepting it/releasing the next stage. Download completed PDF and evidence JSON when all have approved.

All recipients approve the SAME ORIGINAL PDF and manifest, including field assignments, regardless of routing order. Sequential/grouped routing does not mean reviewing previous recipients' signatures or receipts. Final output is deterministic for fixed original bytes/manifest/evidence, with appearances and receipts in manifest recipient order; independently returned PDFs are never merged.

## Geometry and bounded scope

- Fields use one-based page numbers, unrotated PDF user-space points, bottom-left x/y, width and height. The browser converts CSS-scaled click positions through the PDF.js viewport to PDF coordinates; overlays invert Y for the supported geometry.
- This bounded slice deliberately REJECTS nonzero page rotation, changed CropBox, nonzero MediaBox origin, and UserUnit other than 1 for assigned pages. It does not implement rotated/cropped transforms. Geometry is checked against the actual original PDF at preparation, invitation opening, and artifact reconstruction. Invalid geometry never produces a misplaced signed artifact.
- Manifest validation rejects unknown recipients, duplicate field IDs/owners, missing owners in a nonempty field set, invalid page numbers, nonfinite/negative coordinates, and undersized rectangles. PDF-aware validation checks actual page count and bounds.
- Optional empty/omitted fields remain supported by the existing receipt-only programmatic API. The browser sender requires one field per recipient. `prepareRequest` / `makeManifest` accept fields as the final optional argument after stages.
- Fixed-size placement only; no resizing, drag handles, multiple fields per recipient, keyboard coordinate editor, drawn signatures, or overlap/content-obstruction detection. Recipients cannot change placement. A long name wraps and reduces font size no lower than 8 points, failing explicitly if an API-supplied field cannot fit it.
- Existing fragment-key, encrypted return, artifact reconstruction, render gating, expiry/revocation, and stage rules remain in force. Hosted client code is still trusted. This is not an independently audited or legally assured signing product.

## Verified evidence

TDD red/green observed for missing deterministic in-page appearances, invalid field ownership/geometry, unreadably shrunken 80-character names, and absent browser placement controls. Final verification: **29 Node tests passing**, plus `npm run test:browser` passing.

Node coverage includes real HTTP any-order/grouped field-bearing responses, deterministic reversed approval composition, tampered manifest binding, returned artifact substitution rejection, bounds/ownership/rotation/crop/origin/UserUnit negatives, and PDF.js text bounds. Existing chunked expiry/revoke and stage tests remain green.

Browser coverage: sender preview/place/move/remove, two sequential recipients, consent refusal when unchecked, assigned field display, complete-render gating (including partial failures), encrypted return validation, final PDF and evidence JSON downloads, independent PDF.js original-page text bounds, receipt rendering, document/response key absence from HTTP URLs/headers/bodies, local-only requests, and zero unexpected page/console errors. Browser coordinate assertions allow less than one PDF point for device-pixel rounding. Mobile is viewport emulation, not physical-device testing.

Ignored `artifacts/` outputs:
- `browser-result.json`
- `approval-evidence.json`
- `completed-synthetic.pdf` (two original pages with appearances plus two receipt pages)
- `sender-fields.png`
- `completed-in-page-signature.png` (actual final page 2 rendered by browser PDF.js)
- `recipient-desktop.png`, `recipient-mobile.png`, `recipient-mobile-field.png` (scrolled to assigned field)
- `sender-complete.png`, `receipt-wide-name.png`

No desktop code or Cargo builds were touched; no commit, push, deployment, or persistent verification server was created.
