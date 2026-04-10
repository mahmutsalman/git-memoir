import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { CommitInfo, FileChange, NotesData } from './types';

const execAsync = promisify(exec);

// Use unit-separator (0x1f) and record-separator (0x1e) to avoid conflicts with commit messages
const FS = '\x1f';
const RS = '\x1e';

export class GitService {
    constructor(private repoRoot: string) {}

    private async run(cmd: string): Promise<string> {
        const { stdout } = await execAsync(cmd, {
            cwd: this.repoRoot,
            maxBuffer: 10 * 1024 * 1024
        });
        return stdout;
    }

    async getAllCommits(limit = 200): Promise<CommitInfo[]> {
        const fmt = `%H${FS}%h${FS}%s${FS}%an${FS}%ar${RS}`;
        const out = await this.run(`git log -${limit} --no-merges --format="${fmt}"`);
        return this.parseLog(out);
    }

    async getFileCommits(absFilePath: string, limit = 100): Promise<CommitInfo[]> {
        const rel = path.relative(this.repoRoot, absFilePath);
        const fmt = `%H${FS}%h${FS}%s${FS}%an${FS}%ar${RS}`;
        const out = await this.run(`git log -${limit} --follow --format="${fmt}" -- "${rel}"`);
        return this.parseLog(out);
    }

    private parseLog(out: string): CommitInfo[] {
        return out.split(RS).map(r => r.trim()).filter(Boolean).map(record => {
            const [hash, shortHash, message, author, date] = record.split(FS);
            return { hash, shortHash, message, author, date, note: null };
        });
    }

    async getCommitFiles(hash: string): Promise<FileChange[]> {
        const out = await this.run(`git diff-tree --no-commit-id -r --name-status ${hash}`);
        return out.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\t');
            return { status: parts[0].trim(), path: parts[1]?.trim() ?? '' };
        });
    }

    async getFileAtCommit(hash: string, relPath: string): Promise<string> {
        try {
            return await this.run(`git show "${hash}:${relPath}"`);
        } catch {
            return '';
        }
    }

    async getFileAtParentCommit(hash: string, relPath: string): Promise<string> {
        try {
            const parentRaw = await this.run(`git rev-parse "${hash}^"`);
            const parentHash = parentRaw.trim();
            return await this.getFileAtCommit(parentHash, relPath);
        } catch {
            return ''; // first commit — no parent
        }
    }

    async getFilesBetweenCommits(hash1: string, hash2: string): Promise<FileChange[]> {
        const out = await this.run(`git diff --name-status ${hash1} ${hash2}`);
        return out.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\t');
            return { status: parts[0].trim(), path: parts[1]?.trim() ?? '' };
        });
    }
}
