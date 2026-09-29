# Settings and artwork validation

Settings credentials are encrypted through Electron safeStorage before database writes. This covers provider API keys, OpenSubtitles credentials, the LAN HMAC secret, and the LAN share code. Linux's `basic_text` backend is rejected.

Migration stops if encryption or decryption fails. Invalid JSON, invalid saved credentials, and conflicting plaintext and encrypted values also stop migration. Those failures do not initialize defaults or replace saved LAN secrets. Database migration runs in a transaction. Partial settings saves retain omitted credentials.

The legacy `settings.json` file is retained. Historical backups and SQLite remnants, including old pages and WAL content, are not retroactively encrypted. This change does not rewrite, vacuum, or delete them. Successful migration protects the current settings record, but it does not remove earlier plaintext copies. Any cleanup requires a separate user decision. Encrypted database copies may require the original operating system secret store to recover their credentials.

Local artwork files must be nonempty and no larger than 16 MiB before reading. Structural checks validate MIME signatures and dimensions before browser decoding. JPEG header scanning stops at 64 KiB. Container scanning has a 4,096-record limit. Postdecode checks separately enforce 8,192 pixels per side and 25 million total pixels.

Local PNG, JPEG, static GIF, static WebP, and uncompressed 24-bit or 32-bit BMP inputs are supported within those checks. Local AVIF and animated artwork are rejected. Convert those images to PNG or JPEG first. Structural validation does not validate compressed pixels or provide a decoder sandbox.

Stored artwork accepts bounded image data URLs and absolute HTTP or HTTPS URLs without embedded credentials. Provider and loopback artwork URLs remain supported. URL syntax validation does not replace the host's network authorization or fetch limits.

Imports accept thumbnail, poster, cover, and logo targets, up to 512 rows and 64 MiB of artwork values. The repository validates the complete import before its transaction writes any records. Empty values on supported targets are skipped and count toward the row limit.

Changing media, choosing another local file, or closing the editor cancels pending file preparation and suppresses stale results. Metadata operations also check whether their selection is still current after awaiting work. These checks cannot undo a database write or external callback that already started.

Regression coverage lives in `apps/desktop/tests/secureSettings.test.ts` and `apps/desktop/tests/artworkInputValidation.test.ts`, with repository coverage in the existing database test files. These tests do not exercise the operating system keychain, browser image decoder, or graphical interface.
