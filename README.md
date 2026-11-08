# Frame

**Video, photo and audio editor for Windows** — as powerful as CapCut and Photoshop-style tools, but simpler. Comes with a built-in AI assistant.

## Download & install

1. Download **`Frame.exe`** from the [latest release](../../releases/latest).
2. Double-click it. Frame installs itself (no admin rights needed), adds Start-menu and desktop shortcuts, and opens.
3. Frame lives in the system tray. Right-click the tray icon to reopen or quit.

**Updates are automatic:** when a new version is out, Frame shows an *Update now* button on the home screen. One click downloads, installs and restarts it. Your projects are kept.

Exports are saved to `Videos\Frame`. Frame needs **Chrome or Edge** (one of them is preinstalled on Windows) and **FFmpeg** for saving videos. On first launch Frame offers to install FFmpeg for you.

## Studios

### 🎬 Video editor
- **Timeline:** a magnetic main track, unlimited overlay, effect and audio tracks, trim, split, ripple delete, snapping and markers.
- **Motion:** keyframes for position, scale, rotation, opacity and volume, plus one-click zoom and pan motion.
- **Looks:**
  - 28 video effects (glitch, VHS, shake, light leak, split screen, confetti…).
  - 16 filters, 13 transitions, and in/out/loop animations.
- **Cut-outs:** masks, chroma key (green screen) and AI background removal.
- **Text:** 12 animated templates, 14 text styles, stickers and shapes.
- **Time:** speed curves, reverse and freeze frame.
- **Audio:** voice effects, beat detection with cut-to-the-beat, auto-ducking and silence removal.
- **Captions:** auto captions, an `.srt` editor, and AI voiceover.
- **Export:** MP4 (up to 4K / 60 fps), GIF, MP3, WAV and PNG.
- **Command palette** (`Ctrl+K`): search and run any action.

### 🖼 Photo editor
- **Layers:** opacity, 16 blend modes, lock, reorder, merge and flatten.
- **Layer styles:** drop shadow, outer glow and stroke.
- **Tools:** move, rectangle/ellipse/lasso select, magic wand, crop, brush, eraser, clone stamp, blur brush, dodge, burn, paint bucket, gradient, text, shapes, eyedropper, hand and zoom.
- **Selections:** add, subtract, feather, invert, and **Select subject (AI)**.
- **Free transform:** scale and rotate any layer.
- **Adjustments:** brightness/contrast, levels, curves, exposure, hue/saturation, vibrance, color balance, black & white, posterize, threshold and auto tone.
- **Filters:** Gaussian and motion blur, sharpen, unsharp mask, noise, noise reduction, pixelate, emboss, find edges, vignette, bloom and painted look.
- **AI:**
  - Remove background.
  - Auto enhance.
  - Edit by prompt, e.g. "make it cinematic and add the title SUMMER".
- **Canvas:** image size, canvas size, rotate and flip, crop to selection, trim.
- **Export:** PNG, JPG or WebP at any scale, or send the image straight to the video editor.

### 🎧 Audio editor
- **View:** waveform and spectrogram, an overview bar, zooming down to individual samples, and loop playback.
- **Editing:** cut, copy, paste, delete, trim, duplicate and remove silence.
- **Volume:** amplify, normalize, fades and silence.
- **Time & pitch:** reverse, speed, tempo (keeps pitch) and pitch shift (keeps length).
- **Repair:**
  - Spectral noise reduction with a learned noise profile.
  - Click removal.
  - One-click **Enhance voice**.
- **EQ & dynamics:** 3-band EQ, bass boost, high/low-pass, compressor, limiter and noise gate.
- **Space & voice:** echo, reverb, and 11 voice effects (robot, telephone, megaphone…).
- **Stereo:** mono, swap, pan and widen.
- **Generate:** AI voice, microphone recording, tone and noise.
- **Analysis:** speech transcription with clickable timestamps, BPM detection, and peak/loudness meters.
- **Export:** WAV and MP3, or send the audio to the video editor.

## AI setup (optional)

Open **Settings** and add your keys. Keys are stored only on your computer.

| Feature | Key |
|---|---|
| AI editing assistant, video understanding, photo AI edits | NVIDIA key — [build.nvidia.com](https://build.nvidia.com) |
| AI voiceover & auto captions (`gemini-3.1-flash-live-preview`) | Gemini key — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |

## Run from source

Double-click `start.bat`. No Node.js or build step is needed. The app is plain JavaScript in `app/`, served by `server/server.ps1`.

To build the installer, run `build\build.ps1`. It produces `dist\Frame.exe` and `dist\frame-app.zip` (the update package). Each GitHub release must include both files, with a `vX.Y.Z` tag that matches `version.json`.
