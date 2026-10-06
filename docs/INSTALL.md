# Installing Undertone

Undertone runs on macOS 14 or later and on Windows 10 and 11. The builds aren't signed with an Apple or Microsoft developer certificate yet, so both systems warn you the first time you open Undertone. This page shows how to get past that warning. You only do it once for each version you download.

## Download

Released versions will be on [GitHub Releases](https://github.com/sussyswimmer/lyricsync/releases). Open the latest release and look under **Assets**:

- **macOS:** `Undertone_<version>_universal.dmg`. One build covers Apple silicon and Intel Macs. (The `.app.tar.gz` next to it is the same app without the disk image; you don't need it.)
- **Windows:** `Undertone_<version>_x64-setup.exe`.

**Test builds:** nothing is released yet, so for now this is how to get Undertone. Every push to the repository builds both installers. Open the **Actions** tab, click a **CI** run, and download the `.dmg` or the `-setup.exe` from **Artifacts** at the bottom of the run's summary. You need to be signed in to GitHub, and test builds are deleted after 14 days. The steps below are the same for them.

## macOS

### Install

1. Open the `.dmg` and drag **Undertone** onto **Applications**.
2. Eject the disk image (the eject button next to it in the Finder sidebar).
3. Open Undertone from Applications. macOS stops it the first time. Follow the steps for your macOS version below.

### First open on macOS 14 (Sonoma)

1. In Applications, Control-click (or right-click) **Undertone** and choose **Open**.
2. In the warning, click **Open**.

### First open on macOS 15 (Sequoia) and later

Control-click → **Open** no longer skips the warning, so you allow Undertone in System Settings instead. This also works on macOS 14.

1. Double-click **Undertone**. macOS says it can't verify that Undertone is free of malware. Click **Done** (not **Move to Trash**).
2. Open **System Settings → Privacy & Security** and scroll down to **Security**. Next to the message that Undertone was blocked, click **Open Anyway**.
3. Click **Open Anyway** in the dialog that follows, then enter your password or use Touch ID.

### If macOS says Undertone "is damaged and can't be opened"

The download isn't broken. macOS marks apps downloaded from the internet as quarantined, and some versions refuse unsigned apps with this message instead of the usual warning. Remove the mark in Terminal:

```sh
xattr -dr com.apple.quarantine /Applications/Undertone.app
```

Then open Undertone again. Only do this for an Undertone you downloaded from this project's Releases or Actions pages.

### Allow Undertone to read Spotify and Music

The first time Undertone reads Spotify or Music, macOS asks whether **Undertone** may control that app, with the reason "Undertone reads what's playing in Spotify and Music to show its lyrics." Click **OK**. Undertone only reads what's playing; it never plays, pauses or skips anything.

- macOS asks once for each player, so you may see the prompt again when you first use the other app.
- Because these builds aren't signed with a developer certificate, macOS may ask again after you install a new version.
- If you clicked **Don't Allow**, see [Permissions](../README.md#macos-automation) in the README to switch it back on.

### Finding Undertone

Undertone has no Dock icon and no window at launch. It shows up as an icon in the menu bar. Start a song in Spotify or Music and the lyrics appear on your desktop. To change how they look, choose **Settings…** from the menu bar icon.

## Windows

### Install

1. Run `Undertone_<version>_x64-setup.exe`. If your browser says the file isn't commonly downloaded, choose to keep it. (In Edge: **…** → **Keep** → **Show more** → **Keep anyway**.)
2. When SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.
3. Follow the installer. It installs Undertone for your user account only, so it doesn't ask for administrator rights.

### WebView2

Undertone draws its lyrics and settings with Microsoft Edge WebView2. Windows 11 and up-to-date Windows 10 already include it. If your PC doesn't have it, the installer downloads it, so stay online while you install. If Undertone still doesn't open, install the **Evergreen Bootstrapper** from [Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/), then start Undertone again.

### Finding Undertone

Start Undertone from the Start menu. It has no taskbar button; it shows up as an icon in the system tray, next to the clock. If you don't see it, click the **^** arrow to show hidden icons, and drag Undertone onto the taskbar to keep it in view. Start a song and the lyrics appear on your desktop.

## Updating

Install the new version over the old one. Your settings, sync nudges and cached lyrics are kept.

- **macOS:** quit Undertone from its menu bar icon, drag the new version into Applications and choose **Replace**. Then do the first-open steps again.
- **Windows:** quit Undertone from its tray icon, then run the new `-setup.exe`. SmartScreen may warn you again.

## Uninstalling

- **macOS:** first turn off **Launch at login** in Undertone's menu, so no login item is left behind. Quit Undertone, then drag it from Applications to the Trash. To remove your settings and cached lyrics too, delete the `~/Library/Application Support/com.undertone.desktop` folder (in Finder, choose **Go → Go to Folder…** and paste the path).
- **Windows:** quit Undertone, then open **Settings → Apps → Installed apps** (**Apps & features** on Windows 10), find Undertone, and choose **Uninstall**. To remove your settings and cached lyrics too, tick **Delete the application data** in the uninstaller.

## Building it yourself

To build the installers from source, set up the tools in the README's [Development](../README.md#development) section and run `pnpm tauri build`. The installers land in `src-tauri/target/release/bundle/`. On macOS, for one build that runs on both kinds of Mac, run `rustup target add aarch64-apple-darwin x86_64-apple-darwin` once, then `pnpm tauri build --target universal-apple-darwin`, and look in `src-tauri/target/universal-apple-darwin/release/bundle/`.
