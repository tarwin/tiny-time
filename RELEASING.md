# Releasing

Tiny Time ships for macOS (Apple Silicon and Intel), Windows (x86_64) and
Linux (x86_64 and arm64). Windows and Linux are built by CI; the Macs are
built here because they have to be signed and notarized.

Platform differences, all handled in the app:

- **macOS:** the two-zone pill in the menu bar (▶/‖ starts and stops, the
  time opens the popover). No window and no web view at rest.
- **Windows and Linux:** a square tray icon (accent with ‖ while tracking,
  gray with ▶ when idle), the time in its tooltip, click opens the popover,
  right-click has the menu. On Windows the popover opens above a bottom
  taskbar. Linux doesn't report where the tray icon is, so the popover opens
  in the top-right corner. Shortcuts use Ctrl instead of ⌘.

## Steps

1. Bump `version` in `tinyjs.json`, commit, push to `main`.
2. Run the **release** workflow (Actions → release → Run workflow, or
   `gh workflow run release.yml`). It builds Linux and Windows, smoke-tests
   the Windows exe, and uploads them to a **draft** release `v<version>`.
3. Build, notarize and stage both Macs (needs `TINYJS_SIGN_IDENTITY` and
   `TINYJS_NOTARY_PROFILE`), add them to the draft, write the notes, publish:

   ```sh
   sh scripts/release-mac.sh            # arm64 and x86_64 → release/
   gh release upload v<version> release/tiny-time-<version>-macos-*
   gh release edit v<version> --notes-file notes.md --draft=false
   ```

   The notes show in the app's update banner, on the microsite and in Shelf.
4. Auto-update: `node scripts/release-manifest.mjs`. It hashes the update
   files, uploads `manifest.json` and checks every url. Installed apps read it
   from `releases/latest/download/manifest.json`.
5. Shelf: `node scripts/shelf.mjs`. It copies the release files to a
   `tiny-time-v<version>` release in tinyjsapp-examples (Shelf only downloads
   from there), writes Tiny Time's catalog entry and pushes.
   `../tinyjsapp-examples` must be on `main` and clean. Shelf only installs apps whose id
   starts with `art.tarwin.`.
6. Microsite: apps.tarwin.art/tiny-time picks the release up by itself
   (download buttons per platform, version and notes come from the latest
   GitHub release). For new screenshots: `sh scripts/screenshots.sh` (demo
   data in a temp folder; your own data is left alone), then
   `sh scripts/web-shots.sh`, and commit `tiny-time/shots/` in
   `../tarwin-apps-microsites`.

To build Linux locally instead of in CI (Docker):

```sh
docker run --rm -v $PWD:/src:ro -v $PWD/release:/work -e TINYJS_TAG=v0.70.3 \
  ubuntu:22.04 bash /src/scripts/pkg-linux-container.sh
```

The app icon is `scripts/icon.html`; re-render `assets/icon.png` with
`sh scripts/icon.sh`.
