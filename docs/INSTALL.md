# Installing Undertone

Undertone runs on macOS 14 or later and on Windows 10 and 11. The builds aren't signed with an Apple or Microsoft developer certificate yet, so both systems warn you the first time you open Undertone. This page shows how to get past that warning. You only do it once for each version you download.

## Download

Get the newest version from the [README's download buttons](../README.md) or [GitHub Releases](https://github.com/sussyswimmer/lyricsync/releases). Under a release's **Assets**:

- **macOS:** `Undertone_universal.dmg`. One build covers Apple silicon and Intel Macs. (The `.app.tar.gz` next to it is the same app without the disk image; you don't need it.)
- **Windows:** `Undertone_x64-setup.exe`.

**Test builds:** every push to the repository builds both installers. Open the **Actions** tab, click a **CI** run, and download the `.dmg` or the `-setup.exe` from **Artifacts** at the bottom of the run's summary. You need to be signed in to GitHub, and test builds are deleted after 14 days. The steps below are the same for them.

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
- If you clicked **Don't Allow**, see [macOS: Automation](#macos-automation) below to switch it back on.
- If no prompt appears and no lyrics show, see [Nothing shows up](TROUBLESHOOTING.md#nothing-shows-up).

### Finding Undertone

Undertone has no Dock icon. It shows up as an icon in the menu bar. The first time you open it (and if its saved settings couldn't be read), the settings window opens too; after that it starts without a window. Start a song in Spotify or Music and the lyrics appear on your desktop. To change how they look, choose **Settings…** from the menu bar icon.

## Windows

### Install

1. Run `Undertone_<version>_x64-setup.exe`. If your browser says the file isn't commonly downloaded, choose to keep it. (In Edge: **…** → **Keep** → **Show more** → **Keep anyway**.)
2. When SmartScreen shows "Windows protected your PC", click **More info**, then **Run anyway**.
3. Follow the installer. It installs Undertone for your user account only, so it doesn't ask for administrator rights.

### WebView2

Undertone draws its lyrics and settings with Microsoft Edge WebView2. Windows 11 and up-to-date Windows 10 already include it. If your PC doesn't have it, the installer downloads it, so stay online while you install. If Undertone still doesn't open, install the **Evergreen Bootstrapper** from [Microsoft's WebView2 page](https://developer.microsoft.com/microsoft-edge/webview2/), then start Undertone again.

### Finding Undertone

Start Undertone from the Start menu. The first time, the settings window opens. Undertone has no taskbar button (the settings window gets one while it's open); it shows up as an icon in the system tray, next to the clock. If you don't see it, click the **^** arrow to show hidden icons, and drag Undertone onto the taskbar to keep it in view. Start a song and the lyrics appear on your desktop.

## Permissions

### macOS: Automation

The first time Undertone reads Spotify or Music, macOS asks whether **Undertone** may control **Spotify** (or **Music**). Click **OK**.

- **Why it's needed:** macOS has no public way for an app to see what another app is playing. Undertone asks Spotify and Music directly, through Apple Events, for the title, artist, album, length, position, play state and cover art. It only reads. It never starts, pauses or skips anything, and it checks that the player is already running before asking, so it never launches Spotify or Music by itself.
- **If you click Don't Allow:** Undertone can't see what that app is playing, so you get no lyrics for it. While that app is open, the settings window says so at the top ("Undertone can't see what Spotify is playing.") and names the switch to turn on. Nothing else breaks.
- **To turn it back on:** open **System Settings → Privacy & Security → Automation**, find **Undertone**, and switch on **Spotify** and/or **Music**. Undertone notices within about 10 seconds, without a restart, and the notice in Settings goes away. If Undertone or the player is missing from that list, or switching it on doesn't help, reset Undertone's Automation permission in Terminal with `tccutil reset AppleEvents com.undertone.desktop`, quit and reopen Undertone, and play a song to get the prompt again.

macOS asks once per player, so you may see the prompt a second time when you first use the other app.

### Windows: nothing to grant

Nothing to grant. Undertone reads the system media session, the same information Windows shows in its media controls next to the volume slider. When several apps are playing, it prefers Spotify.

### Network

Undertone sends the title, artist, album and length of the current song to `lrclib.net` to look up lyrics. For Spotify on macOS, it also downloads the cover art from Spotify's image server. Lyrics are cached on your computer so the same song loads instantly next time.

If you set a proxy by hand in your system's network settings, Undertone uses it. A proxy set up automatically (a PAC script or WPAD) isn't supported.

## Updating

Install the new version over the old one. Your settings, sync nudges and cached lyrics are kept.

- **macOS:** quit Undertone from its menu bar icon, drag the new version into Applications and choose **Replace**. Then do the first-open steps again.
- **Windows:** quit Undertone from its tray icon, then run the new `-setup.exe`. SmartScreen may warn you again.

## Uninstalling

- **macOS:** first turn off **Launch at login** in Undertone's menu, so no login item is left behind. Quit Undertone, then drag it from Applications to the Trash. To remove your settings and cached lyrics too, delete the `~/Library/Application Support/com.undertone.desktop` folder, and the log in `~/Library/Logs/com.undertone.desktop` (in Finder, choose **Go → Go to Folder…** and paste the path).
- **Windows:** quit Undertone, then open **Settings → Apps → Installed apps** (**Apps & features** on Windows 10), find Undertone, and choose **Uninstall**. To remove your settings and cached lyrics too, tick **Delete the application data** in the uninstaller. The log is in `%LOCALAPPDATA%\com.undertone.desktop\logs`; delete that folder if the uninstaller leaves it.

## Building it yourself

To build the installers from source, set up the tools in [DEVELOPMENT.md](DEVELOPMENT.md) and run `pnpm tauri build`. The installers land in `src-tauri/target/release/bundle/`. On macOS, for one build that runs on both kinds of Mac, run `rustup target add aarch64-apple-darwin x86_64-apple-darwin` once, then `pnpm tauri build --target universal-apple-darwin`, and look in `src-tauri/target/universal-apple-darwin/release/bundle/`.
