export interface CommitInfo {
    hash: string;
    shortHash: string;
    message: string;
    author: string;
    date: string;
    note: CommitNote | null;
}

export interface FileChange {
    status: string; // M=Modified, A=Added, D=Deleted, R=Renamed
    path: string;
}

export interface AudioEntry {
    fileName: string;
    filePath?: string; // relative repo path; set when recorded from Current File tab
}

export interface CommitNote {
    color?: string;
    images?: string[]; // filenames inside .vscode/git-notes/images/
    audios?: AudioEntry[]; // entries inside .vscode/git-notes/audio/
}

export interface NotesData {
    [hash: string]: CommitNote;
}
