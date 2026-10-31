// Optional extension of existing worksheet options; answer values remain backward compatible.
export const OPTION_IMAGE_DESCRIPTION_LIMIT = 200;
export function optionImageRef(option) {
  return (Array.isArray(option?.mediaRefs) ? option.mediaRefs : []).find(ref =>
    ref?.usage === 'option_image' && typeof ref.assetId === 'string' && ref.assetId.trim()) || null;
}
export function optionHasContent(option) {
  return Boolean(String(option && typeof option === 'object' ? (option.label ?? option.value ?? '') : (option ?? '')).trim() || optionImageRef(option));
}
export function imageDescription(value) {
  return Array.from(typeof value === 'string' ? value : '').slice(0, OPTION_IMAGE_DESCRIPTION_LIMIT).join('');
}
export function hasOptionImages(blocks) {
  return (blocks || []).some(block => block?.responseConfig?.options?.some(optionImageRef));
}
export function assertOptionImages(blocks, assets) {
  for (const block of blocks || []) {
    if (block?.responseConfig?.inputType !== 'multiple_choice') continue;
    const values = new Set();
    for (const option of block.responseConfig.options || []) {
      if (!optionHasContent(option)) throw new Error('Each option needs text or an image.');
      const value = String(option?.value ?? option?.label ?? option ?? '');
      if (!value.trim() || values.has(value)) throw new Error('Options require unique, non-empty answer values.');
      values.add(value);
      if (option?.imageDescription !== undefined && (typeof option.imageDescription !== 'string' || Array.from(option.imageDescription).length > OPTION_IMAGE_DESCRIPTION_LIMIT)) {
        throw new Error('Option image description must contain at most 200 characters.');
      }
      const refs = (option?.mediaRefs || []).filter(ref => ref?.usage === 'option_image');
      if (refs.length > 1) throw new Error('Only one image is allowed per option.');
      for (const ref of refs) {
        const asset = assets.get(ref.assetId);
        if (!asset || asset.kind !== 'image' || asset.usage !== 'option_image') throw new Error('Missing or invalid option image asset.');
        if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(asset.mimeType)) throw new Error('Unsupported option image format.');
        if (asset.byteLength != null && (!Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0)) throw new Error('Option image must not be empty.');
        if (asset.byteLength > 8 * 1024 * 1024) throw new Error('Option image exceeds 8 MB.');
      }
    }
  }
}
