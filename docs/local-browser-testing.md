# Local browser approval prototype

Status: implemented browser-only experiment; NOT the final PdfCraft desktop integration or production signing service. Independent regression re-review passed for the local synthetic-only scope (26 Node tests and the browser end-to-end test). Do not use real client documents.

## Run on this development machine

Node 22+ is required. From the repository folder:

```sh
npm ci
npm test
npm run test:browser
npm run demo:browser
```

The automated browser test uses installed Microsoft Edge via Playwright. The last command runs the local UI on http://127.0.0.1:8788. Open `.local/open-sender.html` from disk and click its private sender link. Do not send that file or link to recipients: it contains the sender setup capability. The launcher file is gitignored; Windows ACL hardening is not yet verified, so use only a trusted local machine/account. No server is left running by the automated browser test.

## Exercise the browser flow

1. In the sender tab, choose **Use sample PDF** (a generated synthetic two-page PDF).
2. Enter recipient labels, one per line. Choose any order, sequential, or grouped stages. Grouped stages take comma-separated stage numbers corresponding to the recipients.
3. Select each recipient and click a preview page to place their signature rectangle. Click again to move it or use Remove to clear it. Create the encrypted request once every recipient has a field. Keep this tab open: there is no persisted local vault/recovery yet.
4. Open the generated recipient invitation in another browser tab or session on the SAME computer. Never publish these bearer invitation links. Loopback URLs do not work on a separate phone or computer.
5. Review all rendered pages. Enter a test name and explicitly consent; submit the encrypted approval.
6. Return to the sender and choose **Check responses**. This decrypts and validates responses and releases the next stage. No automatic email/SMS notifications exist.
7. Complete the remaining recipients, checking responses between stages as needed.
8. Download the completed PDF and evidence JSON. The PDF includes typed signatures at the assigned positions on the original pages and separate approval receipt pages. These are electronic approvals, not certificate-backed signatures.

## Actual capabilities and limits

- PDF.js renders the PDF locally; the client encrypts documents/response packages.
- Invitations are constructed by the sender browser, not by the relay.
- Recipient slots are gated by stage; sender validation advances the workflow.
- A typed name/device time is self-asserted. Anyone with an invitation may act for its slot. Identity verification is not implemented.
- UI limits: synthetic PDF up to 180 KB/10 pages; up to 12 recipients; typed names support Latin printable characters.
- Requests expire after one hour. Restarting the local server loses all requests; closing the sender tab loses its working keys/state.
- All recipients approve the same original PDF. The final artifact appends receipts; sequential stages do NOT imply each recipient reviewed a prior recipient's appended receipt.
- One fixed-size typed-signature field per recipient is supported, with click-to-move/remove. No drawing, resizing, multiple fields per recipient, overlap detection, trusted certificates, OTP, mnemonic backup, durable storage, automatic notification or desktop integration yet. Rotation/crop/nonzero-origin/UserUnit geometries are rejected rather than placed incorrectly.
- Invalid submissions do not yet have a sender rejection/reissue recovery path.
- Hosted browser code remains trusted. This prototype is not a security audit or legal-signature assurance.

## Verification evidence

The regression fix pass reported 26 Node tests, plus browser end-to-end and synthetic relay demo. See `independent-review-regressions.md` for observed failing-before/passing-after cases. Browser test outputs are ignored under `artifacts/`: completed synthetic PDF, evidence JSON and desktop/mobile viewport screenshots. Mobile viewport emulation is not a physical-device test.

Desktop build and integration are tracked separately in the sibling PdfCraft checkout. Do not describe this browser prototype as the complete desktop-to-browser flow.
