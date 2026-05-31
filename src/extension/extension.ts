import * as vscode from 'vscode';
import { SidebarView } from '../panel/SidebarView';
import { VIEW_ID } from '../shared/constants';

let sidebar: SidebarView | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const ch = vscode.window.createOutputChannel('OmniBreak');
  sidebar = new SidebarView(context, context.secrets);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, sidebar),
  );

  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('omnibreak', {
      async createDebugAdapterDescriptor(session) {
        const c = session.configuration;
        ch.appendLine(`OmniBreak: ${c.targetHost || c.robotHost}:${c.targetPort || c.robotPort || 2345}`);
        const daScript = context.asAbsolutePath('out/debugAdapter/debugAdapter.js');
        return new vscode.DebugAdapterExecutable('node', [daScript]);
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('omnibreak.showOutput', () => ch.show()),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('omnibreak.generateReport', () => {
      ch.appendLine('=== OmniBreak Diagnostic Report ===');
      ch.appendLine(`Extension: ${context.extension.id} v${context.extension.packageJSON.version}`);
      ch.appendLine(`VSCode: ${vscode.version}`);
      ch.appendLine(`Platform: ${process.platform} ${process.arch}`);
      ch.show();
    }),
  );

  context.subscriptions.push(ch);

  // Auto-disconnect on deactivation
  context.subscriptions.push({
    dispose: async () => {
      ch.appendLine('[OmniBreak] Deactivating — closing connections...');
      if (sidebar) {
        await sidebar.orchestrator.stop();
        ch.appendLine('[OmniBreak] Connections closed.');
      }
      ch.appendLine('[OmniBreak] Deactivated.');
    },
  });

  ch.appendLine('[OmniBreak] Activated.');
}

export function deactivate(): void {
  sidebar = null;
}
