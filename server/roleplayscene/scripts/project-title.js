export const MAX_PROJECT_TITLE_LENGTH = 40;

// Single-line text inputs strip line breaks. Retain the raw saved title when
// its displayed value is unchanged, including titles from older packages.
export function projectTitleInputValue(value) {
  return String(value ?? '').replace(/[\r\n]/g, '');
}

export function canEditProjectTitle(value, previousTitle) {
  return typeof value === 'string'
    && (projectTitleInputValue(value) === projectTitleInputValue(previousTitle)
      || Array.from(value).length <= MAX_PROJECT_TITLE_LENGTH);
}
