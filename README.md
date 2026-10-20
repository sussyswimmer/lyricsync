<p align="center">
  <img src="docs/media/banner.webp" alt="Undertone: synced lyrics on your desktop, word by word" width="100%">
</p>

<p align="center">
  <a href="https://github.com/sussyswimmer/lyricsync/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/sussyswimmer/lyricsync?style=for-the-badge&label=release&labelColor=1b2228&color=f2a65a"></a>
  <a href="#download"><img alt="macOS 14 or later" src="https://img.shields.io/badge/macOS-14%2B-f1ece3?style=for-the-badge&labelColor=1b2228"></a>
  <a href="#download"><img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%26%2011-f1ece3?style=for-the-badge&labelColor=1b2228"></a>
  <a href="https://github.com/sussyswimmer/lyricsync/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/sussyswimmer/lyricsync/ci.yml?branch=main&style=for-the-badge&label=CI&labelColor=1b2228"></a>
  <a href="#how-its-built"><img alt="Built with Tauri 2, TypeScript and Rust" src="https://img.shields.io/badge/Tauri%202-TypeScript%20%2B%20Rust-2f5a60?style=for-the-badge&labelColor=1b2228"></a>
</p>

<p align="center">
  <img src="docs/media/demo.webp" alt="Lyrics lighting up word by word in four styles: a car drives along a curved line over a mountain lake, fireworks burst over a rainy city, a bird follows one huge word across a desert night, and the moon circles over an aurora" width="100%">
</p>

## Download

<p align="center">
  <a href="https://github.com/sussyswimmer/lyricsync/releases/latest/download/Undertone_universal.dmg"><img src="docs/media/download-macos.png" alt="Download for macOS" height="80"></a>
  &nbsp;
  <a href="https://github.com/sussyswimmer/lyricsync/releases/latest/download/Undertone_x64-setup.exe"><img src="docs/media/download-windows.png" alt="Download for Windows" height="80"></a>
</p>

<p align="center">Free. Works with Spotify and Apple Music on a Mac, and any player in the Windows media controls.</p>

> [!NOTE]
> Early release, not code-signed yet. The first time, on a Mac click **Open Anyway** in **System Settings → Privacy & Security**; on Windows click **More info**, then **Run anyway**. [Install help](docs/INSTALL.md)

## A look for every song

<table>
  <tr>
    <td width="33%" align="center"><img src="docs/media/style-arc.webp" alt="Arc: the line bends in a curve over a purple wave wallpaper"><br><sub><b>Arc</b></sub></td>
    <td width="33%" align="center"><img src="docs/media/style-lens.webp" alt="Lens: the sung word swells in a straight line over a sunset sea"><br><sub><b>Lens</b></sub></td>
    <td width="33%" align="center"><img src="docs/media/style-drift.webp" alt="Drift: lines float in depth over an aurora"><br><sub><b>Drift</b></sub></td>
  </tr>
  <tr>
    <td width="33%" align="center"><img src="docs/media/style-stack.webp" alt="Stack: a scrolling block of lines over a black-and-white street"><br><sub><b>Stack</b></sub></td>
    <td width="33%" align="center"><img src="docs/media/style-poster.webp" alt="Poster: bold capitals set as a tilted block over a rainy city"><br><sub><b>Poster</b></sub></td>
    <td width="33%" align="center"><img src="docs/media/style-spotlight.webp" alt="Spotlight: one huge word at a time over a desert night"><br><sub><b>Spotlight</b></sub></td>
  </tr>
  <tr>
    <td width="33%" align="center"><img src="docs/media/style-wave.webp" alt="Wave: the line rides a wave over white dunes at sunrise, the sung word on its crest"><br><sub><b>Wave</b></sub></td>
    <td width="33%" align="center"><img src="docs/media/style-reveal.webp" alt="Reveal: half a line sung and lit, the rest waiting as faint ghosts over a black-and-white street"><br><sub><b>Reveal</b></sub></td>
    <td width="33%" align="center"><img src="docs/media/style-collage.webp" alt="Collage: tilted cut-out capitals over a rainy city at night"><br><sub><b>Collage</b></sub></td>
  </tr>
</table>

Undertone picks the layout, one of 15 fonts and the motion from the song, and the colors from its cover. Words you can picture come to life in the line, and the words around them move with them.

## Words you can picture

<p align="center">
  <img src="docs/media/living-pictures.webp" alt="A rocket lifts off, dice roll away, a glass of wine hops from word to word and leaves fall across the line, each as its word is sung" width="100%">
</p>

<details>
<summary>All 140 pictures</summary>
<p align="center"><img src="docs/media/word-pictures.webp" alt="The 140 word pictures that come with Undertone" width="100%"></p>
</details>

## How it's built

```mermaid
flowchart LR
  P["🎵 Spotify · Apple Music<br/>Windows media controls"] --> R
  L[("LRCLIB")] --> R
  R["Rust core · Tauri 2<br/>what's playing · lyrics cache<br/>desktop layer"] -- events --> T
  T["TypeScript overlay<br/>word timing · look · animation"] --> D["🖥️ Your desktop<br/>under icons and windows"]
```

- **Rust** reads what's playing, fetches lyrics from [LRCLIB](https://lrclib.net) and pins the overlay under your desktop icons.
- **TypeScript** times every word, picks a look from the song and its cover, and animates it on the GPU.

## Docs

[User guide](docs/USER_GUIDE.md) · [Install](docs/INSTALL.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Development](docs/DEVELOPMENT.md) · [Architecture](SPEC.md)

<sub>Lyrics from LRCLIB. Word pictures and wallpapers made for Undertone with Higgsfield. Fonts under the SIL Open Font License.</sub>
