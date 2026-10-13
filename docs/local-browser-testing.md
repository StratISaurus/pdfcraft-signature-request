# Local browser approval prototype

Status: implemented browser-only experiment; NOT the final PdfCraft desktop integration or production signing service. The friendly-UX pass retains the security/geometry regressions and adds polling lifecycle tests plus real Edge workflow and retry checks. Do not use real client documents.

## Run on this development machine

Node 22+ is required. From the repository folder:

```sh
npm ci
npm test
npm run test:browser
npm run test:ux
npm run test:vault
npm run demo:browser
```

The automated browser test uses installed Microsoft Edge via Playwright. The last command runs the local UI on http://127.0.0.1:8788. Open `.local/open-sender.html` from disk and click its private sender link. Do not send that file or link to recipients: it contains the sender setup capability. The launcher file is gitignored; Windows ACL hardening is not yet verified, so use only a trusted local machine/account. No server is left running by the automated browser test.

## Optional durable local mode

See [durable local relay](durable-local-relay.md) for opt-in configuration, the explicit trusted-account/Windows-ACL boundary and creation-ACK gaps. Defaults are unchanged. `npm run test:restart` exercises an isolated process kill/restart, empty-profile recovery, browser signing and completed download without touching the manual demo.

## Launcher security and regression

An isolated temporary disk launcher is exercised with a `file://` page and a real Edge link click, then the same sender tab completes the encrypted workflow. The production launcher generator remains covered by the Node launcher tests. Before the fix Edge sent `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`, with no Origin, and received 403. After the fix that exact navigation receives 200. Only a GET of the public `/` HTML shell with document-navigation metadata can bypass the cross-site Fetch Metadata check. API routes, scripts, health, frames and cross-site fetches do not receive this exception. Host validation and explicit Origin rejection (including `Origin: null`) remain unconditional; query/body restrictions and no-CORS policy remain intact.

The launcher contains a sender **capability**, not a document decryption key. The browser removes the setup fragment after parsing and may send this capability only in the request-creation Authorization header. Document and response encryption keys must never enter HTTP URLs, headers or bodies. Browser regression checks these boundaries and records only non-secret navigation metadata in `artifacts/browser-result.json`.

**Trusted-machine/account only:** Node's `mode: 0o600` is not proof of a private Windows ACL, and existing files may retain their permissions. Windows ACL hardening is still unverified. Do not use a shared/untrusted account or synced/shared repository folder; do not share the launcher or copy its link to logs/chat. Use synthetic PDFs only. Stop the demo with Ctrl+C to remove the launcher. After an abnormal stop, remove a stale launcher only after confirming that its demo is stopped. Browser tests use `startDemo({port:0,writeLaunch:false})` and a temporary launcher outside the repository. They do not restart, stop or overwrite a running manual demo. Automated tests verify their listener is closed and their temporary launcher is removed.

## Exercise the browser flow

1. In the sender tab, choose **Use sample PDF** (a generated synthetic two-page PDF).
2. Follow Document → People → Fields → Review / share. Enter signer names in colour-coded cards; use Add signer or Remove. Choose Everyone at once or In order. Advanced grouped stages use comma-separated stage numbers in card order (for example 1,1,2).
3. Select each recipient and click a preview page to place their signature rectangle. Keyboard: Tab to a page, Enter/Space to place centrally, arrows to move by 10 PDF points. Click again to move it or use Remove selected field to clear it. Choose Create encrypted request once every recipient has a field. Record the generated 24-word recovery phrase privately, confirm it, then choose Create encrypted request again. Export the encrypted backup and keep the phrase separately offline.
4. Open the generated recipient invitation in another browser tab or session on the SAME computer. Never publish these bearer invitation links. Loopback URLs do not work on a separate phone or computer.
5. Review all rendered pages. Start signing jumps to your field; Enter typed signature focuses the name input. Check the typed-name preview, explicitly consent and return the encrypted approval. The success panel downloads your own approved PDF; it truthfully says other signers’ live status is not known here.
6. Return to the sender tab. It checks every five seconds while visible, decrypting/validating evidence and releasing the next stage. Per-signer status and Copy link controls accompany the invitations. **Check responses** remains a manual fallback. No email/SMS notifications are sent.
7. Complete the remaining recipients, checking responses between stages as needed.
8. Download the completed PDF and evidence JSON. The PDF includes typed signatures at the assigned positions on the original pages and separate approval receipt pages. These are electronic approvals, not certificate-backed signatures.

## Actual capabilities and limits

- PDF.js renders the PDF locally; the client encrypts documents/response packages.
- Invitations are constructed by the sender browser, not by the relay.
- Recipient slots are gated by stage; sender validation advances the workflow.
- A typed name/device time is self-asserted. Anyone with an invitation may act for its slot. Identity verification is not implemented.
- UI limits: synthetic PDF up to 180 KB/10 pages; up to 12 recipients; typed names support Latin printable characters.
- Requests expire after one hour. Restarting the default ephemeral server loses all requests. [Opt-in durable mode](durable-local-relay.md) preserves unexpired records when restarted with the same directory and origin; it must be configured before creation. Closing the sender discards unlocked keys; ciphertext persists locally. Reload the same origin and explicitly unlock with the phrase. On another browser profile, import the encrypted backup and enter its phrase. The original relay must still have the request.
- All recipients approve the same original PDF. The final artifact appends receipts; sequential stages do NOT imply each recipient reviewed a prior recipient's appended receipt.
- One fixed-size typed-signature field per recipient is supported, with click-to-move/remove. No drawing, resizing, multiple fields per recipient, overlap detection, trusted certificates, OTP, hosted durable relay service, automatic notification or desktop integration yet. Rotation/crop/nonzero-origin/UserUnit geometries are rejected rather than placed incorrectly.
- Automatic checking never overlaps manual collection. Hidden tabs stop scheduling; an already-started collection may finish. Completion, revocation or an unavailable/expired request stops polling. Other errors pause until manual retry; retries re-read relay state (including an acceptance whose reply was lost) instead of appending duplicate artifacts. Closing/reloading locks the sender; recovery requires the phrase plus local ciphertext or exported backup.
- Invalid submissions do not yet have a sender rejection/reissue recovery path.
- Keyboard controls, named fields, focus rings and responsive layouts are implemented. The PDF is still a canvas viewer without a screen-reader text layer or zoom controls; do not claim fully accessible document review. Typed-name preview uses a similar sans-serif face, not exact PDF text metrics.
- Preparation is four linked sections, not a modal wizard. One fixed field per signer, no drawing, drag/drop reorder, resizing, multi-field editor or overlap avoidance.
- Hosted browser code remains trusted. This prototype is not a security audit or legal-signature assurance.

## Verification evidence

Run `npm test`, `npm run test:browser`, `npm run test:ux`, `npm run test:routing` and `npm run test:vault` for the current verification. Polling unit tests use a deterministic scheduler; the Edge lifecycle test uses simulated visibility events/browser time and real HTTP encryption/acceptance, including a lost acceptance reply. See `independent-review-regressions.md` for observed failing-before/passing-after cases. Browser test outputs are ignored under `artifacts/`: completed synthetic PDF, evidence JSON and desktop/mobile viewport screenshots. Mobile viewport emulation is not a physical-device test.

Desktop build and integration are tracked separately in the sibling PdfCraft checkout. Do not describe this browser prototype as the complete desktop-to-browser flow.
