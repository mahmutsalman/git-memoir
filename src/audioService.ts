import { spawn } from 'child_process';
import * as os from 'os';

const FFMPEG_CANDIDATES = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    'ffmpeg'
];

const SOX_CANDIDATES = [
    '/opt/homebrew/bin/sox',
    '/usr/local/bin/sox',
    '/usr/bin/sox',
    'C:\\Program Files\\sox\\sox.exe',
    'C:\\Program Files (x86)\\sox\\sox.exe',
    'sox'
];

export async function findSox(): Promise<string | null> {
    for (const candidate of SOX_CANDIDATES) {
        try {
            await new Promise<void>((resolve, reject) => {
                const proc = spawn(candidate, ['--version'], { stdio: 'ignore' });
                proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
                proc.on('error', reject);
            });
            return candidate;
        } catch {
            // try next
        }
    }
    return null;
}

export async function findFfmpeg(): Promise<string | null> {
    for (const candidate of FFMPEG_CANDIDATES) {
        try {
            await new Promise<void>((resolve, reject) => {
                const proc = spawn(candidate, ['-version'], { stdio: 'ignore' });
                proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
                proc.on('error', reject);
            });
            return candidate;
        } catch {
            // try next
        }
    }
    return null;
}

export interface AudioDevice {
    name: string;
    /** Passed directly to ffmpeg -i */
    ffmpegId: string;
}

/** List available audio input devices on the current platform. */
export async function listAudioDevices(ffmpeg: string): Promise<AudioDevice[]> {
    const platform = os.platform();

    return new Promise((resolve) => {
        let args: string[];
        if (platform === 'darwin') {
            args = ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
        } else if (platform === 'linux') {
            args = ['-f', 'pulse', '-list_devices', 'true', '-i', 'dummy'];
        } else {
            // Windows DirectShow
            args = ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
        }

        const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
        proc.on('close', () => {
            resolve(parseDevices(platform, stderr));
        });
        proc.on('error', () => resolve([]));
    });
}

function parseDevices(platform: string, stderr: string): AudioDevice[] {
    const devices: AudioDevice[] = [];
    const lines = stderr.split('\n');

    if (platform === 'darwin') {
        // After the "AVFoundation audio devices:" line, parse [N] Device Name
        let inAudio = false;
        for (const line of lines) {
            if (line.includes('AVFoundation audio devices')) { inAudio = true; continue; }
            if (inAudio && line.includes('AVFoundation video devices')) { break; }
            if (inAudio) {
                const m = line.match(/\[(\d+)\]\s+(.+)/);
                if (m) {
                    devices.push({ name: m[2].trim(), ffmpegId: `:${m[1]}` });
                }
            }
        }
    } else if (platform === 'win32') {
        // After "DirectShow audio devices", parse lines with "device name"
        let inAudio = false;
        for (const line of lines) {
            if (line.includes('DirectShow audio devices')) { inAudio = true; continue; }
            if (inAudio && line.includes('DirectShow video devices')) { break; }
            if (inAudio) {
                const m = line.match(/"([^"]+)"/);
                if (m) {
                    devices.push({ name: m[1].trim(), ffmpegId: `audio=${m[1].trim()}` });
                }
            }
        }
    } else {
        // Linux pulse — basic fallback
        devices.push({ name: 'Default', ffmpegId: 'default' });
        for (const line of lines) {
            const m = line.match(/\*?\s*(alsa_input\S+)/);
            if (m) { devices.push({ name: m[1], ffmpegId: m[1] }); }
        }
    }

    return devices;
}

/** Build the ffmpeg input args for the given platform and device ffmpegId. */
export function buildInputArgs(platform: string, ffmpegId: string): string[] {
    if (platform === 'darwin') {
        return ['-f', 'avfoundation', '-i', ffmpegId];
    } else if (platform === 'linux') {
        return ['-f', 'pulse', '-i', ffmpegId];
    } else {
        return ['-f', 'dshow', '-i', ffmpegId];
    }
}

/**
 * Build sox args for recording on macOS (CoreAudio) or other platforms.
 * deviceName is the human-readable device name (e.g. "MacBook Pro Microphone").
 * On Windows/Linux sox uses the default device (-d).
 */
export function buildSoxArgs(platform: string, deviceName: string, outPath: string): string[] {
    if (platform === 'darwin') {
        return [
            '-t', 'coreaudio', deviceName,
            '-r', '48000', '-b', '16', '-c', '1',
            outPath,
            'highpass', '120',
            'lowpass', '3400',
            'compand', '0.05,0.5', '-inf,-68,-inf,-68,-30', '-5', '-60', '0.2'
        ];
    } else {
        // Windows / Linux: use default input device
        return [
            '-d',
            '-r', '48000', '-b', '16', '-c', '1',
            outPath,
            'highpass', '120',
            'lowpass', '3400',
            'compand', '0.05,0.5', '-inf,-68,-inf,-68,-30', '-5', '-60', '0.2'
        ];
    }
}
