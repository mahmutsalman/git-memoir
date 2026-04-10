import * as vscode from 'vscode';
import { MainViewProvider } from './mainViewProvider';
import { GitMemoirContentProvider } from './diffProvider';

export function activate(context: vscode.ExtensionContext) {
    const diffProvider = new GitMemoirContentProvider();
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('git-memoir', diffProvider)
    );

    const provider = new MainViewProvider(context, diffProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('gitMemoir.mainView', provider)
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitMemoir.showFileHistory', (uri?: vscode.Uri) => {
            const filePath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
            if (filePath) {
                vscode.commands.executeCommand('gitMemoir.mainView.focus');
                provider.showFileHistory(filePath);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('gitMemoir.refresh', () => {
            provider.refresh();
        })
    );
}

export function deactivate() {}
