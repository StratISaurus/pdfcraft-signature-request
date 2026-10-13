# Optional durable local relay (experimental)

The browser demo can now retain encrypted requests and returned approvals through a process restart. Default `startLocalApp()` / `startDemo()` and the original transport relay remain RAM-only. This is not a hosted service, long-term archive, native dashboard, or production security approval.

## Opt-in configuration

Tested on Node 22.23.2 / SQLite 3.51.3 on Windows. Durable mode uses the built-in `node:sqlite` API; Node currently emits its experimental-feature warning. No native addon/build dependency was added. Use the tested Node 22.23.2 or a maintained newer release supporting both `DatabaseSync` and its `isTransaction` property; the package's broad Node >=22 engine declaration alone is not a durable-mode compatibility guarantee.

Programmatic local demo:

```js
const app = await startDemo({
  port: 8790, // an unused, fixed loopback port; keep this origin on restart
  writeLaunch: false, // never overwrite an existing demo's private launcher
  storageDir: 'C:/Users/Josh/AppData/Local/pdfcraft-relay-demo',
  trustedLocalAccount: true,
});
```

`app.launchToken` is the new-process creation capability; keep it private, do not print it or put it in HTTP URLs. Existing request backups do not need this credential. Open the same origin, import the encrypted per-request backup and enter the separate recovery phrase. Restart with the **same absolute storage directory AND same scheme/host/port**. This does not migrate any existing RAM-only requests.

For the normal CLI launcher flow, first ensure **no other manual demo is using the shared `.local/open-sender.html` launcher**. Do not run this over an existing demo/launcher. In Git Bash, for a fresh synthetic-only demo:

```sh
PORT=8790 LOCAL_RELAY_STORAGE_DIR='C:/Users/Josh/AppData/Local/pdfcraft-relay-demo' LOCAL_RELAY_TRUSTED_ACCOUNT=1 npm run demo:browser
```

Unlike the programmatic `writeLaunch:false` example, that CLI command uses the normal private launcher. Repeat the same configuration after stopping that demo. Omit `LOCAL_RELAY_STORAGE_DIR` to retain the old ephemeral default. Invalid/empty supplied paths fail, never silently select ephemeral mode. Relative paths are rejected. The flag is an explicit trust acknowledgement, **not a security hardening operation**.

## Trusted local account, not verified Windows isolation

Use only a non-shared, non-synced local directory controlled by the trusted account, on a trusted machine. This slice **does not set or verify Windows ACLs**; Unix-style Node mode bits are not an owner-only Windows guarantee. The API refuses durable mode without `trustedLocalAccount:true` (CLI equivalent above). Account compromise, a privileged attacker, writable parent directories, backup/sync agents, disk snapshots and local malware are outside the boundary. Directory/file symlinks at the immediate configured paths, including dangling database symlinks, are rejected using `lstat` (only ENOENT means absent); this is not a comprehensive reparse-point/parent-chain defense. No real client documents.

## Stored data and transactional behavior

`relay.sqlite`, schema `PRAGMA user_version=1`, stores opaque request IDs, manifest hashes, absolute expiry timestamps, recipient IDs/stages/waiting-submitted-accepted states, encrypted request/response payloads, and SHA-256 capability hashes. It never stores launch credentials, raw capabilities, phrase, decryption/response keys, names, PDF bytes or final plaintext artifacts. Payloads are client-produced ciphertext; the relay checks envelope structure, not whether an authorized caller actually encrypted arbitrary bytes. Backups remain separately encrypted in the browser/export, not this database.

Each whole-record insert/update/delete uses an explicit SQLite transaction with `synchronous=FULL` and rollback journal mode `DELETE`. Exactly one affected row is required before COMMIT; only a successful commit permits RAM state publication and HTTP acknowledgement. Zero-row/ignored writes return 503 and roll back, including any trigger side effects, leaving old RAM and database state in place. Deleting an ID absent from the internal map remains a false/no-op (HTTP already rejects missing requests). An exclusive connection lock refuses simultaneous relay instances for one directory (no multi-process RAM mirrors). Normal close releases the lock; process death lets SQLite recover its journal. No hand-written rename/double-file protocol or raw-token replay cache.

Strict record decoding, version and exact schema checks fail closed on malformed/unknown data. Version 1 accepts only the canonical `CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT NOT NULL)` definition and its SQLite-owned primary-key autoindex. The complete `sqlite_schema` inventory, `table_xinfo`, `index_list` and `index_xinfo` are checked, including the autoindex's null SQL, ownership, uniqueness, PK origin, columns and binary collation. Extra triggers/views/tables/indexes, extra/generated columns and altered constraints are rejected before loading records. Even semantically equivalent hand-rewritten DDL and analysis/statistics tables are unsupported; there is no automatic schema normalization or migration. Database quick-check and truncated/header/empty-file guards refuse corrupted stores; they are not silently reset or overwritten. No repair or migration tool is included: keep the stopped database and journal together for investigation, and do not promise recovery from corruption, disk loss or malicious rollback.

