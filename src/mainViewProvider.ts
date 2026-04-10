import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { GitService } from './gitService';
import { NotesService } from './notesService';
import { GitMemoirContentProvider } from './diffProvider';
import { getClipboardImage } from './clipboardService';
import { findFfmpeg, findSox, listAudioDevices, buildInputArgs, buildSoxArgs } from './audioService';

export class MainViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _git?: GitService;
    private _notes?: NotesService;
    private _repoRoot?: string;
    private _recProcess: ChildProcess | null = null;
    private _recTempPath: string | null = null;
    private _recHash: string | null = null;
    private _recUsingSox = false;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly diffProvider: GitMemoirContentProvider
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: workspaceRoot ? [workspaceRoot] : []
        };

        webviewView.webview.html = this._buildHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
        // Data is sent in response to the 'ready' message from the webview.
        // resolveWebviewView is called every time the panel becomes visible again,
        // so we do NOT eagerly load here — the webview always sends 'ready' on mount.
    }

    // ─── Public API ────────────────────────────────────────────────────────────

    async showFileHistory(filePath: string) {
        await this._ensureServices();
        if (!this._git) { return; }

        try {
            const commits = await this._git.getFileCommits(filePath);
            const notes = this._notes!.load();
            const enriched = this._notes!.enrichCommits(commits, notes);
            const relPath = path.relative(this._repoRoot!, filePath);
            this._send({
                type: 'fileCommits',
                fileName: path.basename(filePath),
                filePath: relPath,
                commits: this._toWebviewCommits(enriched)
            });
        } catch (e) {
            this._send({ type: 'error', message: String(e) });
        }
    }

    async refresh() {
        await this._loadAllCommits();
    }

    // ─── Init ──────────────────────────────────────────────────────────────────

    // Creates GitService + NotesService once. Safe to call multiple times.
    private async _ensureServices(): Promise<boolean> {
        if (this._git) { return true; }

        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) {
            this._send({ type: 'error', message: 'No workspace folder open.' });
            return false;
        }

        const root = folder.uri.fsPath;
        if (!fs.existsSync(path.join(root, '.git'))) {
            this._send({ type: 'error', message: 'No git repository found in this workspace.' });
            return false;
        }

        this._repoRoot = root;
        this._git = new GitService(root);
        this._notes = new NotesService(root);
        return true;
    }

    private async _loadAllCommits() {
        if (!this._git || !this._notes) { return; }
        try {
            const commits = await this._git.getAllCommits();
            const notes = this._notes.load();
            const enriched = this._notes.enrichCommits(commits, notes);
            this._send({ type: 'allCommits', commits: this._toWebviewCommits(enriched) });
        } catch (e) {
            this._send({ type: 'error', message: String(e) });
        }
    }

    // Convert image/audio filenames → webview URIs so both tabs share the same format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private _toWebviewCommits(commits: any[]): any[] {
        if (!this._view || !this._notes) { return commits; }
        const webview = this._view.webview;
        const imagesDir = this._notes.imagesDir;
        const audiosDir = this._notes.audiosDir;
        return commits.map(c => {
            const hasImages = c.note?.images?.length;
            const hasAudios = c.note?.audios?.length;
            if (!hasImages && !hasAudios) { return c; }
            return {
                ...c,
                note: {
                    ...c.note,
                    images: hasImages ? c.note.images.map((filename: string) => ({
                        name: filename,
                        uri: webview.asWebviewUri(
                            vscode.Uri.file(path.join(imagesDir, filename))
                        ).toString()
                    })) : (c.note?.images ?? []),
                    audios: hasAudios ? c.note.audios.map((filename: string) => ({
                        name: filename,
                        uri: webview.asWebviewUri(
                            vscode.Uri.file(path.join(audiosDir, filename))
                        ).toString()
                    })) : (c.note?.audios ?? [])
                }
            };
        });
    }

    // ─── Message handling ──────────────────────────────────────────────────────

    private async _handleMessage(msg: { type: string; [k: string]: unknown }) {
        switch (msg.type) {
            case 'ready':
                // Called every time the webview mounts (including coming back from another panel).
                // Always re-send commits so the view is never stuck on "Loading…".
                if (await this._ensureServices()) {
                    await this._loadAllCommits();
                }
                break;

            case 'getCommitFiles': {
                const files = await this._git?.getCommitFiles(msg.hash as string);
                this._send({ type: 'commitFiles', hash: msg.hash, files });
                break;
            }

            case 'openDiff': {
                await this._openSingleCommitDiff(msg.hash as string, msg.filePath as string);
                break;
            }

            case 'openCompareDiff': {
                await this._openCompareDiff(
                    msg.hash1 as string, msg.hash2 as string, msg.filePath as string
                );
                break;
            }

            case 'getCompareFiles': {
                const files = await this._git?.getFilesBetweenCommits(
                    msg.hash1 as string, msg.hash2 as string
                );
                this._send({ type: 'compareFiles', hash1: msg.hash1, hash2: msg.hash2, files });
                break;
            }

            case 'setColor': {
                this._notes?.setColor(msg.hash as string, msg.color as string | null);
                break;
            }

            case 'attachImage': {
                await this._attachImage(msg.hash as string);
                break;
            }

            case 'pasteImage': {
                // dataUrl is present when triggered by keyboard Cmd+V (paste event in webview).
                // When absent, we read the clipboard natively from the extension side.
                if (msg.dataUrl) {
                    await this._pasteImageFromDataUrl(msg.hash as string, msg.dataUrl as string, msg.mimeType as string);
                } else {
                    await this._pasteImageNative(msg.hash as string);
                }
                break;
            }

            case 'removeImage': {
                this._notes?.removeImage(msg.hash as string, msg.imageName as string);
                break;
            }

            case 'removeAudio': {
                this._notes?.removeAudio(msg.hash as string, msg.audioName as string);
                break;
            }

            case 'listDevices': {
                const ffmpeg = await findFfmpeg();
                if (ffmpeg) {
                    const devices = await listAudioDevices(ffmpeg);
                    this._send({ type: 'deviceList', devices });
                } else {
                    this._send({ type: 'deviceList', devices: [] });
                }
                break;
            }
            case 'startRecording': {
                await this._startExtensionRecording(msg.hash as string, msg.deviceId as string | undefined);
                break;
            }
            case 'pauseRecording': {
                this._pauseExtensionRecording();
                break;
            }
            case 'resumeRecording': {
                this._resumeExtensionRecording();
                break;
            }
            case 'stopRecording': {
                await this._stopExtensionRecording();
                break;
            }
            case 'cancelRecording': {
                this._cancelExtensionRecording();
                break;
            }
        }
    }

    // ─── Diff helpers ──────────────────────────────────────────────────────────

    private async _openSingleCommitDiff(hash: string, relPath: string) {
        if (!this._git || !this._repoRoot) { return; }

        const fileName = path.basename(relPath);
        const [after, before] = await Promise.all([
            this._git.getFileAtCommit(hash, relPath),
            this._git.getFileAtParentCommit(hash, relPath)
        ]);

        const uriBefore = vscode.Uri.parse(`git-memoir:/${hash}^/${relPath}`);
        const uriAfter  = vscode.Uri.parse(`git-memoir:/${hash}/${relPath}`);
        this.diffProvider.set(uriBefore, before);
        this.diffProvider.set(uriAfter, after);

        await vscode.commands.executeCommand(
            'vscode.diff', uriBefore, uriAfter,
            `${fileName}  ${hash.substring(0, 7)}`
        );
    }

    private async _openCompareDiff(hash1: string, hash2: string, relPath: string) {
        if (!this._git) { return; }

        const fileName = path.basename(relPath);
        const [content1, content2] = await Promise.all([
            this._git.getFileAtCommit(hash1, relPath),
            this._git.getFileAtCommit(hash2, relPath)
        ]);

        const uri1 = vscode.Uri.parse(`git-memoir:/cmp-${hash1}/${relPath}`);
        const uri2 = vscode.Uri.parse(`git-memoir:/cmp-${hash2}/${relPath}`);
        this.diffProvider.set(uri1, content1);
        this.diffProvider.set(uri2, content2);

        await vscode.commands.executeCommand(
            'vscode.diff', uri1, uri2,
            `${fileName}  ${hash1.substring(0, 7)} ↔ ${hash2.substring(0, 7)}`
        );
    }

    // ─── Image attachment ──────────────────────────────────────────────────────

    private async _attachImage(hash: string) {
        const uris = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectMany: false,
            filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
            title: 'Attach image to commit'
        });
        if (!uris?.[0] || !this._notes || !this._view) { return; }

        const destPath = this._notes.addImage(hash, uris[0].fsPath);
        this._sendImageAttached(hash, destPath);
    }

    // Called when Cmd+V fires in the webview (paste event sends the dataUrl)
    private async _pasteImageFromDataUrl(hash: string, dataUrl: string, mimeType: string) {
        if (!this._notes) { return; }
        const base64 = dataUrl.split(',')[1];
        if (!base64) { return; }
        const buffer = Buffer.from(base64, 'base64');
        const ext = mimeType.includes('png') ? '.png'
                  : mimeType.includes('jpeg') ? '.jpg'
                  : mimeType.includes('gif') ? '.gif'
                  : '.png';
        const destPath = this._notes.addImageFromBuffer(hash, buffer, ext);
        this._sendImageAttached(hash, destPath);
    }

    // Called from the context menu "Paste Image" — reads clipboard natively on the extension side
    private async _pasteImageNative(hash: string) {
        if (!this._notes) { return; }
        const img = await getClipboardImage();
        if (!img) {
            vscode.window.showInformationMessage(
                'No image found in clipboard. Copy a screenshot or image first (Cmd+Shift+4 on macOS).'
            );
            return;
        }
        const destPath = this._notes.addImageFromBuffer(hash, img.data, img.ext);
        this._sendImageAttached(hash, destPath);
    }

    private _sendImageAttached(hash: string, destPath: string) {
        if (!this._view) { return; }
        const webviewUri = this._view.webview.asWebviewUri(vscode.Uri.file(destPath));
        const imageName = path.basename(destPath);
        this._send({ type: 'imageAttached', hash, imageName, webviewUri: webviewUri.toString() });
    }

    // ─── Extension-side audio recording (sox preferred, ffmpeg fallback) ─────────

    private async _startExtensionRecording(hash: string, deviceId?: string) {
        if (this._recProcess) { return; }

        this._recHash = hash;
        this._recTempPath = path.join(os.tmpdir(), `git-memoir-${Date.now()}.wav`);
        const platform = os.platform();

        // Try sox first — uses CoreAudio directly on macOS, no avfoundation buffering artifacts
        const sox = await findSox();
        if (sox) {
            // deviceId on macOS is the device name string (e.g. "MacBook Pro Microphone")
            // ffmpegId-style indices (":0") are not valid for sox; fall back to 'default'
            const deviceName = deviceId && !deviceId.startsWith(':') ? deviceId : 'default';
            const soxArgs = buildSoxArgs(platform, deviceName, this._recTempPath);
            this._recProcess = spawn(sox, soxArgs, { stdio: ['ignore', 'ignore', 'ignore'] });
            this._recUsingSox = true;
        } else {
            // Fallback to ffmpeg
            const ffmpeg = await findFfmpeg();
            if (!ffmpeg) {
                this._send({ type: 'recordingError', message: 'No recorder found. See the notification for install instructions.' });
                if (platform === 'win32') {
                    const choice = await vscode.window.showInformationMessage(
                        'Git Memoir needs Sox or FFmpeg to record audio.',
                        { modal: true, detail:
                            'Option 1 — Sox (recommended):\n' +
                            '  Download from https://sourceforge.net/projects/sox/\n' +
                            '  Install it, then reload VS Code.\n\n' +
                            'Option 2 — FFmpeg:\n' +
                            '  Download from https://ffmpeg.org/download.html\n' +
                            '  Add ffmpeg.exe to your PATH, then reload VS Code.\n\n' +
                            'Pause/resume is only supported with Sox on Windows.'
                        },
                        'Get Sox', 'Get FFmpeg'
                    );
                    if (choice === 'Get Sox') {
                        vscode.env.openExternal(vscode.Uri.parse('https://sourceforge.net/projects/sox/'));
                    } else if (choice === 'Get FFmpeg') {
                        vscode.env.openExternal(vscode.Uri.parse('https://ffmpeg.org/download.html'));
                    }
                } else {
                    vscode.window.showErrorMessage(
                        'Git Memoir: No recorder found.',
                        { modal: false, detail: 'Install sox with: brew install sox' }
                    );
                }
                return;
            }
            const id = deviceId ?? (platform === 'darwin' ? ':0' : platform === 'linux' ? 'default' : 'audio=default');
            const inputArgs = buildInputArgs(platform, id);
            this._recProcess = spawn(ffmpeg, [
                '-thread_queue_size', '4096',
                ...inputArgs,
                '-ar', '48000', '-ac', '1',
                '-af', 'highpass=f=120,lowpass=f=3400,anlmdn,acompressor=threshold=-68dB:ratio=3:attack=50:release=500',
                '-c:a', 'pcm_s16le', '-y',
                this._recTempPath
            ], { stdio: ['pipe', 'ignore', 'ignore'] });
            this._recUsingSox = false;
        }

        this._recProcess.on('error', (err) => {
            this._send({ type: 'recordingError', message: err.message });
            this._cleanupRec();
        });

        // Wait ~600ms for the recorder to initialise before signalling ready
        const canPause = os.platform() !== 'win32';
        setTimeout(() => {
            if (this._recProcess) {
                this._send({ type: 'recordingStarted', hash, canPause });
            }
        }, 600);
    }

    private _pauseExtensionRecording() {
        if (!this._recProcess) { return; }
        if (os.platform() === 'win32') {
            // SIGSTOP not supported on Windows — ignore silently
            return;
        }
        try { this._recProcess.kill('SIGSTOP'); } catch { /* ignore */ }
        this._send({ type: 'recordingPaused' });
    }

    private _resumeExtensionRecording() {
        if (!this._recProcess) { return; }
        if (os.platform() === 'win32') { return; }
        try { this._recProcess.kill('SIGCONT'); } catch { /* ignore */ }
        this._send({ type: 'recordingResumed' });
    }

    private async _stopExtensionRecording() {
        if (!this._recProcess || !this._recTempPath || !this._recHash) { return; }

        const proc = this._recProcess;
        const tempPath = this._recTempPath;
        const hash = this._recHash;
        const isWindows = os.platform() === 'win32';
        this._cleanupRec();

        await new Promise<void>((resolve) => {
            const timeout = setTimeout(() => {
                try { proc.kill(); } catch { /* ignore */ }
                resolve();
            }, 4000);
            proc.on('close', () => { clearTimeout(timeout); resolve(); });
            // SIGINT causes sox/ffmpeg to finalize WAV on Unix; on Windows just kill()
            try {
                if (isWindows) { proc.kill(); } else { proc.kill('SIGINT'); }
            } catch { resolve(); }
        });

        if (!fs.existsSync(tempPath) || fs.statSync(tempPath).size < 100) {
            this._send({ type: 'recordingError', message: 'No audio captured. Is a microphone connected?' });
            try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
            return;
        }

        const buffer = fs.readFileSync(tempPath);
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }

        if (this._notes) {
            const destPath = this._notes.addAudio(hash, buffer, '.wav');
            this._sendAudioSaved(hash, destPath);
        }
    }

    private _cancelExtensionRecording() {
        if (!this._recProcess) { return; }
        const proc = this._recProcess;
        const tempPath = this._recTempPath;
        this._cleanupRec();
        try { proc.kill(); } catch { /* ignore */ }
        if (tempPath) { try { fs.unlinkSync(tempPath); } catch { /* ignore */ } }
    }

    private _cleanupRec() {
        this._recProcess = null;
        this._recTempPath = null;
        this._recHash = null;
        this._recUsingSox = false;
    }

    private _sendAudioSaved(hash: string, destPath: string) {
        if (!this._view) { return; }
        const webviewUri = this._view.webview.asWebviewUri(vscode.Uri.file(destPath));
        const audioName = path.basename(destPath);
        this._send({ type: 'audioSaved', hash, audioName, webviewUri: webviewUri.toString() });
    }

    // ─── Utilities ─────────────────────────────────────────────────────────────

    private _send(msg: unknown) {
        this._view?.webview.postMessage(msg);
    }

    // ─── HTML ──────────────────────────────────────────────────────────────────

    private _buildHtml(webview: vscode.Webview): string {
        const nonce = Array.from({ length: 32 }, () =>
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
                Math.floor(Math.random() * 62)
            ]
        ).join('');

        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none';
           img-src ${webview.cspSource} data:;
           media-src ${webview.cspSource} blob:;
           script-src 'nonce-${nonce}';
           style-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Tabs ── */
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .tab {
    flex: 1;
    padding: 7px 8px;
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    border-bottom: 2px solid transparent;
    transition: color 0.1s, border-color 0.1s;
  }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active {
    color: var(--vscode-foreground);
    border-bottom-color: var(--vscode-focusBorder);
  }
  #fileTabLabel { font-style: italic; }

  /* ── Scrollable list area ── */
  .list-area {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  /* ── Status / empty ── */
  .status-msg {
    padding: 24px 12px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    text-align: center;
  }
  .error-msg {
    padding: 12px;
    color: var(--vscode-errorForeground);
    font-size: 12px;
  }

  /* ── Commit card ── */
  .commit {
    position: relative;
    padding: 7px 10px 7px 14px;
    cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.1));
    border-left: 3px solid transparent;
    transition: background 0.1s, border-left-color 0.1s;
    user-select: none;
  }
  .commit:hover { background: var(--vscode-list-hoverBackground); }

  /* ── Expanded commit — strong visual treatment ── */
  .commit.expanded {
    background: var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.08));
    border-left-color: var(--vscode-focusBorder);
  }
  .commit.expanded .commit-hash {
    color: var(--vscode-foreground);
    font-weight: 700;
  }
  .commit.expanded .commit-msg {
    color: var(--vscode-foreground);
    font-weight: 500;
  }

  /* ── Selected (Cmd+click) — blue tint with checkmark ── */
  .commit.selected {
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
    outline: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 50%, transparent);
    outline-offset: -1px;
  }
  .commit.selected .commit-hash { color: var(--vscode-focusBorder); font-weight: 700; }
  .commit.selected .select-badge { display: flex; }

  /* ── Chevron ── */
  .chevron {
    font-size: 9px;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
    margin-top: 2px;
    transition: transform 0.15s;
    display: inline-block;
    width: 10px;
    line-height: 1;
  }
  .commit.expanded .chevron {
    transform: rotate(90deg);
    color: var(--vscode-foreground);
  }

  /* ── Select badge (shown on Cmd+click) ── */
  .select-badge {
    display: none;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--vscode-focusBorder);
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }

  .commit-top {
    display: flex;
    align-items: flex-start;
    gap: 5px;
  }
  .commit-hash {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
    flex-shrink: 0;
    margin-top: 1px;
    transition: color 0.1s;
  }
  .commit-msg {
    flex: 1;
    font-size: 12px;
    line-height: 1.4;
    word-break: break-word;
    transition: color 0.1s;
  }
  /* ── Image badge (collapsed thumbnail strip indicator) ── */
  .img-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    font-size: 10px;
    font-weight: 700;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-badge-foreground, #fff);
    background: var(--vscode-badge-background, #4d78cc);
    border-radius: 9px;
    padding: 0 5px;
    cursor: pointer;
    flex-shrink: 0;
    margin-top: 1px;
    transition: opacity 0.1s;
    user-select: none;
    letter-spacing: 0;
  }
  .img-badge:hover { opacity: 0.8; }

  /* ── Context menu date info line ── */
  .ctx-info {
    padding: 5px 14px 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: nowrap;
  }

  /* ── Right-click context menu ── */
  .ctx-menu {
    position: fixed;
    display: none;
    flex-direction: column;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 3px 0;
    z-index: 1000;
    min-width: 200px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  .ctx-menu.open { display: flex; }
  .ctx-item {
    padding: 6px 14px;
    cursor: pointer;
    font-size: 12px;
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    transition: background 0.07s;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ctx-item:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
  }
  .ctx-icon { font-size: 13px; width: 16px; text-align: center; flex-shrink: 0; }
  .ctx-sep {
    height: 1px;
    background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    margin: 3px 0;
  }

  /* ── Commit images strip ── */
  .images-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 5px;
  }
  .images-strip img {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 3px;
    cursor: zoom-in;
    border: 1px solid var(--vscode-panel-border);
  }

  /* ── Files list ── */
  .file-list {
    background: var(--vscode-editor-background);
    border-top: 2px solid var(--vscode-focusBorder);
    border-bottom: 2px solid var(--vscode-focusBorder);
    padding: 3px 0 4px;
    margin-bottom: 1px;
  }
  .file-list-header {
    padding: 2px 10px 3px 24px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }
  .file-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px 4px 24px;
    cursor: pointer;
    font-size: 11px;
    transition: background 0.08s;
    border-radius: 2px;
    margin: 0 4px;
  }
  .file-item:hover {
    background: var(--vscode-list-hoverBackground);
    color: var(--vscode-foreground);
  }
  .file-item:hover .file-path { color: var(--vscode-foreground); }
  .file-status {
    font-family: monospace;
    font-size: 10px;
    font-weight: 700;
    width: 14px;
    flex-shrink: 0;
  }
  .status-M { color: #e2c08d; }
  .status-A { color: #81b88b; }
  .status-D { color: #c74e39; }
  .status-R { color: #7cb6e4; }
  .file-path {
    flex: 1;
    color: var(--vscode-foreground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .loading-files {
    padding: 6px 22px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  /* ── Color picker popup ── */
  .color-popup {
    position: fixed;
    display: none;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
    border-radius: 4px;
    padding: 6px;
    z-index: 1000;
    gap: 5px;
    flex-wrap: wrap;
    width: 120px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
  }
  .color-popup.open { display: flex; }
  .color-dot {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid transparent;
    transition: transform 0.1s, border-color 0.1s;
    flex-shrink: 0;
  }
  .color-dot:hover { transform: scale(1.2); border-color: rgba(255,255,255,0.4); }
  .color-dot.none {
    background: var(--vscode-input-background);
    position: relative;
  }
  .color-dot.none::after {
    content: '✕';
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }

  /* ── Compare bar ── */
  .compare-bar {
    display: none;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-top: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editor-background);
    flex-shrink: 0;
  }
  .compare-bar.visible { display: flex; }
  .compare-bar-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    flex: 1;
  }
  .btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    padding: 4px 10px;
    font-size: 11px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn-ghost {
    background: none;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border);
  }
  .btn-ghost:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground); }

  /* ── Compare results view ── */
  .compare-header {
    padding: 8px 10px;
    font-size: 11px;
    border-bottom: 1px solid var(--vscode-panel-border);
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .compare-header-text {
    flex: 1;
    color: var(--vscode-descriptionForeground);
    font-family: monospace;
  }
  .view { display: none; height: 100%; flex-direction: column; }
  .view.active { display: flex; }

  /* ── Audio badge ── */
  .aud-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    font-size: 10px;
    font-weight: 700;
    font-family: var(--vscode-editor-font-family, monospace);
    color: #fff;
    background: #2472c8;
    border-radius: 9px;
    padding: 0 5px;
    cursor: pointer;
    flex-shrink: 0;
    margin-top: 1px;
    transition: opacity 0.1s;
    user-select: none;
    letter-spacing: 0;
  }
  .aud-badge:hover { opacity: 0.85; }

  /* ── Custom audio player ── */
  .audio-player {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 6px;
    padding: 2px 0;
  }
  .ap-row {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    border-radius: 6px;
    user-select: none;
  }
  .ap-play {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: #2472c8;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background 0.15s;
  }
  .ap-play:hover { background: #1a5faa; }
  .ap-play svg { display: block; }
  .ap-track {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .ap-progress {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 3px;
    border-radius: 2px;
    background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.3));
    outline: none;
    cursor: pointer;
  }
  .ap-progress::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #2472c8;
    cursor: pointer;
    margin-top: -3.5px;
  }
  .ap-progress::-webkit-slider-runnable-track {
    height: 3px;
    border-radius: 2px;
  }
  .ap-time {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .ap-del {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: transparent;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    opacity: 0;
    transition: opacity 0.15s, background 0.15s;
    color: var(--vscode-descriptionForeground);
  }
  .ap-row:hover .ap-del { opacity: 1; }
  .ap-del:hover { background: var(--vscode-inputValidation-errorBackground, rgba(200,50,50,0.2)); color: #e05252; }

  /* ── Recording panel (fixed top overlay, just below tabs ~36px) ── */
  .rec-panel {
    position: fixed;
    top: 36px;
    left: 0;
    right: 0;
    display: none;
    flex-direction: column;
    gap: 0;
    border-bottom: 2px solid var(--vscode-focusBorder);
    background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-focusBorder));
    z-index: 500;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
  }
  .rec-panel.open { display: flex; }

  /* error state */
  .rec-panel.error { border-bottom-color: var(--vscode-errorForeground, #f14c4c); }

  .rec-main-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px 6px;
  }
  .rec-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #ef4444;
    animation: rec-blink 1s ease-in-out infinite;
    flex-shrink: 0;
  }
  .rec-panel.paused .rec-dot { animation: none; background: #f97316; }
  .rec-panel.error .rec-dot { animation: none; background: var(--vscode-errorForeground, #f14c4c); }
  @keyframes rec-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.15; }
  }
  .rec-label {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .rec-state {
    font-size: 11px;
    font-weight: 700;
    color: var(--vscode-foreground);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .rec-hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 1px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rec-timer {
    font-size: 18px;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
    letter-spacing: 2px;
    font-weight: 600;
    flex-shrink: 0;
    min-width: 44px;
    text-align: right;
  }
  .rec-ready-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 14px;
  }
  .rec-active-row {
    display: flex;
    flex-direction: column;
  }
  .rec-device-sel {
    flex: 1;
    min-width: 0;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    border-radius: 3px;
    font-size: 11px;
    padding: 4px 6px;
    cursor: pointer;
  }
  .rec-ready-row .btn, .rec-ready-row .btn-ghost {
    font-size: 11px;
    padding: 5px 10px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .rec-controls {
    display: flex;
    gap: 5px;
    padding: 6px 14px 10px;
  }
  .rec-controls .btn, .rec-controls .btn-ghost {
    flex: 1;
    text-align: center;
    font-size: 11px;
    padding: 5px 8px;
  }

  /* ── Image lightbox overlay ── */
  .lightbox {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.8);
    z-index: 2000;
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }
  .lightbox.open { display: flex; }
  .lightbox img { max-width: 90%; max-height: 90%; border-radius: 4px; }
</style>
</head>
<body>

<!-- ── Tabs ── -->
<div class="tabs">
  <button class="tab active" id="tabAll">All Commits</button>
  <button class="tab" id="tabFile"><span id="fileTabLabel">Current File</span></button>
</div>

<!-- ── Main commit list view ── -->
<div class="view active" id="viewMain">
  <div class="list-area" id="commitList">
    <div class="status-msg">Loading…</div>
  </div>
  <div class="compare-bar" id="compareBar">
    <span class="compare-bar-label" id="compareLabel">2 commits selected</span>
    <button class="btn" id="compareBtn">Compare</button>
    <button class="btn btn-ghost" id="clearSelBtn">✕</button>
  </div>
</div>

<!-- ── Compare results view ── -->
<div class="view" id="viewCompare">
  <div class="compare-header">
    <button class="btn btn-ghost" id="backBtn">← Back</button>
    <span class="compare-header-text" id="compareHeaderText"></span>
  </div>
  <div class="list-area" id="compareList"></div>
</div>

<!-- ── Recording panel ── -->
<div class="rec-panel" id="recPanel">
  <!-- Ready state: pick device then start -->
  <div class="rec-ready-row" id="recReadyRow">
    <select class="rec-device-sel" id="recDeviceSel">
      <option value="">Loading devices…</option>
    </select>
    <button class="btn" id="recStartBtn">⏺ Record</button>
    <button class="btn btn-ghost" id="recCancelBtn">✕</button>
  </div>
  <!-- Active state: recording controls -->
  <div class="rec-active-row" id="recActiveRow" style="display:none">
    <div class="rec-main-row">
      <div class="rec-dot"></div>
      <div class="rec-label">
        <span class="rec-state" id="recState">Recording</span>
        <span class="rec-hint" id="recHint"></span>
      </div>
      <span class="rec-timer" id="recTimer">0:00</span>
    </div>
    <div class="rec-controls">
      <button class="btn btn-ghost" id="recPauseBtn">⏸ Pause</button>
      <button class="btn" id="recStopBtn">⏹ Save</button>
      <button class="btn btn-ghost" id="recAbortBtn">✕ Cancel</button>
    </div>
  </div>
</div>

<!-- ── Right-click context menu ── -->
<div class="ctx-menu" id="ctxMenu">
  <div class="ctx-info" id="ctxDate"></div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" id="ctxColor"><span class="ctx-icon">🎨</span>Tag Color</div>
  <div class="ctx-item" id="ctxAttach"><span class="ctx-icon">🖼</span>Attach Image…</div>
  <div class="ctx-item" id="ctxPaste"><span class="ctx-icon">📋</span>Paste Image from Clipboard</div>
  <div class="ctx-item" id="ctxRecord"><span class="ctx-icon">🎙</span>Record Audio</div>
  <div class="ctx-sep"></div>
  <div class="ctx-item" id="ctxSelect"><span class="ctx-icon">✓</span>Select for Compare</div>
</div>

<!-- ── Color popup (triggered from context menu) ── -->
<div class="color-popup" id="colorPopup">
  <div class="color-dot none" data-color=""></div>
  <div class="color-dot" style="background:#ef4444" data-color="#ef4444"></div>
  <div class="color-dot" style="background:#f97316" data-color="#f97316"></div>
  <div class="color-dot" style="background:#eab308" data-color="#eab308"></div>
  <div class="color-dot" style="background:#22c55e" data-color="#22c55e"></div>
  <div class="color-dot" style="background:#3b82f6" data-color="#3b82f6"></div>
  <div class="color-dot" style="background:#a855f7" data-color="#a855f7"></div>
</div>

<!-- ── Image lightbox ── -->
<div class="lightbox" id="lightbox">
  <img id="lightboxImg" src="" alt="">
</div>

<script nonce="${nonce}">
(function() {
  const vscode = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────────────────────
  let allCommits = [];
  let fileCommits = [];
  let activeTab = 'all';
  let expanded = new Set();
  let loadingFiles = new Set();
  let filesCache = {};
  let notesCache = {};         // hash → { color?, images: [{name,uri}], audios: [{name,uri}] }
  let selected = [];           // max 2 for compare
  let colorTarget = null;
  let ctxHash = null;          // commit targeted by last right-click
  let imagesOpen = new Set();  // hashes with image strip expanded
  let audiosOpen = new Set();  // hashes with audio player expanded
  let currentFilePath = null;  // relative path of the file shown in file tab
  let pendingAutoOpen = null;  // hash waiting for files to load before auto-opening diff

  // ── Recording state ──────────────────────────────────────────────────────────
  let recHash = null;
  let recPaused = false;
  let recTimerInterval = null;
  let recSeconds = 0;

  // ── DOM refs ─────────────────────────────────────────────────────────────────
  const tabAll     = document.getElementById('tabAll');
  const tabFile    = document.getElementById('tabFile');
  const fileTabLabel = document.getElementById('fileTabLabel');
  const viewMain   = document.getElementById('viewMain');
  const viewCompare = document.getElementById('viewCompare');
  const commitList = document.getElementById('commitList');
  const compareBar = document.getElementById('compareBar');
  const compareLabel = document.getElementById('compareLabel');
  const compareBtn = document.getElementById('compareBtn');
  const clearSelBtn = document.getElementById('clearSelBtn');
  const backBtn    = document.getElementById('backBtn');
  const compareList = document.getElementById('compareList');
  const compareHeaderText = document.getElementById('compareHeaderText');
  const colorPopup = document.getElementById('colorPopup');
  const ctxMenu    = document.getElementById('ctxMenu');
  const ctxDate    = document.getElementById('ctxDate');
  const lightbox   = document.getElementById('lightbox');
  const lightboxImg = document.getElementById('lightboxImg');
  const recPanel    = document.getElementById('recPanel');
  const recState    = document.getElementById('recState');
  const recHint     = document.getElementById('recHint');
  const recTimer    = document.getElementById('recTimer');
  const recReadyRow  = document.getElementById('recReadyRow');
  const recActiveRow = document.getElementById('recActiveRow');
  const recStartBtn  = document.getElementById('recStartBtn');
  const recPauseBtn  = document.getElementById('recPauseBtn');
  const recStopBtn   = document.getElementById('recStopBtn');
  const recCancelBtn = document.getElementById('recCancelBtn');
  const recAbortBtn  = document.getElementById('recAbortBtn');
  const recDeviceSel = document.getElementById('recDeviceSel');

  // ── Tabs ─────────────────────────────────────────────────────────────────────
  tabAll.addEventListener('click', () => { activeTab = 'all'; renderTabs(); renderCommits(); });
  tabFile.addEventListener('click', () => { activeTab = 'file'; renderTabs(); renderCommits(); });
  function renderTabs() {
    tabAll.classList.toggle('active', activeTab === 'all');
    tabFile.classList.toggle('active', activeTab === 'file');
  }

  // ── Compare bar ───────────────────────────────────────────────────────────────
  compareBtn.addEventListener('click', () => {
    if (selected.length < 2) { return; }
    vscode.postMessage({ type: 'getCompareFiles', hash1: selected[0], hash2: selected[1] });
  });
  clearSelBtn.addEventListener('click', () => { selected = []; updateCompareBar(); renderCommits(); });
  backBtn.addEventListener('click', () => {
    showView('main'); selected = []; updateCompareBar(); renderCommits();
  });
  function updateCompareBar() {
    const on = selected.length === 2;
    compareBar.classList.toggle('visible', on);
    if (on) { compareLabel.textContent = selected.map(h => h.substring(0,7)).join(' ↔ '); }
  }
  function showView(name) {
    viewMain.classList.toggle('active', name === 'main');
    viewCompare.classList.toggle('active', name === 'compare');
  }

  // ── Context menu ─────────────────────────────────────────────────────────────
  function openCtxMenu(hash, x, y, date) {
    ctxHash = hash;
    ctxDate.textContent = date || '';
    const w = 210, h = 160;
    ctxMenu.style.left = Math.min(x, window.innerWidth  - w - 6) + 'px';
    ctxMenu.style.top  = Math.min(y, window.innerHeight - h - 6) + 'px';
    ctxMenu.classList.add('open');
  }
  function closeAll() {
    ctxMenu.classList.remove('open');
    colorPopup.classList.remove('open');
    colorTarget = null;
  }
  document.addEventListener('click', closeAll);
  document.addEventListener('contextmenu', (e) => {
    // Close if right-clicking outside a commit
    if (!e.target.closest('.commit')) { closeAll(); }
  });

  document.getElementById('ctxColor').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ctxHash) { return; }
    colorTarget = ctxHash;
    ctxMenu.classList.remove('open');
    // Position color popup near the menu
    const rect = ctxMenu.getBoundingClientRect();
    colorPopup.style.top  = rect.top + 'px';
    colorPopup.style.left = (rect.right + 6) + 'px';
    colorPopup.classList.add('open');
  });

  document.getElementById('ctxAttach').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ctxHash) { return; }
    vscode.postMessage({ type: 'attachImage', hash: ctxHash });
    closeAll();
  });

  document.getElementById('ctxPaste').addEventListener('click', (e) => {
    e.stopPropagation();
    const hash = ctxHash;
    closeAll();
    if (!hash) { return; }
    // No dataUrl — extension reads the native clipboard via osascript/powershell
    vscode.postMessage({ type: 'pasteImage', hash });
  });

  document.getElementById('ctxSelect').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ctxHash) { return; }
    toggleSelect(ctxHash);
    closeAll();
  });

  document.getElementById('ctxRecord').addEventListener('click', (e) => {
    e.stopPropagation();
    const hash = ctxHash;
    closeAll();
    if (!hash) { return; }
    startRecording(hash);
  });

  // ── Recording controls ────────────────────────────────────────────────────────
  recStartBtn.addEventListener('click',  (e) => { e.stopPropagation(); beginRecording(); });
  recPauseBtn.addEventListener('click',  (e) => { e.stopPropagation(); togglePause(); });
  recStopBtn.addEventListener('click',   (e) => { e.stopPropagation(); stopRecording(); });
  recCancelBtn.addEventListener('click', (e) => { e.stopPropagation(); cancelRecording(); });
  recAbortBtn.addEventListener('click',  (e) => { e.stopPropagation(); cancelRecording(); });

  function startRecording(hash) {
    recHash = hash;
    recPaused = false;
    recSeconds = 0;
    recReadyRow.style.display = '';
    recActiveRow.style.display = 'none';
    recDeviceSel.innerHTML = '<option value="">Loading devices…</option>';
    recPanel.classList.remove('paused', 'error');
    recPanel.classList.add('open');
    vscode.postMessage({ type: 'listDevices' });
  }

  function beginRecording() {
    recPauseBtn.disabled = true;
    recStopBtn.disabled = true;
    recPauseBtn.textContent = '⏸ Pause';
    recState.textContent = 'Starting…';
    recHint.textContent = 'Initializing microphone';
    recTimer.textContent = '';
    recSeconds = 0;
    recReadyRow.style.display = 'none';
    recActiveRow.style.display = '';
    recPanel.classList.remove('paused', 'error');
    vscode.postMessage({ type: 'startRecording', hash: recHash, deviceId: recDeviceSel.value || undefined });
  }

  function togglePause() {
    if (recPaused) {
      vscode.postMessage({ type: 'resumeRecording' });
    } else {
      vscode.postMessage({ type: 'pauseRecording' });
    }
  }

  function stopRecording() {
    stopTimer();
    recState.textContent = 'Saving…';
    recHint.textContent = 'Processing audio';
    recPauseBtn.disabled = true;
    recStopBtn.disabled = true;
    vscode.postMessage({ type: 'stopRecording' });
  }

  function cancelRecording() {
    stopTimer();
    // Only send cancel if recording was actually started
    if (recActiveRow.style.display !== 'none') {
      vscode.postMessage({ type: 'cancelRecording' });
    }
    hideRecPanel();
  }

  function hideRecPanel() {
    recPanel.classList.remove('open', 'paused', 'error');
    recReadyRow.style.display = '';
    recActiveRow.style.display = 'none';
    recHash = null;
    recPaused = false;
  }

  function startTimer() {
    recTimerInterval = setInterval(() => {
      recSeconds++;
      const m = Math.floor(recSeconds / 60);
      const s = recSeconds % 60;
      recTimer.textContent = m + ':' + String(s).padStart(2, '0');
    }, 1000);
  }

  function stopTimer() {
    clearInterval(recTimerInterval);
    recTimerInterval = null;
  }

  // ── Color picker ──────────────────────────────────────────────────────────────
  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const color = dot.dataset.color || null;
      if (colorTarget) {
        notesCache[colorTarget] = notesCache[colorTarget] || {};
        if (color) { notesCache[colorTarget].color = color; }
        else        { delete notesCache[colorTarget].color; }
        vscode.postMessage({ type: 'setColor', hash: colorTarget, color });
        renderCommits();
      }
      colorPopup.classList.remove('open');
      colorTarget = null;
    });
  });

  // ── Clipboard paste ───────────────────────────────────────────────────────────
  // Context menu "Paste Image" → extension reads clipboard natively (no browser API needed).
  // Cmd+V keyboard shortcut → webview intercepts the paste event and sends the raw data.

  function sendBlob(hash, blob, mimeType) {
    const reader = new FileReader();
    reader.onload = () => {
      vscode.postMessage({ type: 'pasteImage', hash, dataUrl: reader.result, mimeType });
    };
    reader.readAsDataURL(blob);
  }

  // Cmd+V pastes to the last right-clicked commit
  document.addEventListener('paste', (e) => {
    if (!ctxHash) { return; }
    const items = Array.from(e.clipboardData?.items || []);
    const img = items.find(i => i.type.startsWith('image/'));
    if (!img) { return; }
    e.preventDefault();
    const blob = img.getAsFile();
    if (blob) { sendBlob(ctxHash, blob, img.type); }
  });

  // ── Lightbox ─────────────────────────────────────────────────────────────────
  lightbox.addEventListener('click', () => lightbox.classList.remove('open'));

  // ── Extension messages ────────────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'allCommits':
        allCommits = msg.commits;
        syncNotes(allCommits);
        if (activeTab === 'all') { renderCommits(); }
        break;
      case 'fileCommits':
        fileCommits = msg.commits;
        fileTabLabel.textContent = msg.fileName;
        currentFilePath = msg.filePath || null;
        pendingAutoOpen = null;
        syncNotes(fileCommits);
        activeTab = 'file';
        renderTabs();
        renderCommits();
        break;
      case 'commitFiles':
        filesCache[msg.hash] = msg.files;
        loadingFiles.delete(msg.hash);
        renderCommits();
        if (pendingAutoOpen === msg.hash) {
          pendingAutoOpen = null;
          autoOpenFileDiff(msg.hash);
        }
        break;
      case 'compareFiles':
        showCompareResults(msg.hash1, msg.hash2, msg.files);
        break;
      case 'imageAttached':
        if (!notesCache[msg.hash]) { notesCache[msg.hash] = {}; }
        if (!notesCache[msg.hash].images) { notesCache[msg.hash].images = []; }
        notesCache[msg.hash].images.push({ name: msg.imageName, uri: msg.webviewUri });
        renderCommits();
        break;
      case 'recordingStarted':
        recPauseBtn.style.display = msg.canPause === false ? 'none' : '';
        recPauseBtn.disabled = false;
        recStopBtn.disabled = false;
        recState.textContent = 'Recording';
        recHint.textContent = 'Speak now — press Save when done';
        recTimer.textContent = '0:00';
        recSeconds = 0;
        recPaused = false;
        startTimer();
        break;
      case 'deviceList':
        recDeviceSel.innerHTML = msg.devices.length
          ? msg.devices.map(d => '<option value="' + d.name + '">' + d.name + '</option>').join('')
          : '<option value="">No devices found</option>';
        break;
      case 'recordingPaused':
        stopTimer();
        recPaused = true;
        recState.textContent = 'Paused';
        recHint.textContent = 'Press Resume to continue';
        recPauseBtn.textContent = '▶ Resume';
        recPanel.classList.add('paused');
        break;
      case 'recordingResumed':
        startTimer();
        recPaused = false;
        recState.textContent = 'Recording';
        recHint.textContent = 'Speak now — press Save when done';
        recPauseBtn.textContent = '⏸ Pause';
        recPanel.classList.remove('paused');
        break;
      case 'recordingError':
        stopTimer();
        recState.textContent = 'Error';
        recHint.textContent = msg.message;
        recTimer.textContent = '';
        recPanel.classList.add('error');
        recPauseBtn.disabled = true;
        recStopBtn.disabled = true;
        break;
      case 'audioSaved':
        hideRecPanel();
        if (!notesCache[msg.hash]) { notesCache[msg.hash] = {}; }
        if (!notesCache[msg.hash].audios) { notesCache[msg.hash].audios = []; }
        notesCache[msg.hash].audios.push({ name: msg.audioName, uri: msg.webviewUri });
        renderCommits();
        break;
      case 'error':
        commitList.innerHTML = '<div class="error-msg">' + escHtml(msg.message) + '</div>';
        break;
    }
  });

  // syncNotes: extension sends {name,uri} objects for images and audios
  function syncNotes(commits) {
    commits.forEach(c => {
      if (!c.note) { return; }
      const existing = notesCache[c.hash];
      notesCache[c.hash] = {
        ...c.note,
        images: c.note.images && c.note.images.length
          ? c.note.images
          : existing?.images ?? [],
        audios: c.note.audios && c.note.audios.length
          ? c.note.audios
          : existing?.audios ?? []
      };
    });
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  function renderCommits() {
    const list = activeTab === 'all' ? allCommits : fileCommits;
    if (!list.length) {
      commitList.innerHTML = '<div class="status-msg">' +
        (activeTab === 'all' ? 'No commits found.' : 'No commits for this file.') + '</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach(c => frag.appendChild(buildCommitEl(c)));
    commitList.innerHTML = '';
    commitList.appendChild(frag);
  }

  function buildCommitEl(commit) {
    const hash = commit.hash;
    const note = notesCache[hash] || null;
    const isExpanded = expanded.has(hash);
    const isSelected = selected.includes(hash);
    const selIdx = selected.indexOf(hash);

    const el = document.createElement('div');
    el.className = 'commit' + (isExpanded ? ' expanded' : '') + (isSelected ? ' selected' : '');
    el.dataset.hash = hash;
    if (note?.color) { el.style.borderLeftColor = note.color; }

    const images = note?.images || [];
    const audios = note?.audios || [];
    const badgeStyle = note?.color ? ' style="background:' + note.color + '"' : '';
    const imgBadge = images.length
      ? '<span class="img-badge"' + badgeStyle + ' title="' + images.length + ' image' + (images.length > 1 ? 's' : '') + ' — click to toggle">' + images.length + '</span>'
      : '';
    const audBadge = audios.length
      ? '<span class="aud-badge" title="' + audios.length + ' recording' + (audios.length > 1 ? 's' : '') + ' — click to play">' + audios.length + '</span>'
      : '';

    el.innerHTML =
      '<div class="commit-top">' +
        '<span class="chevron">&#9654;</span>' +
        '<span class="select-badge">' + (selIdx >= 0 ? selIdx + 1 : '') + '</span>' +
        '<span class="commit-hash">' + escHtml(commit.shortHash) + '</span>' +
        '<span class="commit-msg">' + escHtml(commit.message) + '</span>' +
        imgBadge + audBadge +
      '</div>';

    // Image badge toggle
    if (images.length) {
      el.querySelector('.img-badge').addEventListener('click', (e) => {
        e.stopPropagation();
        if (imagesOpen.has(hash)) { imagesOpen.delete(hash); }
        else { imagesOpen.add(hash); }
        renderCommits();
      });
    }

    // Audio badge toggle
    if (audios.length) {
      el.querySelector('.aud-badge').addEventListener('click', (e) => {
        e.stopPropagation();
        if (audiosOpen.has(hash)) { audiosOpen.delete(hash); }
        else { audiosOpen.add(hash); }
        renderCommits();
      });
    }

    // Audio player (only when badge is toggled open)
    if (audios.length && audiosOpen.has(hash)) {
      const playerSection = document.createElement('div');
      playerSection.className = 'audio-player';
      audios.forEach((aud, idx) => {
        const uri = typeof aud === 'string' ? aud : aud.uri;

        // Hidden audio element — driven by custom UI
        const audio = new Audio(uri);

        // Row
        const row = document.createElement('div');
        row.className = 'ap-row';

        // Play/pause button
        const playBtn = document.createElement('button');
        playBtn.className = 'ap-play';
        playBtn.title = 'Play / Pause';
        const iconPlay = '<svg width="9" height="10" viewBox="0 0 9 10" fill="white"><polygon points="0,0 9,5 0,10"/></svg>';
        const iconPause = '<svg width="9" height="10" viewBox="0 0 9 10" fill="white"><rect x="0" y="0" width="3" height="10"/><rect x="6" y="0" width="3" height="10"/></svg>';
        playBtn.innerHTML = iconPlay;

        // Track + progress
        const track = document.createElement('div');
        track.className = 'ap-track';

        const progress = document.createElement('input');
        progress.type = 'range';
        progress.className = 'ap-progress';
        progress.min = '0';
        progress.max = '100';
        progress.value = '0';
        progress.step = '0.1';

        track.appendChild(progress);

        // Time display
        const timeEl = document.createElement('span');
        timeEl.className = 'ap-time';
        timeEl.textContent = '0:00 / –:––';

        const fmt = (s) => {
          if (!isFinite(s)) { return '–:––'; }
          const m = Math.floor(s / 60);
          return m + ':' + String(Math.floor(s % 60)).padStart(2, '0');
        };

        audio.addEventListener('loadedmetadata', () => {
          timeEl.textContent = '0:00 / ' + fmt(audio.duration);
          progress.max = String(audio.duration);
        });
        audio.addEventListener('timeupdate', () => {
          if (!progress.matches(':active')) {
            progress.value = String(audio.currentTime);
          }
          timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
        });
        audio.addEventListener('ended', () => {
          playBtn.innerHTML = iconPlay;
          progress.value = '0';
          timeEl.textContent = '0:00 / ' + fmt(audio.duration);
        });

        playBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (audio.paused) {
            // Pause all other players in this section
            playerSection.querySelectorAll('.ap-play').forEach((btn, i) => {
              if (i !== idx) { btn.innerHTML = iconPlay; }
            });
            document.querySelectorAll('audio').forEach(a => a.pause());
            audio.play();
            playBtn.innerHTML = iconPause;
          } else {
            audio.pause();
            playBtn.innerHTML = iconPlay;
          }
        });

        progress.addEventListener('input', (e) => {
          e.stopPropagation();
          audio.currentTime = Number(progress.value);
        });

        // Delete button
        const audioName = typeof aud === 'string' ? aud : aud.name;
        const delBtn = document.createElement('button');
        delBtn.className = 'ap-del';
        delBtn.title = 'Remove recording';
        delBtn.innerHTML = '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><line x1="1" y1="1" x2="7" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="7" y1="1" x2="1" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.pause();
          if (notesCache[hash]?.audios) {
            notesCache[hash].audios = notesCache[hash].audios.filter(a => (typeof a === 'string' ? a : a.name) !== audioName);
          }
          vscode.postMessage({ type: 'removeAudio', hash, audioName });
          renderCommits();
        });

        row.appendChild(playBtn);
        row.appendChild(track);
        row.appendChild(timeEl);
        row.appendChild(delBtn);
        playerSection.appendChild(row);
      });
      el.appendChild(playerSection);
    }

    // Images strip (only when badge is toggled open)
    if (images.length && imagesOpen.has(hash)) {
      const strip = document.createElement('div');
      strip.className = 'images-strip';
      images.forEach(img => {
        const uri  = typeof img === 'string' ? img : img.uri;
        const name = typeof img === 'string' ? img : img.name;
        const image = document.createElement('img');
        image.src = uri;
        image.title = name;
        image.addEventListener('click', (e) => {
          e.stopPropagation();
          lightboxImg.src = uri;
          lightbox.classList.add('open');
        });
        strip.appendChild(image);
      });
      el.appendChild(strip);
    }

    // Files list
    if (isExpanded) {
      const fileSection = document.createElement('div');
      fileSection.className = 'file-list';
      if (loadingFiles.has(hash)) {
        fileSection.innerHTML = '<div class="loading-files">Loading files…</div>';
      } else if (filesCache[hash]) {
        const hdr = document.createElement('div');
        hdr.className = 'file-list-header';
        hdr.textContent = 'Changed files';
        fileSection.appendChild(hdr);
        filesCache[hash].forEach(f => {
          const fi = document.createElement('div');
          fi.className = 'file-item';
          fi.innerHTML =
            '<span class="file-status status-' + f.status + '">' + f.status + '</span>' +
            '<span class="file-path" title="' + escHtml(f.path) + '">' + escHtml(f.path) + '</span>';
          fi.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'openDiff', hash, filePath: f.path });
          });
          fileSection.appendChild(fi);
        });
      }
      el.appendChild(fileSection);
    }

    // Left-click: expand/collapse or Cmd+click to select
    el.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey) { toggleSelect(hash); }
      else { toggleExpand(hash); }
    });

    // Right-click: context menu (pass date so it shows in the menu)
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtxMenu(hash, e.clientX, e.clientY, commit.date);
    });

    return el;
  }

  function toggleExpand(hash) {
    if (expanded.has(hash)) { expanded.delete(hash); }
    else {
      expanded.add(hash);
      if (!filesCache[hash] && !loadingFiles.has(hash)) {
        loadingFiles.add(hash);
        vscode.postMessage({ type: 'getCommitFiles', hash });
        // Files not yet loaded — fire diff once they arrive
        if (activeTab === 'file' && currentFilePath) { pendingAutoOpen = hash; }
      } else if (activeTab === 'file' && currentFilePath) {
        // Files already cached — open diff immediately
        autoOpenFileDiff(hash);
      }
    }
    renderCommits();
  }

  function autoOpenFileDiff(hash) {
    if (!currentFilePath) { return; }
    const files = filesCache[hash];
    if (!files) { return; }
    // Find the entry matching the current file (exact or suffix match)
    const match = files.find(f => f.path === currentFilePath) ||
                  files.find(f => currentFilePath.endsWith(f.path) || f.path.endsWith(currentFilePath));
    if (match) {
      vscode.postMessage({ type: 'openDiff', hash, filePath: match.path });
    }
  }

  function toggleSelect(hash) {
    const idx = selected.indexOf(hash);
    if (idx !== -1) { selected.splice(idx, 1); }
    else { if (selected.length >= 2) { selected.shift(); } selected.push(hash); }
    updateCompareBar();
    renderCommits();
  }

  // ── Compare results ───────────────────────────────────────────────────────────
  function showCompareResults(hash1, hash2, files) {
    compareHeaderText.textContent = hash1.substring(0,7) + ' ↔ ' + hash2.substring(0,7);
    compareList.innerHTML = '';
    if (!files || !files.length) {
      compareList.innerHTML = '<div class="status-msg">No differences found.</div>';
    } else {
      files.forEach(f => {
        const fi = document.createElement('div');
        fi.className = 'file-item';
        fi.innerHTML =
          '<span class="file-status status-' + f.status + '">' + f.status + '</span>' +
          '<span class="file-path" title="' + escHtml(f.path) + '">' + escHtml(f.path) + '</span>';
        fi.addEventListener('click', () => {
          vscode.postMessage({ type: 'openCompareDiff', hash1, hash2, filePath: f.path });
        });
        compareList.appendChild(fi);
      });
    }
    showView('compare');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
