# Local Dev Notes

## Full Build + Install (required to see changes in VS Code)

`npm run package` alone is NOT enough — the running extension loads from the installed VSIX, not from `dist/`. Always run all three steps:

```bash
npm run package
npx @vscode/vsce package --no-dependencies
code --install-extension git-memoir-0.1.0.vsix
```

Then **Cmd+Shift+P → Reload Window** in VS Code.

## Why Reload Window isn't enough on its own

VS Code loads the extension from `~/.vscode/extensions/git-memoir-0.1.0/`, not from the workspace `dist/` folder. Only reinstalling the VSIX updates that copy.
