# Signature requests: architecture and acceptance boundaries

Status: design baseline; NOT implemented capabilities unless tests and release notes say so.

## Repositories

- Desktop: https://github.com/StratISaurus/pdfcraft (fork of storytold/pdfcraft).
- Service and browser signer: pdfcraft-signature-request, initially local. Remote availability/authentication not yet established.
- Keep upstream PDF engine changes small; integrate via engine API and automation as well as desktop UI.
- Separate versioned protocol from product release versions. Breaking versions fail closed; pin shared fixtures and run cross-repository compatibility tests before release.

## Trust model

Documents are encrypted on authorised clients. Relay storage contains ciphertext and operational metadata, never document decryption keys. Hosted browser application integrity is trusted: a malicious host or deployment can steal plaintext/keys. Separate signer and relay origins, reviewed releases, reproducible builds, CSP and no third-party scripts reduce but do not eliminate this risk.

The relay may see IPs, object sizes, timestamps, routing state and verification destinations. Do not market this as metadata anonymity or formal zero-knowledge proofs. No PDF/text/signature/secret logging. No production security or legal validity claim for the experimental prototype.

## Access

Envelope ID is a locator, not authority. Independent random read, response and management capabilities, scoped per recipient, are the target design. Keys and tokens must be distinct. Tokens reach the relay only in redacted Authorization headers; decryption keys stay local. Reject unsupported protocol versions. Expiry/revocation stop future retrieval, not access to downloaded copies.

Optional six-digit recipient verification is an online access gate, NOT a key derivation secret. Destination is sender-controlled. Expiry, bounded attempts, envelope/destination/IP throttles and resend-resistant budgets are required. No codes in logs. Same-email verification proves mailbox access, not legal identity; SMS adds another channel but not definitive identity proof.

## Invitation delivery: unresolved production decision

A relay that constructs and emails a full fragment-bearing decryption link learns the secret. Fragment placement alone does not fix this. First prototype uses sender-distributed invitation links. For ordered flows, distribute encrypted invitations from the sender ahead of time and send key-free activation notifications, or use a separately specified recipient-key mechanism. Do not ship server-generated secret-bearing email links while claiming the relay never sees keys.

## Signing stages

- Any order: recipients eligible together.
- Sequential: one recipient per stage.
- Grouped: multiple recipients per stage, all required completions gate next stage.

Model recipient identity label, assigned fields, stage, verification policy and separate capability scopes. Use idempotent submissions, atomic stage transitions, version-bound response validation and reliable notification outbox semantics. Notifications never establish completion. Decline/cancel/expire are explicit terminal states with clear UX. Routing mutations after invitations require explicit invalidation/reissue rules.

Sequential PDF signatures can append revisions, with each recipient verifying and extending the previous authorised revision. Parallel approvals bind to an immutable original document and manifest; they cannot simply be merged as separately digitally signed PDFs. An authorised client assembles final output and preserves independent evidence. Whether parallel mode promises PDF-native certificates or detached approval evidence must be explicit. Sender offline finalisation and subsequent-revision key distribution require implementation design, not optimistic claims.

## Recovery

Prompt on first signing request, not first ordinary PDF. Client generates standard-format mnemonic using maintained library and CSPRNG. Phrase protects a recovery wrapper around vault key material. Vault protects per-document keys. Printable recovery kit includes phrase, QR equivalent, non-secret vault locator, format version and offline instructions; secret never enters logs/chat/source control. Offer encrypted local export and optional remote ciphertext backup.

Restoration needs both phrase and encrypted backup containing request index and wrapped keys. A phrase cannot reconstruct expired/deleted documents. Confirm backup restoration in tests before labelling recovery ready. Anyone with phrase plus backup can recover access. Rotation cannot revoke old downloaded backups. Do not call offline recovery secrets one-use codes.

## Browser signer

Dedicated mobile-friendly viewer, not full editor. Proposed PDF.js rendering with tested page rotation/crop/scale transforms, accessible field navigation and explicit consent. Locally decrypt, render, collect input, construct authenticated response, encrypt for authorised recipients/sender, submit. PDF rendering and electronic approval are distinct from certificate-based PDF signatures. Reuse PdfCraft WASM signing only after compatibility and security tests.

## Implementation milestones

1. Local-only encrypted relay round trip, bounded resources, token-gated access, expiry/revocation, tamper tests. No real documents.
2. Versioned request manifest and tested recipient/stage state machine, including concurrency and replay rejection.
3. Browser review/field placement/consent using synthetic PDFs; sender preparation client; actual encrypted response round trip.
4. Verification provider adapter and durable storage/outbox with secret-redaction and abuse tests.
5. Vault and recovery phrase/backup round-trip restoration.
6. Desktop engine/UI/automation integration, branding replacement, browser and PDF interoperability tests.
7. Security review, deployment hardening and restricted pilot. Not public production by default.

## Initial environment blockers

Local Node v22 is available. Default Cargo is 1.63 while upstream declares Rust >=1.90, so desktop compilation needs a separately verified suitable toolchain. At initial setup GitHub CLI was unauthenticated and the proposed backend public URL returned 404. These historical GitHub blockers are resolved: the repository now exists, GitHub CLI is authenticated as StratISaurus, and the local origin uses HTTPS authentication. The Rust toolchain prerequisite remains outstanding.
