# Inventus DMS

Desktop agent for Inventus CRM workstations: system stats, activity monitoring,
softphone and document scanning. Built with Electron for Windows, macOS and Linux.

Installed apps update themselves from this repo's GitHub Releases. They check on
start and every 4 hours. When a new version is out, the Dashboard window and the
tray menu show an **Update** button, which downloads the update, installs it and
restarts the app.

## Downloads

Get the latest version from [Releases](https://github.com/teknospr/inventus-dms/releases/latest):

| System  | File                                    |
|---------|-----------------------------------------|
| Windows | `InventusDMS-<version>-win-x64.exe`     |
| macOS (Apple silicon) | `InventusDMS-<version>-mac-arm64.dmg` |
| macOS (Intel) | `InventusDMS-<version>-mac-x64.dmg` |
| Linux   | `InventusDMS-<version>-linux-x86_64.AppImage` |

On Linux, only the AppImage can update itself.

## Activation

Each workstation activates with the 8-digit license key from Inventus CRM
(Workstation Licenses). The server then gives that workstation its own device
token. The app carries no API key.

## Releasing a new version

1. Change `version` in `package.json` (for example `1.2.0`) and commit.
2. Push a matching tag:
   ```bash
   git tag v1.2.0 && git push origin main v1.2.0
   ```
3. The **Release** workflow builds all three systems. It publishes the release
   only when every build succeeds, so installed apps never see a half-finished
   release.

## Mac signing

Mac updates install only when the app is signed and notarized with an Apple
Developer ID. The Mac build needs these repository secrets
(Settings → Secrets and variables → Actions):

| Secret | What it is |
|--------|------------|
| `MAC_CERTIFICATE_P12_BASE64` | The "Developer ID Application" certificate exported from Keychain as .p12, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CERTIFICATE_PASSWORD` | The password set when exporting the .p12 |
| `APPLE_ID` | The Apple ID email of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from account.apple.com |
| `APPLE_TEAM_ID` | The 10-character Team ID from developer.apple.com → Membership |

Without them, the Mac build fails with a list of what's missing, and the release
isn't published.

## Development

```bash
npm ci
npm start
```

Local builds: `npm run build:win`, `npm run build:mac`, `npm run build:linux`
(output in `dist/`).
