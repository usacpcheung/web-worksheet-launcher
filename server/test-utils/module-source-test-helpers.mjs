export function normalizeTestSource(source) {
  return String(source).replace(/\r\n/g, '\n');
}

export function rewriteModuleSourceForTests(source, rules = []) {
  let rewrittenSource = normalizeTestSource(source);

  for (const [index, rule] of rules.entries()) {
    const { pattern, replacement, name = `rule_${index + 1}`, required = true } = rule;
    const nextSource = rewrittenSource.replace(pattern, replacement);
    if (required && nextSource === rewrittenSource) {
      throw new Error(`Module test source rewrite did not match: ${name}`);
    }
    rewrittenSource = nextSource;
  }

  return rewrittenSource;
}
