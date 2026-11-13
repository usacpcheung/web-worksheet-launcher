// Build entry only. The committed vendor bundle is loaded exclusively by the editor.
import { Editor, Mark, Extension, Node } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Plugin } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
const RedText = Mark.create({
  name: 'redText',
  parseHTML() { return [{ style: 'color', getAttrs: value => ['#b42318', 'rgb(180, 35, 24)', 'red', '#ff0000', 'rgb(255, 0, 0)'].includes(value.toLowerCase()) ? {} : false }]; },
  renderHTML() { return ['span', { style: 'color: #b42318' }, 0]; },
});
export function createEditor(options) {
  const { acceptDocument, blankNode = false, ...editorOptions } = options;
  const AnswerBlank = Node.create({ name: 'answerBlank', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes() { return { data: { default: null } }; },
    addCommands() { return { closeBlankHistory: () => ({ tr, dispatch }) => { if (dispatch) closeHistory(tr); return true; } }; },
    parseHTML() { return []; },
    renderHTML({node}) { return ['span', { class: 'editor-blank-mark', 'data-blank-id': node.attrs.data.id }, node.attrs.data.text || '…']; },
    renderText({node}) { return node.attrs.data?.text || ''; },
  });
  const DocumentBoundary = Extension.create({
    name: 'worksheetDocumentBoundary',
    addProseMirrorPlugins() {
      return [new Plugin({ filterTransaction: transaction => !transaction.docChanged || acceptDocument(transaction.doc.toJSON()) })];
    },
  });
  return new Editor({ ...editorOptions, extensions: [StarterKit.configure({
    heading: { levels: [2, 3, 4] }, code: false, codeBlock: false, horizontalRule: false,
    link: false, strike: false, trailingNode: false,
  }), RedText, DocumentBoundary, ...(blankNode ? [AnswerBlank] : [])], enableInputRules: false, enablePasteRules: false });
}
