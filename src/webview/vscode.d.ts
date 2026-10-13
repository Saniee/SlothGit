// Globals VS Code provides inside a webview page.

interface VsCodeApi<Message> {
  postMessage(message: Message): void;
}

declare function acquireVsCodeApi<Message>(): VsCodeApi<Message>;
