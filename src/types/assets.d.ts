// Page markup (src/webview/<page>/body.html), inlined as text by esbuild's text loader.
declare module '*.html' {
  const content: string;
  export default content;
}
