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

export interface CommitNote {
    color?: string;
    images?: string[]; // filenames inside .vscode/git-notes/images/
}

export interface NotesData {
    [hash: string]: CommitNote;
}
