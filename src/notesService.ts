import * as fs from 'fs';
import * as path from 'path';
import { NotesData, CommitNote } from './types';

export class NotesService {
    private notesDir: string;
    private notesFile: string;
    readonly imagesDir: string;

    constructor(workspaceRoot: string) {
        this.notesDir = path.join(workspaceRoot, '.vscode', 'git-notes');
        this.notesFile = path.join(this.notesDir, 'notes.json');
        this.imagesDir = path.join(this.notesDir, 'images');
    }

    private ensureDirs() {
        fs.mkdirSync(this.imagesDir, { recursive: true });
    }

    load(): NotesData {
        this.ensureDirs();
        if (!fs.existsSync(this.notesFile)) { return {}; }
        try {
            return JSON.parse(fs.readFileSync(this.notesFile, 'utf8'));
        } catch {
            return {};
        }
    }

    private save(data: NotesData) {
        this.ensureDirs();
        fs.writeFileSync(this.notesFile, JSON.stringify(data, null, 2), 'utf8');
    }

    setColor(hash: string, color: string | null) {
        const data = this.load();
        if (!data[hash]) { data[hash] = {}; }
        if (color) {
            data[hash].color = color;
        } else {
            delete data[hash].color;
        }
        if (!data[hash].color && !data[hash].images?.length) {
            delete data[hash];
        }
        this.save(data);
    }

    addImage(hash: string, sourcePath: string): string {
        this.ensureDirs();
        const ext = path.extname(sourcePath);
        const destName = `${hash.substring(0, 7)}-${Date.now()}${ext}`;
        const destPath = path.join(this.imagesDir, destName);
        fs.copyFileSync(sourcePath, destPath);

        const data = this.load();
        if (!data[hash]) { data[hash] = {}; }
        if (!data[hash].images) { data[hash].images = []; }
        data[hash].images!.push(destName);
        this.save(data);

        return destPath;
    }

    removeImage(hash: string, imageName: string) {
        const data = this.load();
        if (data[hash]?.images) {
            data[hash].images = data[hash].images!.filter(n => n !== imageName);
            const imgPath = path.join(this.imagesDir, imageName);
            if (fs.existsSync(imgPath)) { fs.unlinkSync(imgPath); }
        }
        if (!data[hash]?.color && !data[hash]?.images?.length) {
            delete data[hash];
        }
        this.save(data);
    }

    addImageFromBuffer(hash: string, buffer: Buffer, ext: string): string {
        this.ensureDirs();
        const destName = `${hash.substring(0, 7)}-${Date.now()}${ext}`;
        const destPath = path.join(this.imagesDir, destName);
        fs.writeFileSync(destPath, buffer);

        const data = this.load();
        if (!data[hash]) { data[hash] = {}; }
        if (!data[hash].images) { data[hash].images = []; }
        data[hash].images!.push(destName);
        this.save(data);

        return destPath;
    }

    enrichCommits<T extends { hash: string; note: null | import('./types').CommitNote }>(
        commits: T[], notes: NotesData
    ): T[] {
        return commits.map(c => ({ ...c, note: notes[c.hash] ?? null }));
    }
}
