// Build entry only. The committed vendor bundle is loaded exclusively by the editor.
import { Editor, Mark, Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
const RedText = Mark.create({
  name: 'redText',
  parseHTML() { return [{ style: 'color', getAttrs: value => ['#b42318', 'rgb(180, 35, 24)', 'red', '#ff0000', 'rgb(255, 0, 0)'].includes(value.toLowerCase()) ? {} : false }]; },
  renderHTML() { return ['span', { style: 'color: #b42318' }, 0]; },
});
export function createEditor(options) {
  const { acceptDocument, ...editorOptions } = options;
  const DocumentBoundary = Extension.create({
    name: 'worksheetDocumentBoundary',
    addProseMirrorPlugins() {
      return [new Plugin({ filterTransaction: transaction => !transaction.docChanged || acceptDocument(transaction.doc.toJSON()) })];
    },
  });
  return new Editor({ ...editorOptions, extensions: [StarterKit.configure({
    heading: { levels: [2, 3, 4] }, code: false, codeBlock: false, horizontalRule: false,
    link: false, strike: false, trailingNode: false,
  }), RedText, DocumentBoundary], enableInputRules: false, enablePasteRules: false });
}
