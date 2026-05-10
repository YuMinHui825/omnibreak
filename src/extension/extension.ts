import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  const ch = vscode.window.createOutputChannel('OmniBreak');

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('omnibreak', {
      async createDebugAdapterDescriptor(session) {
        const c = session.configuration;
        ch.appendLine(`OmniBreak: ${c.targetHost || c.robotHost}:${c.targetPort || c.robotPort || 2345}`);
        const daScript = context.asAbsolutePath('out/debugAdapter/debugAdapter.js');
        return new vscode.DebugAdapterExecutable('node', [daScript]);
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('omnibreak.showOutput', () => ch.show())
  );

  context.subscriptions.push(ch);
}

export function deactivate(): void {}
