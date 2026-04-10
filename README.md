# Git Memoir

A VS Code extension that turns your git history into a personal journal. Annotate commits with color tags, images, and audio recordings — right inside the editor.

## Features

- **All Commits view** — browse the full git log with color-coded commit cards
- **Current File view** — see only the commits that touched the active file
- **Color tags** — mark commits with a color for quick visual scanning
- **Image annotations** — attach screenshots or diagrams to any commit (file picker or paste from clipboard)
- **Audio recordings** — record voice notes per commit; file-scoped recordings only appear in the Current File tab
- **Diff viewer** — open any commit's diff with one click, or compare two selected commits side-by-side
- **Persistent audio player** — playback state (position, play/pause) survives commit collapse/expand
- **Playback speed control** — global speed toggle (0.5× – 2×), defaults to 1.5×

## Install

Download the latest `.vsix` from [Releases](../../releases) and install:

```bash
code --install-extension git-memoir-<version>.vsix
```

Then **Cmd+Shift+P → Reload Window**.

## Usage

| Action | How |
|---|---|
| Open panel | Click the Git Memoir icon in the Activity Bar |
| View file history | Right-click any file in the Explorer → **Show File History** |
| Tag a commit | Click the colored dot on a commit card |
| Attach an image | Click the image badge → file picker, or Cmd+V to paste |
| Record audio | Click the mic button on a commit card |
| Play recording | Click the audio badge to expand the player |
| Open diff | Expand a commit → click any file in the changed-files list |
| Compare two commits | Select two commits with the checkbox → **Compare** |

## Data Storage

All annotations are saved locally in your workspace:

```
.vscode/
└── git-notes/
    ├── notes.json          # commit metadata (colors, image/audio filenames)
    ├── images/             # attached images
    └── audio/              # voice recordings
```

Add `.vscode/git-notes/` to your `.gitignore` to keep annotations private, or commit it to share with your team.

## Build from Source

```bash
npm install

# Dev (watch mode, use with F5 in VS Code)
npm run watch

# Production build + package
npm run package
npx @vscode/vsce package --no-dependencies
code --install-extension git-memoir-0.1.0.vsix
```

## Architecture

- **No runtime npm dependencies** — all git operations use Node's built-in `child_process`
- Single webpack bundle (`dist/extension.js`) targeting the Node.js VS Code extension host
- Entire UI is a single `WebviewViewProvider` with inlined HTML/CSS/JS
- Audio and images are converted to webview URIs on the extension side to satisfy VS Code's Content Security Policy
