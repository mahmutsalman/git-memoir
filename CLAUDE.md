# Git Memoir — VS Code Extension

Simple git history viewer with color tags, image annotations, and clipboard paste support.

## Build & Install

```bash
# 1. Build production bundle
npm run package

# 2. Package as .vsix
npx @vscode/vsce package --no-dependencies

# 3. Install into VS Code
code --install-extension git-memoir-0.1.0.vsix
```

Then **Cmd+Shift+P → Reload Window** to activate.

For dev watch mode (auto-recompiles on save, use with F5):
```bash
npm run watch
```

## Project Structure

```
GitMemoir/
├── src/
│   ├── extension.ts          — Activation entry point. Registers commands and providers.
│   ├── types.ts              — Shared interfaces: CommitInfo, FileChange, CommitNote, NotesData
│   ├── gitService.ts         — All git operations via child_process (no npm deps).
│   │                           getAllCommits, getFileCommits, getCommitFiles,
│   │                           getFileAtCommit, getFileAtParentCommit, getFilesBetweenCommits
│   ├── notesService.ts       — Read/write .vscode/git-notes/notes.json.
│   │                           setColor, addImage, addImageFromBuffer, removeImage, enrichCommits
│   ├── diffProvider.ts       — TextDocumentContentProvider for git-memoir:// URIs.
│   │                           Feeds content into VS Code's built-in diff editor.
│   └── mainViewProvider.ts   — WebviewViewProvider. The entire UI lives here.
│                               HTML/CSS/JS is inlined as a template literal.
├── dist/
│   └── extension.js          — Webpack output (single bundled file, gitignored)
├── icon.svg                  — Activity bar icon
├── package.json              — Extension manifest + scripts
├── tsconfig.json
├── webpack.config.js         — target: node, bundles src/ only (vscode externalized)
└── .vscodeignore
```

## Architecture

**No runtime npm dependencies** — git commands run via Node's built-in `child_process.exec`.

**Data flow:**
```
User right-clicks file
  → gitMemoir.showFileHistory command
    → GitService.getFileCommits()  (git log --follow)
      → NotesService.enrichCommits()  (merges notes.json)
        → _toWebviewCommits()  (converts image filenames → webview URIs)
          → WebviewView receives fileCommits message → renders
```

**Diff viewing:**
- Single commit: `GitMemoirContentProvider` stores before/after content at `git-memoir:/hash^/path` and `git-memoir:/hash/path`, then `vscode.diff` opens them side-by-side
- Compare two commits: same pattern with `git-memoir:/cmp-hash1/path` vs `git-memoir:/cmp-hash2/path`

**Image storage:** `.vscode/git-notes/images/<shortHash>-<timestamp>.png` (add to .gitignore)
**Metadata storage:** `.vscode/git-notes/notes.json` — `{ [fullHash]: { color?, images?: string[] } }`

## Webview Message Protocol

| Direction | Type | Payload |
|---|---|---|
| ext → view | `allCommits` | `{ commits: CommitInfo[] }` |
| ext → view | `fileCommits` | `{ fileName, commits }` |
| ext → view | `commitFiles` | `{ hash, files: FileChange[] }` |
| ext → view | `compareFiles` | `{ hash1, hash2, files }` |
| ext → view | `imageAttached` | `{ hash, imageName, webviewUri }` |
| view → ext | `getCommitFiles` | `{ hash }` |
| view → ext | `openDiff` | `{ hash, filePath }` |
| view → ext | `openCompareDiff` | `{ hash1, hash2, filePath }` |
| view → ext | `getCompareFiles` | `{ hash1, hash2 }` |
| view → ext | `setColor` | `{ hash, color }` |
| view → ext | `attachImage` | `{ hash }` |
| view → ext | `pasteImage` | `{ hash, dataUrl, mimeType }` |

## Key Decisions

- **Webpack target: node** — VS Code extensions run in Node.js context, not browser
- **No external runtime deps** — avoids webpack bundling complexity for node_modules
- **Images converted to webview URIs on the extension side** — ensures both "All Commits" and "Current File" tabs always show images (CSP blocks raw filesystem paths)
- **`_toWebviewCommits()`** — called before every send so the webview never receives raw filenames
- **`ctxHash`** — tracks last right-clicked commit so `Cmd+V` paste knows where to attach

## Todos

- [ ] Voice recording support (record in-panel, save to `.vscode/git-notes/audio/`)
- [ ] Right-click file in Explorer → Show File History (wired up but pending UX)
