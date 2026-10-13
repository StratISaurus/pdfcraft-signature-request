# PdfCraft signature request — experimental local relay

Local browser electronic-approval prototype plus the original transport experiment. Node.js >=22. Run `npm ci` to install pinned dependencies (PDF.js, pdf-lib and browser-test tooling). Not a production signing product.

## Browser prototype

Run `npm run demo:browser`, open `.local/open-sender.html`, and follow its private sender link. Use the sample PDF and keep the sender tab open. **Trusted local machine/account only:** the secret-bearing launcher's Windows ACL is not hardened/verified. See [local browser testing](docs/local-browser-testing.md) for the complete workflow and limitations. `npm run test:browser` exercises an isolated temporary file-launcher click and encrypted workflow using installed Microsoft Edge. It uses an ephemeral listener and never touches the live demo launcher. `npm run test:ux` verifies polling/retry and clipboard behavior.

Supports local PDF review, typed approval receipts, encrypted returns, and any-order/sequential/grouped recipients. Supports one fixed-size positioned typed-signature field per recipient on supported unrotated/uncropped pages; no verified identities or trusted PDF certificates. See [field limitations](docs/positioned-signature-fields.md).

The API below describes the separate original transport service (`npm start`), not the browser prototype service (`npm run demo:browser`).

## Run

```sh
npm test
npm run demo
```

The demo starts an ephemeral loopback HTTP server, locally encrypts generated synthetic bytes, uploads ciphertext, fetches it using a read capability, decrypts locally, and revokes access. It does not create or sign a PDF. It does not print keys, capabilities or plaintext.

For a standalone listener using Git Bash, generate a temporary bootstrap credential without printing it:

```sh
export RELAY_BOOTSTRAP_TOKEN="$(node --input-type=module -e "import {randomBytes} from 'node:crypto'; process.stdout.write(randomBytes(32).toString('base64url'))")"
npm start
```

The listener defaults to http://127.0.0.1:8787. PORT can override the port. Supply the bootstrap credential from the same environment to an authorised client. Do not paste it in chat or source control. Ctrl+C stops the listener. Unset RELAY_BOOTSTRAP_TOKEN in the shell after use.

## Implemented API

Application package version: 0.1.0. Payload protocol: `pdfcraft-relay-experimental-v1`. Routes: `/v1/`. These are distinct version identifiers, and the experimental contract can change before a stable release.

| Method | Route | Credential | Behaviour |
|---|---|---|---|
| GET | /health | none | Returns status and application version |
| POST | /v1/envelopes | bootstrap bearer token | Creates immutable encrypted payload; returns id, readToken, adminToken, expiresAt |
| GET | /v1/envelopes/{id} | read bearer token | Returns payload and expiresAt |
| DELETE | /v1/envelopes/{id} | admin bearer token | Revokes/deletes record; returns 204 |

Creation requires exact `Content-Type: application/json`, no Content-Encoding, and the following structure (placeholders are not usable values):

```json
{
  "payload": {
    "protocol": "pdfcraft-relay-experimental-v1",
    "nonce": "<canonical base64 of 12 bytes>",
    "ciphertext": "<canonical base64 ciphertext including GCM tag>"
  },
  "ttlSeconds": 3600
}
```

Send credentials only as `Authorization: Bearer <capability>`. Query strings are rejected. Creation requires a separate bootstrap credential; read/admin tokens are independently generated. No upload/update/response capability exists yet. The server stores token hashes but necessarily sees presented bearer tokens and generates the initial capabilities. It does not receive the document encryption key.

Client module `src/client-crypto.js` uses WebCrypto AES-256-GCM, fresh keys/nonces, and protocol-string additional authenticated data. `encryptBytes(bytes)` returns `{key,payload}`; keep key local and upload only payload. `decryptBytes(payload,key)` checks protocol and authenticates ciphertext. This is not yet an authenticated signing-envelope protocol: document/recipient/manifest binding and substitution protection between envelopes remain future work.

Limits: 100 live envelopes, 1 MiB request body, 8 MiB total JSON-encoded payload storage; configurable downwards in startRelay. TTL is 1–86400 seconds. Expired records are reclaimed on subsequent requests. All records are RAM-only and lost on restart. The HTTP service binds only to IPv4 loopback, rejects browser Origin headers and unexpected Host headers, sends no CORS permission, and uses no-store responses. This original transport service is separate from the browser prototype’s same-origin local service.

Errors include 400 invalid body/query, 401 invalid/missing capability on an existing resource, 403 Origin/Host restriction, 404 absent/revoked/expired resource, 413 oversized body, 415 unsupported media type, 507 storage capacity. The differing 401/404 statuses are not an envelope-existence privacy guarantee. IDs are random, but authorisation never relies solely on an ID.

## Security and completion boundaries

Experimental local development only. Do not expose through a reverse proxy, bind publicly, or use real client documents. No TLS, durable storage, recipient verification, abuse controls suitable for public service, recovery phrase, encrypted backup or desktop integration is implemented. The browser prototype adds PDF viewing, typed-approval artifact validation and stage routing, not certificate-based signatures. Bounded per-request/storage limits are not a complete concurrent connection or denial-of-service defence.

A correctly implemented relay need not see plaintext, but the hosted signer code is trusted: a malicious host/deployment could capture document keys in the browser. Separate origins and reviewed/reproducible builds reduce but do not eliminate that trust. Full secret-bearing invitation URLs cannot pass through the backend/email provider while claiming those parties never receive decryption secrets. Production key delivery remains a design gate.

See [architecture](docs/architecture.md) for the agreed recovery, stages, protocol-versioning and deployment requirements. This project has not received a security audit and makes no legal-signature or production-security claim.

## Verification

Tests use real ephemeral HTTP listeners and synthetic bytes. They exercise encryption round trip, wrong/missing and cross-role capabilities, expiry, revocation, protocol rejection, ciphertext/nonce/key tampering, body validation, storage limits, Origin/Host restrictions, chunked upload limits and CLI/demo behaviour.

Desktop fork checkout: sibling `pdfcraft`, upstream `storytold/pdfcraft`. No desktop source modifications are part of this slice. Source repository: https://github.com/StratISaurus/pdfcraft-signature-request. No deployment has been performed.
