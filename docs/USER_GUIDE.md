# Undertone user guide

Undertone draws the lyrics of the song you're playing on your desktop, above the wallpaper and below your icons and windows. You can't click the lyrics: clicks go through to the desktop, and any window you open covers them.

To change how they look, open **Settings…** from the Undertone icon in the menu bar (macOS) or system tray (Windows), or open Undertone again while it's running. Every change applies right away and is saved.

The top of the settings window is a **live preview**: a small copy of your desktop playing the current song with your settings. When nothing is playing, it plays a short demo song (marked **Demo**). To stay readable, lyrics in the preview are drawn larger, relative to its small screen, than they are on your desktop. Height and curve match what you'll see.

On a Mac, macOS asks whether Undertone may read Spotify and Music (the Automation permission). If that's turned off for an app that's open, a notice under the preview says so, for example "Undertone can't see what Spotify is playing.", and tells you where to turn it on: **System Settings › Privacy & Security › Automation › Undertone**, then switch on **Spotify** (or **Music**). Within about 5 seconds the notice goes away and the lyrics come back, with no restart. The README's [macOS: Automation](../README.md#macos-automation) section has more, including what to do if Undertone is missing from that list.

## Contents

- [Style](#style)
- [Color](#color)
- [Font](#font)
- [Layout](#layout): Size, Curve, Height, Glow, Opacity
- [Behavior](#behavior): Show lyrics, Show on
- [Sync](#sync): All songs, This song
- [Reset to defaults](#reset-to-defaults)
- [Menu and shortcuts](#menu-and-shortcuts)
- [Loading, missing and unsynced lyrics](#loading-missing-and-unsynced-lyrics)
- [Song changes, pauses and breaks](#song-changes-pauses-and-breaks)
- [Reduced motion](#reduced-motion)

## Style

Four ways to lay out the lyrics. In every style the words of the current line change color as they're sung (see [Color](#color)).

- **Arc** (the default). The current line runs along a gentle curve across the screen in large type. The previous line sits above it and the next line below, about half the size, following the same curve. A neighbor longer than the current line moves a little further out when it's on the outside of the curve (above an arch, below a sag), so its ends don't crowd the current line. When a line ends, it shrinks up into the previous line's place while the next line grows into the middle. The [Curve](#curve) setting controls the bend.
- **Lens.** One line at a time, straight across. The word being sung is magnified, and words further from it get smaller and fainter, as if a magnifying glass were sliding along the line with the voice. The next line waits underneath in small type.
- **Drift.** The song as a list that scrolls up one line at a time. The current line is full size in the middle; up to three lines above and below are smaller, fainter and tilted back in 3D, like the face of a turning drum.
- **Stack.** The same scrolling list as Drift, but flat, like a lyrics sheet. Neighboring lines are smaller and fainter, with no tilt.

Long lines wrap onto more rows in Drift and Stack, and a line that would wrap taller than about half the screen is set smaller. Lens shrinks a long line until it fits the width of the screen. Arc shrinks it too, but only to about half its size (further on a screen narrower than 16:9, such as a portrait one): at a large [Size](#size) on a narrow screen, a very long line runs off both edges. Lower Size if that happens.

You can also switch styles from the menu: **Style ▸ Arc / Lens / Drift / Stack**.

## Color

Each line uses three colors:

| Color | Used for |
|---|---|
| **Lyric** | Words on the current line that haven't been sung yet |
| **Highlight** | Words already sung, and the word being sung right now (which also glows unless Glow is 0, see [Glow](#glow)) |
| **Other lines** | The lines before and after the current one |

### Match album colors

On by default. Undertone looks at the album cover once per song and picks the three colors from it: a light lyric color tinted by the cover's main color, a vivid highlight from the cover, and a muted color for the other lines.

The colors are chosen to stay readable on any wallpaper. The lyric color is always very light, and the highlight is always a bright, saturated mid-tone. Black-and-white or gray covers get a neutral warm white, with the cover's most colorful spot as the highlight, or the default amber if there isn't one.

When a song has no cover art, your own colors are used for that song. The settings window says so under the switch.

Turning **Match album colors** on doesn't change your own colors: turn it off again and your three colors come back. Editing a swatch while it's on is different (see below).

### Your own colors

Click a swatch to pick a color. Changing any color turns **Match album colors** off and saves all three colors as your own, starting from the colors on screen. So if album colors are showing and you only change the highlight, the lyric and other-lines colors become the album's, replacing the ones you had saved.

The defaults are a warm white lyric (`#F1ECE3`), an amber highlight (`#F2A65A`) and a cool gray for other lines (`#8D93A0`).

## Font

Each font in the list is shown in its own face. All of them are built into Undertone, so they work offline.

| Font | Look |
|---|---|
| **Fraunces** (default) | A soft, bold serif |
| **Instrument Serif** | A slim, condensed serif |
| **Syne** | A wide, heavy sans |
| **Unbounded** | A wide, rounded sans |
| **Bricolage** | Bricolage Grotesque, a compact grotesque sans |
| **Caveat** | Handwriting |
| **JetBrains Mono** | Monospace |
| **System** | Your computer's own interface font |

Each font comes in one weight, which Undertone picks for you. Characters a font doesn't have, such as Chinese, Japanese or Korean, are drawn with your system's fonts.

For Vietnamese, pick Fraunces, Unbounded, Bricolage, JetBrains Mono or System. Instrument Serif, Syne and Caveat have no Vietnamese accented letters, so those letters come from a system font and look different from the rest of the word.

## Layout

### Size

How big the current line is, from 22 to 140 (default 58). Neighboring lines are drawn smaller in proportion.

Size is relative to your screen's height, not a fixed number of pixels. 58 means 58 pixels on a screen 1080 pixels tall (as your system scales it), and the same share of the screen on any other display. The lyrics look the same on a 13-inch laptop and a 27-inch monitor. With [Show on: All displays](#show-on), each screen scales them to its own height.

### Curve

How much the Arc style bends, from −100 to +100 (default +38). It only applies to Arc; in other styles the slider is grayed out and marked "Arc only".

- **0** is a straight line.
- **Positive** values arch the line: the middle rises and the ends drop.
- **Negative** values sag it: the middle dips and the ends rise.

The bend is split evenly around the [Height](#height): the middle moves one way as far as the ends move the other. Near the top or bottom of the screen, the current line moves in just far enough to keep its whole curve on screen, and a curve too deep for the screen gets flatter instead of being cut off. A tall (portrait) screen gets the same shape as a wide one.

### Height

Where the current line sits on the screen, from 0% (top) to 100% (bottom). The default, 46%, is just above the middle. The current line is centered on this height; neighboring lines sit around it.

At 0% and 100% the current line still stays whole on screen, a little way in from the edge. The lines around it can run off the edge there. In Arc, a strong [Curve](#curve) moves the current line a little further in.

### Glow

How soft and bright the lyrics' glow is, from 0 to 100 (default 40).

Every word always has a soft dark shadow so light text stays readable on a bright wallpaper. At 0 that shadow is subtle. Higher values make it wider and softer, and add a halo in the highlight color around the word being sung.

### Opacity

How see-through the lyrics are, from 20% to 100% (default 100%). It applies to everything Undertone draws, including the "No lyrics for this song" note.

## Behavior

### Show lyrics

- **While playing** (default): lyrics show only while a song is playing. They fade out when you pause and come back when you press play.
- **Always**: lyrics stay on screen while paused, stopped where the song stopped.

When no song is loaded in your player at all, nothing shows either way.

You can also hide the lyrics completely with **Show/Hide lyrics** in the menu, or ⌘⌥⇧L (Ctrl+Alt+Shift+L on Windows).

### Show on

Which screens show lyrics.

- **Primary display** (default): only your main display. On macOS that's the one with the menu bar (System Settings → Displays). On Windows it's the one marked "Make this my main display" (Settings → System → Display).
- **All displays**: every connected screen shows the lyrics, each scaled to its own height.

## Sync

Lyrics are timed by whoever submitted them to LRCLIB, and your audio setup can add its own delay. Sync lets you line them up with what you hear. **Positive values show lyrics earlier; negative values show them later.**

A quick way to judge it: pick a line that starts with a clear word and watch when it lights up. If it lights up before you hear it, move toward **Later**. If it lights up after, move toward **Earlier**.

Judge by the first word of a line, because line starts are always real timestamps. The words inside a line are exact only when the lyrics time every word. Otherwise Undertone estimates them (see [Loading, missing and unsynced lyrics](#loading-missing-and-unsynced-lyrics)), so a word mid-line can run a little ahead of or behind the singer even when the line itself is in sync. No offset fixes that.

### All songs

The global offset, from −2000 to +2000 ms in 10 ms steps (default 0). Use it when every song is off by about the same amount, for example with Bluetooth headphones, which delay the sound. When it isn't 0, a button next to the slider sets it back.

### This song

A nudge for the song playing now, on top of **All songs**. The buttons move it −100, −50, +50 or +100 ms, and the current value shows at the right of **This song**, above the song's name. Undertone remembers the nudge for that song and applies it every time the song plays. A song's nudge can go up to 2000 ms either way.

**Reset this song** sets the nudge back to 0.

The buttons are grayed out when nothing is playing. If Undertone finds no music app open at all (Spotify or Music on a Mac; on Windows, any app in the Windows media controls), the song's name is replaced by **No music app open**. Between two songs the last song stays for a moment, so it doesn't flicker.

You can nudge without opening Settings:

- Menu: **Sync ▸ Earlier 100 ms**, **Sync ▸ Later 100 ms**, **Sync ▸ Reset for this song**.
- Shortcuts: ⌘⌥⇧] for 50 ms earlier and ⌘⌥⇧[ for 50 ms later (Ctrl+Alt+Shift+] and Ctrl+Alt+Shift+[ on Windows).

## Reset to defaults

At the bottom of the settings window. Click **Reset to defaults…**, then **Reset** to confirm, or **Cancel** (or press Esc) to keep your settings.

Reset puts the style, colors, font, layout, behavior and the **All songs** sync back to how Undertone started. Per-song nudges are kept unless you tick **Also clear sync for N songs**, which appears when any song has a nudge.

## Menu and shortcuts

The Undertone icon in the menu bar (macOS) or system tray (Windows) has:

| Item | What it does |
|---|---|
| **Show/Hide lyrics** | Hides the lyrics or brings them back |
| **Style ▸** Arc / Lens / Drift / Stack | Switches the style |
| **Sync ▸** Earlier 100 ms / Later 100 ms / Reset for this song | Nudges this song's sync (see [This song](#this-song)) |
| **Refetch lyrics** | Looks the current song up on LRCLIB again, skipping Undertone's saved copy |
| **Settings…** | Opens the settings window |
| **Launch at login** | Starts Undertone when you log in |
| **Quit Undertone** | Quits Undertone |

Shortcuts that work from any app:

| macOS | Windows | What it does |
|---|---|---|
| ⌘⌥⇧L | Ctrl+Alt+Shift+L | Show or hide the lyrics |
| ⌘⌥⇧[ | Ctrl+Alt+Shift+[ | Nudge this song 50 ms later |
| ⌘⌥⇧] | Ctrl+Alt+Shift+] | Nudge this song 50 ms earlier |

## Loading, missing and unsynced lyrics

- **Loading.** Nothing for the first 0.6 seconds (lyrics Undertone has seen before usually arrive sooner), then three faint pulsing dots until the lyrics arrive (steady, without the pulse, if you've asked your system to reduce motion).
- **No lyrics found.** A small "No lyrics for this song" note fades in, stays for about 4 seconds, then fades out. Nothing else shows for the rest of the song. **Refetch lyrics** in the menu tries again.
- **Couldn't load.** If the lookup fails (no connection, or LRCLIB doesn't answer), a "Couldn't load lyrics" note appears and fades out the same way. **Refetch lyrics** tries again.
- **Instrumental.** For songs LRCLIB marks as instrumental, a ♪ slowly breathes in and out where the lyrics would be.
- **Plain (unsynced) lyrics.** Some songs only have lyrics without timestamps. Undertone spreads the lines evenly over the length of the song, so a line is on screen roughly while it's sung, but not exactly. There's no word-by-word highlight, and lines change with slower, calmer transitions.
- **Lyrics timed by line only.** Many songs have a timestamp for each line but not for each word. Undertone then estimates when each word is sung from its syllables, holds the last word of a line a little longer the way singers do, and never keeps one word lit for more than 1.6 seconds. Lyrics with a timestamp for every word are followed exactly.

## Song changes, pauses and breaks

- **New song:** the old lyrics fade out over a quarter of a second, then the new song's lyrics fade in.
- **Before the first line:** the first line waits on screen in the lyric color until it starts.
- **Long instrumental breaks:** the line just sung stays up for at most about 2.5 seconds after its last word (less when the lyrics mark where the break starts), then the next line shows, waiting, until it starts.
- **Paused:** the lyrics stop where the song stopped, and Undertone stops animating. With **Show lyrics: While playing** they also fade out until you press play.

## Reduced motion

If you've asked your system to reduce motion (macOS: System Settings → Accessibility → Display → **Reduce motion**; Windows: Settings → Accessibility → Visual effects → **Animation effects** off), Undertone keeps the lyrics still and changes lines with a short crossfade instead:

- **Drift and Stack** keep their layout but don't scroll; the list moves to the next line with a crossfade.
- **Lens** doesn't magnify. The line stays flat, and words still light up as they're sung.
- **Arc** lines don't glide between their places; they crossfade.
- The loading dots fade in once and then stay still instead of pulsing.
- The instrumental **♪** stays still instead of breathing.
- Word colors change instantly instead of fading.
- With **Show lyrics: While playing**, pausing hides the lyrics at once instead of fading them out.

Song changes still fade out and in.