Limits: 20 live requests; 32 MiB of serialized durable record data, including hashes and responses; 4 MiB HTTP request bodies; at most 12 recipients each. Tests can lower `startLocalApp({maxStorageBytes})`. A SQLite page-count ceiling additionally bounds database growth to 64 MiB, calculated from the actual `page_size` (16,384 pages at the default 4 KiB). Tests verify 512-byte, 4-KiB and 64-KiB page sizes. This physical ceiling is separate from the configurable serialized-data quota; rollback journals require additional disk space. Store-load count/byte/file-size guards apply before decoding rows. This synchronous bounded local implementation can block the event loop and is not suitable for a public/high-volume service.

Expiry is unchanged: one hour by default, never extended on restart. Expired records are deleted at startup and on subsequent allowed requests, **not by an idle background timer or while the process is stopped**. Revocation commits deletion before returning 204. `secure_delete=ON` clears deleted SQLite page contents; journal cleanup is tested. This is logical removal with best-effort SQLite page clearing, not guaranteed forensic erasure from SSDs, filesystem journals, snapshots, backups or copies already downloaded. Final plaintext PDFs are downloaded by the browser, never cached by the relay.

Schema validation assumes the exclusive owning connection and trusted local filesystem boundary. It does not authenticate database contents, prevent an account-level attacker from rewriting valid records/rolling back the whole database, or eliminate filesystem check/open races. Fault tests capture the owning SQLite connection through a test-only prototype spy and inject triggers **after** normal schema validation, removing them before restart; production has no schema-validation bypass or injection option.

## Remaining acknowledgement/recovery gaps

**Creation is NOT idempotent.** If the server commits a creation but the HTTP reply is lost, the server-generated ID/admin token may never reach the browser; retry can create another bounded orphan until expiry. A crash after creation acknowledgement but before browser vault save/export can likewise leave an unrecoverable request. This slice does not persist plaintext admin tokens or invent an unversioned deduplication key to bridge those windows. Recovery is claimed only for successfully created requests whose encrypted sender state was saved/backed up and whose phrase is available.

An encrypted backup does not archive returned approvals. Recovery still requires the intact durable relay record at its original origin, before expiry and without revocation. Submission replay remains 409; sender acceptance retries re-read authoritative accepted state, rather than pretending every POST has an idempotent success reply. SQLite durability depends on correct OS/filesystem/device behavior; process-kill testing is not a physical power-loss guarantee.

## Verification

`npm run test:restart` runs real HTTP stop/reopen checks for staged submissions/acceptances, role-scoped hashed auth and replay; expiry/revocation deletion; corrupt/header/truncated/empty database refusal; unknown schema/extra metadata refusal; quotas; explicit trust/single-writer gates; failed-write atomicity; and a real child process killed with an open spilled SQLite transaction, followed by journal rollback.

The Edge integration test creates a real encrypted request and exports its encrypted backup, kills only its isolated child relay, starts a new process with the same storage and port, restores in an empty browser profile with phrase plus backup, signs through the browser, persists acceptance, kills/restarts again, restores and downloads the completed three-page synthetic PDF. The stopped relay directory is scanned for raw/encoded capabilities and keys, the phrase, signer name, PDF header, and exact returned PDF bytes. No recovery screenshots/traces or secret values are logged. This test never uses port 8788 or the user's existing launcher, and removes its own temporary directory/processes.

Schema/ACK hardening was verified with failing-before-fix regressions for schema drift and ignored creation/submission/acceptance/deletion, including rollback of pre-IGNORE side effects. `npm test`: 74 passed, 1 skipped; durable subset: 33 passed, 1 skipped; isolated restart browser integration plus vault/browser/UX/routing suites passed. The real file-symlink test is explicitly skipped on this Windows account because symlink creation returns EPERM; the deterministic lstat dangling-entry regression passes, but is not a real Windows file-symlink test. Node emits its expected experimental SQLite warning.

Run `npm test`, `npm run test:browser`, `npm run test:ux`, `npm run test:routing`, `npm run test:vault`, and `npm run test:restart`. Initial RED checks observed missing restart data (404), unsupported schema accepted, invalid opt-in silently ephemeral, and browser recovery hidden after real restart before demo wiring. Existing browser encryption/leak/routing/lifecycle tests remain separate regression gates.
