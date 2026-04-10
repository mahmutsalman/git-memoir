import { exec } from 'child_process';
import { promisify } from 'util';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export interface ClipboardImage {
    data: Buffer;
    ext: string;
}

export async function getClipboardImage(): Promise<ClipboardImage | null> {
    const platform = os.platform();
    const tempFile = path.join(os.tmpdir(), `git-memoir-clip-${Date.now()}.png`);

    try {
        switch (platform) {
            case 'darwin':
                await execAsync(
                    `osascript -e 'set f to (open for access POSIX file "${tempFile}" with write permission)' ` +
                    `-e 'write (the clipboard as «class PNGf») to f' ` +
                    `-e 'close access f'`,
                    { timeout: 8000 }
                );
                break;

            case 'win32': {
                const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
                    `if ([System.Windows.Forms.Clipboard]::ContainsImage()) { ` +
                    `[System.Windows.Forms.Clipboard]::GetImage().Save('${tempFile.replace(/\\/g, '\\\\')}', ` +
                    `[System.Drawing.Imaging.ImageFormat]::Png) }`;
                await execAsync(`powershell -Command "${ps}"`, { timeout: 8000 });
                break;
            }

            case 'linux':
                try {
                    await execAsync(`xclip -selection clipboard -t image/png -o > "${tempFile}"`, { timeout: 8000 });
                } catch {
                    await execAsync(`wl-paste --type image/png > "${tempFile}"`, { timeout: 8000 });
                }
                break;

            default:
                return null;
        }

        if (!fs.existsSync(tempFile)) { return null; }
        const data = fs.readFileSync(tempFile);
        if (data.length === 0) { return null; }
        return { data, ext: '.png' };

    } catch {
        return null;
    } finally {
        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }
}
