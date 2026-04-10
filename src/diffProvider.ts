import * as vscode from 'vscode';

export class GitMemoirContentProvider implements vscode.TextDocumentContentProvider {
    private _contents = new Map<string, string>();

    set(uri: vscode.Uri, content: string) {
        this._contents.set(uri.toString(), content);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this._contents.get(uri.toString()) ?? '';
    }
}
