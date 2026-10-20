# Undertone user guide

Undertone draws the lyrics of the song you're playing on your desktop, above the wallpaper and below your icons and windows. You can't click the lyrics: clicks go through to the desktop, and any window you open covers them.

To turn them off, change how they look or set up the shortcuts, open **Settings…** from the Undertone icon in the menu bar (macOS) or system tray (Windows), or open Undertone again while it's running. The settings window also opens by itself the first time you start Undertone. Every change applies right away and is saved.

The top of the settings window is a **live preview**: a small copy of your desktop playing the current song with your settings. When nothing is playing, it plays a short demo song (marked **Demo**). To stay readable, lyrics in the preview are drawn larger, relative to its small screen, than they are on your desktop, and sit in the middle of it, as they do on your desktop. Under the preview, **Picked for this song** says which style and font Undertone picked for the song in the preview, and why (see [Look](#look)).

On a Mac, macOS asks whether Undertone may read Spotify and Music (the Automation permission). If that's turned off for an app that's open, a notice under the preview says so, for example "Undertone can't see what Spotify is playing.", and tells you where to turn it on: **System Settings › Privacy & Security › Automation › Undertone**, then switch on **Spotify** (or **Music**). Within about 10 seconds the notice goes away and the lyrics come back, with no restart. [macOS: Automation](INSTALL.md#macos-automation) in the install guide has more, including what to do if Undertone is missing from that list.

## Contents

- [General](#general): Lyrics on the desktop, Launch at login
- [Look](#look): the style and font picked for each song; Text effects, Graphics, Size, Effects, Glow, Opacity
- [Color](#color)
- [Behavior](#behavior): When, Where
- [Sync](#sync): All songs, This song
- [Shortcuts](#shortcuts)
- [Reset to defaults](#reset-to-defaults)
- [Licenses](#licenses)
- [Menu and shortcuts](#menu-and-shortcuts)
- [Loading, missing and unsynced lyrics](#loading-missing-and-unsynced-lyrics)
- [Song changes, pauses and breaks](#song-changes-pauses-and-breaks)
- [Reduced motion](#reduced-motion)

## General

### Lyrics on the desktop

On by default. Switch it off to hide the lyrics on every display. Undertone keeps running in the menu bar or tray, and remembers the choice the next time it starts. The preview at the top keeps playing, marked **Off on the desktop**, so you can still change how the lyrics look. The note under the switch says how to bring them back.

Three things turn the lyrics on and off, and they always agree: this switch, **Hide lyrics** / **Show lyrics** in the menu, and the [Show or hide lyrics shortcut](#shortcuts) (⌥⇧⌘L on a Mac, Ctrl+Alt+Shift+L on Windows, unless you've changed it).

Don't confuse this with [When](#when), which decides whether the lyrics stay up while a song is paused.

### Launch at login

Off by default. Switch it on to start Undertone when you log in. It's the same setting as **Launch at login** in the menu.

Undertone adds itself to the apps your system starts at login. If the system refuses the change, the switch flips back and a note under it says so.

- On Windows it's listed in **Settings › Apps › Startup**. If you turn it off there, this switch follows the next time you open Settings, point at the tray icon, or start Undertone.
- On a Mac it's listed under **Allow in the Background** in **System Settings › General › Login Items & Extensions** (just **Login Items** on macOS 14). This switch follows it: turned off there, the switch shows off the next time you open Settings or point at the menu bar icon. Turning the switch on while Undertone is off there doesn't work: the note appears and System Settings opens at Login Items. Allow Undertone there, and the switch turns on the next time you open Settings or point at the menu bar icon.
- If you move Undertone to another folder, open it once from its new place: it points the login item there, so it keeps starting at login. It leaves the login item alone while it runs from somewhere it won't be at your next login: a disk image, a Mac app still in the folder you downloaded it to (macOS runs it from a temporary copy until you move it), or on Windows an `undertone.exe` opened straight from a zip file.

## Look

Undertone picks how each song looks: its style (one of the nine below) and its font (one of fifteen). There's nothing to choose. It goes by the song itself: how fast and how densely the lyrics are sung, whether notes are held, how much room there is between lines, how often lines come back and whether they're shouted, what they're written in, words in the title such as "Acoustic" or "Club Mix", and the album cover's colors and light. A fast, dense verse becomes a flat list in a sturdy sans, a quick, wordy rap appears word by word as it's said, a slow song with long held notes bends along a curve in a serif, a dance track rides a wave, short shouted hooks are set as a poster in loud capitals, a shouted rock song is cut out like a collage, and a sparse, slow song drifts back in 3D. Where several one-line styles would suit a song (Arc, Lens, Poster, Spotlight, Wave, Reveal and Collage), each song settles on one of them, so songs alike don't all look the same. Undertone doesn't hear the music, so it judges by the lyrics and their timing, not by the genre.

The same song always gets the same look, on every display and in the preview. The look is picked as the song's lyrics arrive. If its cover art arrives later, or synced lyrics replace plain ones, the look may change once, at a line change or a break, never in the middle of a line.

The settings in the window's **Look** group, below, turn each song's own motion and its graphics on or off ([Text effects](#text-effects) and [Graphics](#graphics)) and change how big the lyrics are and how much they move and glow, whatever the look.

### Picked for this song

Under the preview, a card names the look of the song in the preview, such as **Lens · Syne** (the font's name in that font), and says in a few words why, for example "Big repeating hooks, bright warm cover." With nothing playing, it shows the demo song's look. It says **Finding lyrics…** while Undertone looks the song up, and **No lyrics for this song**, **Couldn't load lyrics** or **Instrumental** when there's nothing to pick a look by. Screen readers read the card out when the song changes.

### The nine styles

In every style the words of the current line change color as they're sung (see [Color](#color)).

- **Arc.** The current line runs along a gentle curve across the screen in large type. The previous line sits above it and the next line below, about half the size, following the same curve. A neighbor longer than the current line moves a little further out when it's on the outside of the curve (above an arch, below a sag), so its ends don't crowd the current line. When a line ends, it shrinks up into the previous line's place while the next line grows into the middle. Undertone picks the bend for each song, always gentle: a little deeper for slow songs with held notes, flatter for long lines, arching for anthems and bright covers, dipping for intimate songs.
- **Lens.** One line at a time, straight across. The word being sung is magnified, and words further from it get smaller and fainter, as if a magnifying glass were sliding along the line with the voice. The next line waits underneath in small type.
- **Drift.** The song as a list that scrolls up one line at a time. The current line is full size in the middle; up to three lines above and below are smaller, fainter and tilted back in 3D, like the face of a turning drum. A jump of more than three lines, such as a seek, crossfades instead of scrolling.
- **Stack.** The same scrolling list as Drift, but flat, like a lyrics sheet. Neighboring lines are a little smaller and fainter, with no tilt. Long jumps crossfade, as in Drift. Plain lyrics without timing are always shown this way.
- **Poster.** One line at a time, set like a gig poster: broken into two to five rows, each short row set larger until it's as wide as the widest, so the short words get big. Every line is composed its own way: centered, pushed left or right, some tilted a few degrees. Words not sung yet wait dim and a little small, and punch up to full as the voice reaches them. The next line waits underneath in small type.
- **Spotlight.** One line at a time, sliding through the middle of the screen with the voice: the word being sung is large in the middle, and the words before and after it fall away smaller and fainter to either side. The next line waits underneath in small type.
- **Wave.** One line at a time, riding a wave whose crest follows the voice: the word being sung rides up on the crest, a little larger, and the words beside it tilt along the slopes. Picked for dance, electronic and upbeat songs. The next line waits underneath in small type.
- **Reveal.** One line at a time, appearing as it's sung: the words not reached yet wait as faint ghosts, a little low, and each comes up into its place as the voice reaches it. Picked for rap, spoken and story songs, fast and wordy, timed word by word. The next line waits underneath in small type.
- **Collage.** One line at a time, as words cut out of different magazines: each word its own size and tilt, a little off its row, in one to three rows. Words not sung yet wait dim, and pop as they're sung. Picked for rock, punk and shouted songs. The next line waits underneath in small type.

The current line comes alive as it's sung: each word fills with the highlight color behind a soft edge, syllable by syllable, and rises and swells a little; its letters hop as the color reaches them, and the word glows (see [Glow](#glow)). Most songs' lyrics are timed by line, not by word: then Undertone works out when each word is sung, at the pace the song is being sung (see [Lyrics timed by line only](#loading-missing-and-unsynced-lyrics)). A word held for a second or more lights letter by letter, each letter rising and glowing until the note ends. How much all this moves depends on the song (a fast song moves more and settles quickly, a ballad floats) and on [Effects](#effects). Lines further from the current one are fainter and softer.

Long lines wrap onto more rows in Drift and Stack, and a line that would wrap taller than about half the screen is set smaller. Lens, Wave and Reveal shrink a long line until it fits the width of the screen, Poster and Collage until their block fits, and Spotlight until its largest word does. Arc shrinks a line until it fits its curve, so the whole line stays on screen at any [Size](#size). Undertone doesn't pick Arc, Lens, Poster, Wave or Collage for a song with very long lines.

### Fonts

Undertone picks one of fifteen fonts built into it, so they work offline. Each suits a kind of song, and Undertone reaches for it where the song has that vibe:

| Font | Look | Picked for |
|---|---|---|
| **Fraunces** | A soft, bold serif | Unhurried songs about people; the house font |
| **Instrument Serif** | A slim, condensed serif | Intimate, sparse songs and held notes |
| **Playfair** | Playfair Display, a high-contrast display serif | Soul, R&B and torch songs under rich, dark covers |
| **Syne** | A wide, heavy sans | Bright, quirky pop with hooks |
| **Unbounded** | A wide, rounded sans | Chants, shouted short lines, club mixes |
| **Anton** | Tall, condensed capitals | Anthems, rap hooks and shouted songs |
| **Bricolage** | Bricolage Grotesque, a compact grotesque sans | Fast, dense verses |
| **Space Grotesk** | A clean, techy grotesque | Synth-pop, house and electronic songs, cool covers |
| **Righteous** | A retro, rounded display font | Disco and funk, warm, saturated covers |
| **Rubik** | A friendly, rounded sans | Bubbly pop under bright, light covers |
| **Pacifico** | A brush script | Summer, reggae and feel-good songs at an easy pace |
| **Caveat** | Handwriting | Diary songs and acoustic takes |
| **Pirata One** | Blackletter | Dark, heavy, shouted songs with short lines |
| **JetBrains Mono** | Monospace | Cold neon covers, a steady electronic pulse |
| **System** | Your computer's own interface font | Scripts the others don't have |

It never picks a font that lacks the song's letters: Vietnamese, Cyrillic or Greek lyrics only get fonts that have them, and right-to-left and other scripts get the system font. Wide fonts aren't picked for long lines, and the scripts (Pacifico, Caveat) and blackletter aren't picked for fast or long ones. In Syne, Unbounded or Anton, shouted lyrics may be set in capitals.

Each font comes in one weight. Characters a font doesn't have, such as Chinese, Japanese or Korean, are drawn with your system's fonts. Undertone reads each song's lyrics once to tell whether they're Japanese, Chinese (Simplified or Traditional) or Korean, and draws them in that language's own system fonts, serif or sans to match the font: on a Mac, for example, Hiragino for Japanese and Songti or PingFang for Chinese; on Windows, Yu Mincho or Yu Gothic for Japanese and Microsoft YaHei for Simplified Chinese. So Japanese lyrics never show the Chinese forms of the characters the two languages share.

### Text effects

On by default. Each song's words move their own way. Not every song's words float up: depending on how the song is sung, its words **rise** and settle, **bounce** off the line, **sway** side to side, send a **wave** through their letters, **pulse** on the beat, or **drop** into place from just above. The lines a song repeats, such as its chorus, move a second way, so the chorus stands apart from the verses. Fast, punchy songs bounce and pulse; slow, intimate ones sway; songs with long held notes wave.

Switch it off for the calm, even look: every song's words rise the same way. It doesn't change [Graphics](#graphics). **Effects ▸ Text effects** in the menu does the same.

### Graphics

On by default. Scenes, pictures and splashes join the lyrics:

- **Words that become what they say.** A word of fire, light or weather doesn't call a picture, it becomes it, drawn in and around the word itself, and its letters light up in the scene's colors:
  - **Fire** (*fire*, *flame*, *burn*, *blaze*, *on fire*…) catches fire from left to right: flames lick up behind its letters and embers rise off it.
  - **Sun** (*sun*, *sunrise*, *sunset*, *sunshine*, *dawn*…) gets a half sun rising behind it out of a horizon along its baseline, its rays slowly turning, setting again as the line ends.
  - **Moon** (*moon*, *moonlight*, *moonlit*…) gets a pale half moon rising the same way, with stars coming out around it.
  - **Snow** (*snow*, *snowflake*, *frost*, *ice*, *frozen*, *winter*, *cold*…) has flakes falling around it and a drift piling up at its feet, and shivers.
  - **Rain** (*rain*, *raindrops*, *tears*, *crying*…) has rain streaking past behind it and drops gathering under its letters and falling.
  - **Lightning** (*lightning*, *thunder*, *electric*, *spark*…) crackles with bolts around it and jolts with every flash.
  - **Hearts** (*heart*, *heartbeat*, *valentine*…) beat like a heart, with little hearts floating up off them.
  - **Gold** (*gold*, *golden*, *diamond*, *glitter*, *shine*, *sparkle*…) glitters, sparkles winking on and off over its letters.
  - **Water** (*ocean*, *sea*, *waves*, *river*, *water*, *drowning*…) stands in water that rises to its middle and sloshes, with bubbles; the word bobs in it.
  - **Stars** (*star*, *stars*, *starlight*, *galaxy*, *universe*…) has stars twinkling all around it.

  One scene a line at most, at least 2.5 seconds after the last one, and the same scene again only after 9 seconds. A line with a scene shows no picture.
- **Pictures that join in.** When a word names something you can picture, a realistic picture of it joins the line as the word is sung, and moves with the song until the line is over. Most hop from word to word as each one is sung, like a bouncing ball, and jump off the end; birds, wings and planes fly across; cars, a train, a boat, a horse and big cats travel along the tops of the words; a rocket lifts off; hearts, balloons and clouds float up; rain, snow, leaves and money fall across the line; stars, fireworks and diamonds burst into little copies of themselves; the sun and the moon circle above their word; dice and a disco ball roll off the end; a flame, a lamp, a guitar or a house dances where it is. Sing about *iced tea*, *roses*, a *car*, *whiskey*, a *guitar*, a *wolf*, the *city* or a *broken heart*, and you'll see it. There are 140 pictures of the things songs mention most, built into Undertone, so they work offline. Some come alive while they show: a flame flickers in its own warm glow and a campfire throws a few embers; a lamp, a lantern, the sun and the moon glow; a star, a sparkler, fireworks and a diamond twinkle; a heart beats; a butterfly beats its wings. A picture shows at most once per line, at least 4 seconds after the last one, and the same picture again only after 20 seconds, so lyrics never fill up with them. Only English words call them for now.
- **Words that answer them.** A picture isn't stuck on top of the words: the words it touches move with it. A word squashes as a hopping picture lands on it, ducks as a bird flies over, dips under a car's wheels; a rocket shakes its word and kicks it up as it lifts off; a balloon or a heart lifts its word and sways it (a heart's word beats with it); rain hits the words it falls on; a burst pops its word and shoves the words either side apart, and lightning shakes it; the moon tilts its word toward it; a rolling ball knocks each word as it passes; a flame, a lamp or a guitar sways its word along with it, and a flame's word shimmers in its heat.
- **Splashes.** At a song's big moments (a long held note, the end of a chorus line, a shouted line) a small burst comes off the word: **droplets** that leap and fall, **sparks**, **confetti** in the song's colors, **ripples** spreading under the word, or twinkling **glints**. Which one depends on what the song is about: rain and tears splash droplets, fire and lightning throw sparks, a party throws confetti, stars and dreams glint. There's never more than one burst per line, and they're at least 5 seconds apart.

Switch it off for just the words, with no pictures or splashes. It doesn't change [Text effects](#text-effects). **Effects ▸ Graphics** in the menu does the same. If you had Effects mode off in an earlier version of Undertone, Graphics starts off too.

The same song always gets the same effects and graphics. With [Effects](#effects) at 0, the words don't move and nothing splashes, but pictures still fade in and out. If you've asked your system to reduce motion, scenes and pictures fade in and out where they stand, the words don't move with them, and there are no splashes (see [Reduced motion](#reduced-motion)). On computers without graphics acceleration, where Undertone draws everything lighter, neither switch adds anything.

### Size

How big the current line is, from 22 to 140 (default 58). Neighboring lines are drawn smaller in proportion. Undertone sets some fonts a little larger or smaller, so each reads about as large at the same Size, and a song with long lines a touch smaller.

Size is relative to your screen's height, not a fixed number of pixels. 58 means 58 pixels on a screen 1080 pixels tall (as your system scales it), and the same share of the screen on any other display. The lyrics look the same on a 13-inch laptop and a 27-inch monitor. With [Where: All displays](#where), each screen scales them to its own height. Size counts the whole screen, even though the lyrics keep clear of the menu bar, Dock and taskbar.

The lyrics always sit in the middle of the screen: the current line is centered between the menu bar and the Dock or taskbar, with the lines around it above and below. In Arc, the curve is centered too: the middle of the song's longest line rises as far above the center as its ends dip below it, and shorter lines share its middle. There's no setting for where the lyrics sit; Size is how big they are.

### Effects

How much the words move as they're sung, from 0 to 100 (default 50). The slider's ends are marked **Calm** and **Lively**, and screen readers say Calm (up to 33), Balanced (34 to 66) or Lively (67 and up) with the number.

- **50** moves the words as much as the song's look asks: a fast song more, a ballad less.
- Lower values make words rise, swell and ripple less. At **0** they don't move at all; they still fill with the highlight color and glow.
- Higher values make them move more, up to twice as much at **100**.

The menu's **Effects ▸** sets it too: **Calm** (20), **Balanced** (50) or **Lively** (85). If you've asked your system to reduce motion, words fade in instead of moving whatever Effects says, and Settings says so under the slider (see [Reduced motion](#reduced-motion)).

### Glow

How much the word being sung glows, from 0 to 100 (default 40).

- **40** is the glow the song's look asks for: a vivid cover and held notes glow more, a muted black-and-white cover less.
- Lower values make the glow fainter. At **0** it is faint, but never off.
- Higher values make it stronger, up to half as strong again at **100**.

Every word also has a soft dark shadow so light text stays readable on a bright wallpaper. At 0 that shadow is subtle; higher values make it wider and softer.

### Opacity

How see-through the lyrics are, from 20% to 100% (default 100%). It applies to everything Undertone draws, including the "No lyrics for this song" note.

## Color

Each line uses three colors:

| Color | Used for |
|---|---|
| **Lyric** | Words on the current line that haven't been sung yet |
| **Highlight** | Words already sung, and the word being sung right now (which also glows, see [Glow](#glow)). They're filled with a gradient, from the highlight at the top into a second color at the bottom |
| **Other lines** | The lines before and after the current one |

### Match album colors

On by default. Undertone looks at the album cover once per song and takes all three colors from it: the highlight is the cover's most vivid color, and the lyric color and the other lines are tinted with the cover's overall color, as strongly as the cover is colorful. A deep blue cover gives pale blue lyrics with a blue highlight; a cover whose colors clash tints them only lightly.

The sung words blend from the highlight into the cover's other main color: a gold door in green ivy gives gold into green, a blue sea under an orange sunset blue into orange. A muted color counts by how much of the cover it takes, so a big dark olive area still reads as green. A cover with one main color blends into the color next to it on the color wheel.

The colors stay readable on any wallpaper: the lyric color stays light and the highlight a mid-tone, with a dark shadow behind both. When the highlight has the lyrics' own hue, it's kept a step darker, so the words being sung still stand out. Black-and-white and gray covers get grays: white for the words being sung, light gray for the rest, or the cover's most colorful spot as the highlight.

When a song has no cover art, your own colors are used for that song. The settings window says so under the switch.

Turning **Match album colors** on doesn't change your own colors: turn it off again and your three colors come back. Editing a swatch while it's on is different (see below).

### Your own colors

Click a swatch to pick a color. Changing any color turns **Match album colors** off and saves all three colors as your own, starting from the colors on screen. So if album colors are showing and you only change the highlight, the lyric and other-lines colors become the album's, replacing the ones you had saved.

The defaults are a warm white lyric (`#F1ECE3`), an amber highlight (`#F2A65A`) and a cool gray for other lines (`#8D93A0`). With your own colors, the sung words blend from your highlight into the color next to it on the color wheel.

## Behavior

### When

When the lyrics are on screen.

- **While playing** (default): lyrics show only while a song is playing. They fade out when you pause and come back when you press play.
- **Always**: lyrics stay on screen while paused, stopped where the song stopped.

When no song is loaded in your player at all, nothing shows either way. To hide the lyrics whatever is playing, switch off [Lyrics on the desktop](#lyrics-on-the-desktop).

### Where

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

**Undertone learns from your nudges.** A song you haven't nudged starts from what your last few nudged songs have in common, and **This song** shows that value with **· learned** after it. So if your headphones play late and you nudge two or three songs the same way, the next songs start right without a nudge. It looks at the last 9 songs you nudged and takes the middle of their nudges, so one song with badly timed lyrics doesn't throw the others off. Nudge a song to give it its own value.

**Reset this song** drops the song's own nudge, so it follows the learned value again (0 until you've nudged two songs).

The buttons are grayed out when nothing is playing. If Undertone finds no music app open at all (Spotify or Music on a Mac; on Windows, any app in the Windows media controls), the song's name is replaced by **No music app open**. Between two songs the last song stays for a moment, so it doesn't flicker.

You can nudge without opening Settings:

- Menu: **Sync ▸ Earlier 100 ms**, **Sync ▸ Later 100 ms**, **Sync ▸ Reset for this song**.
- Shortcuts: ⌥⇧⌘] for 50 ms earlier and ⌥⇧⌘[ for 50 ms later (Ctrl+Alt+Shift+] and Ctrl+Alt+Shift+[ on Windows), unless you've [changed them](#shortcuts).

## Shortcuts

Three keyboard shortcuts work from any app, even with Settings closed. These are the defaults:

| Action | macOS | Windows |
|---|---|---|
| **Show or hide lyrics** | ⌥⇧⌘L | Ctrl+Alt+Shift+L |
| **Nudge earlier (+50 ms)** | ⌥⇧⌘] | Ctrl+Alt+Shift+] |
| **Nudge later (−50 ms)** | ⌥⇧⌘[ | Ctrl+Alt+Shift+[ |

Show or hide lyrics flips [Lyrics on the desktop](#lyrics-on-the-desktop). The nudges move the song playing now 50 ms earlier or later, like the buttons under [This song](#this-song).

### Changing a shortcut

In **Settings › Shortcuts**, click the shortcut next to an action, or Tab to it and press Space or Enter. It says **Press keys…**. Now press the new combination:

- It needs ⌘, ⌥ or ⌃ on a Mac, or Ctrl, Alt or the Windows key on Windows. Shift can be added, but isn't enough on its own, so a shortcut never takes ordinary typing.
- It ends with one key: a letter, a digit, F1 to F24 (F1 to F20 on a Mac), Space, an arrow, Home, End, Page Up, Page Down, Insert, Delete, Backspace, Tab, Enter, or one of `[` `]` `;` `'` `,` `.` `/` `\` `` ` `` `-` `=`.
- Combinations every app relies on are turned down, such as ⌘C, ⌘F, ⌘P, ⌘H, ⌘M and ⌘Space on a Mac, or Ctrl+V, Ctrl+F, Ctrl+Y, Alt+Tab and Alt+F4 on Windows.
- On a Mac, Undertone records where the key is, not what it types, so on a keyboard layout other than US English the key may carry a different label (on a French keyboard, the key labeled A shows as Q).
- On Windows, a letter is recorded as the letter it types on your current keyboard layout, and a digit by its place on the number row. A punctuation key works only where it types the same character as on a US English keyboard; Settings turns the others down. On other layouts the default `[` and `]` shortcuts may sit on other keys (on a German keyboard, ß and ´). Settings then says **On this keyboard layout, this shortcut may use another key. Record a new one.** under each shortcut it affects, and checks again whenever you come back to the window. Layouts for other alphabets, such as Russian, keep the US keys and get no warning.

While Settings listens, Undertone's own shortcuts are paused, so pressing the current one records it instead of hiding the lyrics. They come back as soon as you're done.

- **Esc** stops listening and keeps the shortcut.
- **Delete** (or Backspace) removes the shortcut. The action shows **None**; use the menu or Settings for it instead.
- Clicking elsewhere, switching to another app, or 25 seconds after it starts listening also stop it.
- A combination another action already has is turned down, for example "⌥⇧⌘] is already used for Nudge earlier." Press another one, or change that action first.

**Reset shortcuts** puts all three back to the defaults.

### Turning shortcuts off

Switch off **Keyboard shortcuts** to leave all three combinations to other apps. Your shortcuts are kept for when you switch it back on.

### When a shortcut doesn't work

When the system refuses a combination, Settings says **Another app is using this combination.** under it. On Windows that happens when another app already has the combination as a global shortcut, or Windows keeps it for itself; on a Mac it's rare. Shortcuts that work only inside another app (JetBrains' Reformat File, for example) can't be detected on either system. If a shortcut does nothing, or another app reacts to it as well, record a different one. **Not a usable combination.** means the saved shortcut is one Undertone can't register; record a new one.

### Why you might change them

The defaults hold three modifier keys to stay out of other apps' way, but no combination is free everywhere:

- On Windows, the AltGr key counts as Ctrl+Alt. Some keyboard layouts type characters with AltGr+Shift (Polish Ł, for example), and a shortcut on that key takes the character away. Without Shift the clash is far more common (German @ is AltGr+Q), so when you record a Ctrl+Alt shortcut without Shift, Settings reminds you.
- JetBrains IDEs (IntelliJ IDEA, PyCharm and the others) use ⌥⇧⌘L, or Ctrl+Alt+Shift+L on Windows, for Reformat File.

If either gets in your way, record another combination, or remove the shortcut you don't use.

## Reset to defaults

At the bottom of the settings window. Click **Reset to defaults…**, then **Reset** to confirm, or **Cancel** (or press Esc) to keep your settings.

Reset puts Text effects, Graphics, Effects, the colors, the size, glow and opacity, behavior, the **All songs** sync and the shortcuts back to how Undertone started. **Lyrics on the desktop** and **Launch at login** stay as they are. Per-song nudges, and what Undertone learned from them, are kept unless you tick **Also clear sync for N songs**, which appears when any song has a nudge.

## Licenses

The **Licenses** button at the very bottom of the settings window shows the licenses of the fonts and libraries built into Undertone. The same text is in `THIRD_PARTY_NOTICES.txt`, next to the app.

## Menu and shortcuts

The Undertone icon in the menu bar (macOS) or system tray (Windows) has:

| Item | What it does |
|---|---|
| **Hide lyrics** / **Show lyrics** | Hides the lyrics or brings them back, the same as [Lyrics on the desktop](#lyrics-on-the-desktop) in Settings |
| **Effects ▸** Calm / Balanced / Lively | How much the words move: 20, 50 or 85, the same as [Effects](#effects) in Settings |
| **Effects ▸** Text effects | Turns each song's own motion on or off, the same as [Text effects](#text-effects) in Settings |
| **Effects ▸** Graphics | Turns the pictures and splashes on or off, the same as [Graphics](#graphics) in Settings |
| **Sync ▸** Earlier 100 ms / Later 100 ms / Reset for this song | Nudges this song's sync (see [This song](#this-song)) |
| **Refetch lyrics** | Looks the current song up on LRCLIB again, skipping Undertone's saved copy |
| **Settings…** | Opens the settings window |
| **Launch at login** | Starts Undertone when you log in, the same as [Launch at login](#launch-at-login) in Settings |
| **Undertone 0.2.0 (build …)** | Grayed out: which build is running. Settings shows the same at the bottom |
| **Quit Undertone** | Quits Undertone |

Shortcuts that work from any app, by default (change or turn them off in [Settings › Shortcuts](#shortcuts)):

| macOS | Windows | What it does |
|---|---|---|
| ⌥⇧⌘L | Ctrl+Alt+Shift+L | Show or hide the lyrics |
| ⌥⇧⌘[ | Ctrl+Alt+Shift+[ | Nudge this song 50 ms later |
| ⌥⇧⌘] | Ctrl+Alt+Shift+] | Nudge this song 50 ms earlier |

## Loading, missing and unsynced lyrics

- **Loading.** Nothing for the first 0.6 seconds (lyrics Undertone has seen before usually arrive sooner), then three faint pulsing dots until the lyrics arrive (steady, without the pulse, if you've asked your system to reduce motion).
- **No lyrics found.** A small "No lyrics for this song" note fades in, stays for about 4 seconds, then fades out. Nothing else shows for the rest of the song. **Refetch lyrics** in the menu tries again.
- **Couldn't load.** If the lookup fails (no connection, or LRCLIB doesn't answer), a "Couldn't load lyrics" note appears and fades out the same way. Undertone tries again by itself three times over the next minute and a half, and if one try works the lyrics appear without a loading pause. **Refetch lyrics** tries again right away.
- **Instrumental.** For songs LRCLIB marks as instrumental, a ♪ slowly breathes in and out where the lyrics would be.
- **Plain (unsynced) lyrics.** Some songs' lyrics on LRCLIB have no timestamps. When the closest match is plain text, Undertone shows it at once and then looks for a synced version of the same song: another album or edition, or a slightly different length. If it finds one, it switches to it while the song plays. Without one, it can only guess when each line is sung. It skips a short intro, gives long lines more time than short ones, and pauses between verses, but the guess can't follow a singer who speeds up or slows down. So the lines around the current one stay sharp and nearly as bright, and you can read along whichever line is really being sung. There's no word-by-word highlight, and lines change with slower, calmer transitions. When you play the song more than 30 days after Undertone saved its lyrics, it looks for synced lyrics again. Synced lyrics whose timestamps would keep one line on screen for most of the song (most lines without a timestamp, or many lines on one or two) are shown the same way as plain lyrics.
- **Lyrics timed by line only.** Most songs have a timestamp for each line but not for each word. Undertone then works out when each word is sung, from its syllables and from how fast the lines around it are sung, so the highlight speeds up and slows down with the song. Every line starts exactly on its timestamp. When a line has more time than its words need, Undertone expects the singer to drag some of them out: the line's last word most, then a word before a comma, a word spelled out long ("loooove", "ohhh") and sung sounds like *oh* or *whoa*, so the highlight waits on a held note instead of running on ahead. A long break after a line is still a break: the line's words go by at the song's pace and its end is held a while, not stretched over the whole pause. Within a line the timing is still a guess: a word the singer rushes or stretches where Undertone didn't expect it can light a little early or late. Lyrics with a timestamp for every word are followed exactly.

## Song changes, pauses and breaks

- **New song:** the old lyrics fade out over a quarter of a second, then the new song's lyrics fade in, in the look Undertone picks for it.
- **Before the first line:** the first line waits on screen in the lyric color until it starts. An intro of 3 seconds or more also shows the break dots (below).
- **From line to line:** the next line moves into place just before it's sung, about a third of a second early, and waits there in the lyric color for its first word.
- **Long instrumental breaks:** a break of 3 seconds or more between two lines, and an intro that long, shows three dots: in Drift and Stack where the next line will appear, in Lens on the line, in Arc at the top of the curve. They fill one after another as the break goes on, breathe, swell, and pop away just before the next line starts.
- **Paused:** the lyrics stop where the song stopped, and Undertone stops animating. With **When: While playing** they also fade out until you press play.

## Reduced motion

If you've asked your system to reduce motion (macOS: System Settings → Accessibility → Display → **Reduce motion**; Windows: Settings → Accessibility → Visual effects → **Animation effects** off), Undertone keeps the lyrics still and changes lines with a short crossfade instead:

- Words fade quickly to the highlight color as they're sung, instead of filling behind a moving edge, and nothing rises, swells or hops; the glow stays steady. [Effects](#effects) doesn't change this, and Settings says so under its slider.
- With [Graphics](#graphics) on, words still get their scenes and pictures, but each one only fades in and out where it stands, the words don't move with it, and nothing splashes.
- **Drift and Stack** keep their layout but don't scroll; the list moves to the next line with a crossfade.
- **Lens** doesn't magnify, **Wave** doesn't ripple, and **Reveal** shows the whole line from the start. The line stays flat, and words still light up as they're sung.
- **Collage** sets the line as one level row.
- **Arc** lines don't glide between their places; they crossfade.
- The break dots don't move; they brighten one after another.
- The loading dots fade in once and then stay still instead of pulsing.
- The instrumental **♪** stays still instead of breathing.
- With **When: While playing**, pausing hides the lyrics at once instead of fading them out.

Song changes still fade out and in.

On a computer that draws without graphics acceleration (some virtual machines and remote desktops), Undertone draws the words the same calm way, to keep its CPU use low, but lines still move into place.
