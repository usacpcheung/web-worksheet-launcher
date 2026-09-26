// Shared by package upload, browser import and Play validation. Do not impose
// the editor's generated-ID spelling on existing packages.
export function validateSceneIdentity(project) {
  const errors = [];
  if (!Array.isArray(project?.scenes)) return ['Project scenes are missing.'];
  const seen = new Set();
  for (const [index, scene] of project.scenes.entries()) {
    const id = scene?.id;
    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`Scene ${index + 1} is missing an ID. scenes[${index}].id must be a non-empty string.`);
    } else if (seen.has(id)) {
      errors.push(`Scene ID "${id}" is duplicated. scenes[${index}].id must be unique.`);
    } else {
      seen.add(id);
    }
  }
  return errors;
}
