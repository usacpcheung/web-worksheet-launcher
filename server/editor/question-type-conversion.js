import { emptyBlankConfig, isFillInBlanks } from '../app/fill-in-blanks.js';
import { richTextField, worksheetTextToNodes, worksheetTextToPlain } from '../app/worksheet-text.js';

// Keep prompt attachments and audio source hashes when moving only its text.
function replacePromptText(prompt, field) {
  const { text, format, document, ...metadata } = prompt || {};
  return { ...metadata, ...field };
}

export function passageToPrompt(block) {
  const restore = nodes => nodes.flatMap(node => {
    if (node.tag === 'blank') {
      return node.original && node.text === node.initialText
        ? structuredClone(node.original)
        : [{ tag: 'text', text: node.text }];
    }
    return [{ ...node, ...(node.children ? { children: restore(node.children) } : {}) }];
  });
  const instructions = worksheetTextToPlain(block.prompt).trim()
    ? worksheetTextToNodes(block.prompt) : [];
  const passage = restore(block.responseConfig.passage.blocks);
  return replacePromptText(block.prompt, richTextField([...instructions, ...passage]));
}

export function questionTextConversion(block, nextType, placement = 'instructions') {
  const fromBlanks = isFillInBlanks(block.responseConfig);
  if (fromBlanks && nextType !== 'fill_in_blanks') return { prompt: passageToPrompt(block) };
  if (!fromBlanks && nextType === 'fill_in_blanks') {
    const responseConfig = emptyBlankConfig();
    if (placement === 'passage') {
      responseConfig.passage.blocks = worksheetTextToNodes(block.prompt);
      return { prompt: replacePromptText(block.prompt, { text: '' }), responseConfig };
    }
    return { prompt: block.prompt, responseConfig };
  }
  return { prompt: block.prompt };
}
