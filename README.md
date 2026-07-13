# Caption Deck — WebVTT / SRT Editor

A self-contained, browser-based caption editor. No install, no server, no
build step — open `index.html` and go.

## Getting started

1. Unzip the three files (`index.html`, `styles.css`, `script.js`) into the
   same folder — they reference each other by relative path, so they need to
   stay together.
2. Double-click `index.html` to open it in your browser.

That's it. Everything runs client-side; no data ever leaves your machine.

## Features

### Load & preview
- Load a local video file for a live preview with captions burned into an
  overlay as the video plays.
- Works without a video too — a virtual clock drives the timeline and
  caption preview so you can draft captions before you have footage.

### Playback controls
- Play/pause (also bound to the spacebar), scrubber, current time / duration
  readout, volume + mute, playback speed (0.5×–2×), and previous/next-cue
  jump buttons.

### Cue editing
- Add, duplicate, or delete cues.
- Edit start/end timestamps and text directly in the cue list.
- Drag cue blocks on the timeline to move them; drag their edges to trim
  start/end. Everything stays in sync between the list, the timeline, and
  the video preview.

### WebVTT + SRT support
- Load either `.vtt` or `.srt` — format is auto-detected from the file
  extension (or sniffed from the content if the extension is missing).
- Export to `.vtt` or `.srt` at any time, regardless of which format you
  loaded. Loading one and exporting the other is how you convert between
  them.

### Bulk time-shift ("Shift range")
- Set a start and end marker — by typing a timestamp, clicking "Mark
  start"/"Mark end" at the current playhead position, or dragging the
  markers directly on the timeline.
- Enter an offset in seconds (positive or negative) and click "Shift cues."
  Every cue whose start time falls inside the marked range shifts by that
  amount; everything outside the range is untouched. Cue duration is always
  preserved, and shifts are clamped so a cue can never go negative.

### Transcript comparison
- Click "Compare transcripts" to check the transcript currently loaded in
  the editor against a second `.vtt`/`.srt` file — built for comparing an
  AI-generated transcript against a human-corrected one (or vice versa).
- The tool splits both transcripts into sentences, aligns matching sentences
  even when wording or segmentation differs, and runs a word-level diff on
  each matched pair. Differing words are highlighted (struck-through red =
  only in transcript A, underlined green = only in transcript B); sentences
  present in only one transcript are flagged as such rather than forced into
  a false match.
- A legend counts exact matches, changed sentences, and additions/removals.
- Click any sentence in column A to jump the video/timeline to that moment.
- "Use B as working transcript" swaps the comparison file into the main
  editor if it turns out to be the one you want to keep working from.

**Known limitation:** sentences are split on `. ! ?`. If the two transcripts
punctuate a boundary differently (e.g. a comma where the other file has a
period), that spot can occasionally show up as a false addition/removal
alongside a nearby "changed" match, rather than one clean match. Real
misspellings, wording changes, and genuinely added/removed sentences are
still caught correctly.

## File structure

```
index.html    Markup only
styles.css    All styling (dark, broadcast-monitor–inspired theme)
script.js     All app logic — parsing, diffing, rendering, playback
```

## Browser support

Any modern evergreen browser (Chrome, Firefox, Edge, Safari). No internet
connection is required except to load the Google Fonts used for the UI
typefaces (Space Grotesk, Inter, JetBrains Mono) — the app itself works
fully offline otherwise.

## Notes

- Nothing is saved automatically — use the Export buttons to download your
  `.vtt`/`.srt` file when you're done. Refreshing the page clears the
  current session.
- All processing (parsing, diffing, video playback) happens locally in your
  browser; no files are uploaded anywhere.
