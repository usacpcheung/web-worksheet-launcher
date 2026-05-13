const translations = {
  en: {
    toolbar: {
      appName: 'RolePlayScene',
      edit: 'Edit',
      play: 'Play',
      import: 'Import',
      export: 'Export',
      importTitle: 'Import project (.json or .zip)',
      exportTitle: 'Export project archive (.zip)',
      languageLabel: 'Language',
      localeNames: {
        en: 'English',
        'zh-TW': '繁體中文',
      },
      dismissMessage: 'Dismiss message',
    },
    server: {
      signIn: 'Sign in',
      save: 'Save to Server',
      saving: 'Saving...',
      manage: 'Manage Drafts',
      refreshing: 'Refreshing...',
      refresh: 'Refresh',
      close: 'Close',
      cancel: 'Cancel',
      statusChecking: 'Server: checking...',
      statusReady: 'Server: ready ({user})',
      statusNotReady: 'Server: sign in needed',
      signedInUserFallback: 'signed in',
      signInRequired: 'Sign in for server features, then retry this action.',
      sessionCheckFailed: 'Unable to verify server session.',
      popupBlocked: 'Unable to open sign-in popup window. Check popup blocker settings.',
      signInPending: 'Complete sign-in in the popup. Session will refresh automatically.',
      signedIn: 'Signed in for server features.',
      uploading: 'Saving RolePlayScene draft to server...',
      uploaded: 'Saved RolePlayScene draft to server. ID: {id}',
      uploadedWithWarnings: 'Saved RolePlayScene draft to server with warnings. ID: {id}',
      uploadFailed: 'Save to server failed.',
      uploadCanceled: 'Server save canceled.',
      actionFailed: 'Server action failed.',
      listFailed: 'Unable to load uploaded RolePlayScene drafts.',
      manageTitle: 'Manage Uploaded RolePlayScene Drafts',
      noDrafts: 'No uploaded RolePlayScene drafts yet.',
      slotUsage: '{used} of {limit} server draft slots used.',
      slotLimitReached: 'RolePlayScene draft slots are full. Delete one uploaded draft before saving another.',
      conflictTitle: 'Uploaded draft already exists',
      conflictBody: 'An uploaded RolePlayScene draft named "{title}" already exists. Choose how to save this project.',
      conflictReplace: 'Replace',
      conflictCopy: 'Save as copy',
      deleteTitle: 'Delete uploaded draft?',
      deleteBody: 'Delete "{title}" from uploaded RolePlayScene drafts? This removes the server copy only.',
      deleteConfirm: 'Delete',
      deleteFailed: 'Unable to delete uploaded RolePlayScene draft.',
      deletedDraft: 'Deleted uploaded RolePlayScene draft.',
      openDraft: 'Open',
      openingDraft: 'Opening uploaded RolePlayScene draft...',
      openFailed: 'Unable to open uploaded RolePlayScene draft.',
      openedDraft: 'Opened uploaded RolePlayScene draft.',
      openedDraftWithWarnings: 'Opened uploaded RolePlayScene draft with warnings.',
      downloadDraft: 'Download ZIP',
      downloadFailed: 'Unable to download uploaded RolePlayScene draft.',
      downloadedDraft: 'Downloaded uploaded RolePlayScene draft ZIP.',
      deleteDraft: 'Delete',
      missingMediaCount: '{count} missing media file(s) reported by the server.',
      validationWarningCount: '{count} validation warning(s) reported by the server.',
      missingMediaBadge: '{count} missing media',
      validationWarningBadge: '{count} warning(s)',
      meta: {
        id: 'Draft ID',
        publishState: 'Publish state',
        size: 'Artifact size',
        created: 'Created',
        updated: 'Updated',
      },
      publishState: {
        draft_only: 'Draft only',
        current_version_published: 'Published version current',
        unpublished_changes: 'Unpublished changes',
      },
      values: {
        untitledDraft: 'Untitled RolePlayScene',
        unknownSize: 'Unknown size',
        unknownTime: 'Unknown time',
        bytes: '{value} B',
        kb: '{value} KB',
        mb: '{value} MB',
      },
    },
    messages: {
      validationBeforePlay: 'Resolve validation errors before entering Play mode.',
      importingProject: 'Importing project…',
      importedProject: 'Imported project.',
      importedProjectWithWarnings: 'Imported project with warnings.',
      importFailed: 'Import failed.',
      importFailedSafe: 'Import failed. The current project was not replaced.',
      importCanceled: 'Import canceled. The current project was not replaced.',
      importInvalidZip: 'Import failed: the ZIP file could not be read.',
      importMissingProjectJson: 'Import failed: the archive is missing project.json.',
      importMissingPackageManifest: 'Import failed: the package is missing manifest.json.',
      importMissingPackageProject: 'Import failed: the package is missing content/project.json.',
      importUnsupportedPackage: 'Import failed: this RolePlayScene package format is not supported.',
      importInvalidJson: 'Import failed: the project JSON could not be read.',
      importInvalidProject: 'Import failed: the project has validation errors.',
      importMissingMediaWarning: 'Missing media file: {path}',
      importConfirmTitle: 'Replace current project?',
      importConfirmBody: 'Importing this file will replace the current local RolePlayScene project on this browser. This cannot be undone unless you exported a backup first.',
      importConfirmAccept: 'Replace and import',
      importConfirmCancel: 'Cancel',
      preparingExport: 'Preparing export…',
      exportedProject: 'Exported project archive.',
      exportFailed: 'Export failed.',
    },
    inspector: {
      projectTitleLabel: 'Project title',
      projectTitlePlaceholder: 'Untitled Role Play',
      emptyState: 'No scenes yet. Use “Add Scene” to begin.',
      header: {
        addScene: 'Add Scene',
        deleteScene: 'Delete Scene',
      },
      sceneTypeLabel: 'Scene type',
      sceneTypes: {
        start: 'Start',
        intermediate: 'Intermediate',
        end: 'End',
      },
      image: {
        label: 'Stage image',
        previewAlt: '{sceneId} preview',
        empty: 'No image selected.',
        remove: 'Remove image',
      },
      background: {
        label: 'Background music',
        attached: 'Attached: {name}',
        fallbackName: 'Untitled track',
        empty: 'No background track selected.',
        remove: 'Remove background music',
      },
      dialogue: {
        title: 'Dialogue (max 3 lines)',
        lineLabel: 'Line {index}',
        audioLabel: 'Audio (optional mp3)',
        audioAttached: 'Attached: {name}',
        removeAudio: 'Remove audio',
        deleteLine: 'Delete line',
        addLine: 'Add line',
      },
      choices: {
        title: 'Choices (max 3)',
        empty: 'No choices yet.',
        labelPlaceholder: 'Choice label',
        cueCardLabel: 'Cue card text',
        cueCardPlaceholder: 'Optional cue card text',
        destinationPlaceholder: 'Select destination',
        remove: 'Remove',
        add: 'Add choice',
        autoAdvanceLabel: 'Auto-advance destination',
        autoAdvanceNone: 'No auto-advance',
        autoAdvanceHelper: 'Remove choices to enable auto-advance.',
      },
      validationOk: 'No validation issues found.',
      notifications: {
        sceneLimit: 'Scene limit reached (20).',
        sceneAdded: 'Added scene {id}.',
        sceneDeleted: 'Deleted scene {id}.',
        cannotDeleteStart: 'Cannot delete the only Start scene.',
        sceneTypeUpdated: 'Scene {id} set to {type}.',
        imageUpdated: 'Updated image for {id}.',
        imageRemoved: 'Removed image for {id}.',
        backgroundUpdated: 'Updated background audio for {id}.',
        backgroundRemoved: 'Removed background audio for {id}.',
      },
    },
    player: {
      ready: 'Ready to play',
      untitled: 'Role Play',
      begin: 'Begin Story',
      noStartScene: 'No Start scene found.',
      sceneMissing: 'Scene missing.',
      stageImageAlt: '{sceneId} artwork',
      stageImageEmpty: 'No stage image',
      noSceneSelected: 'No scene selected.',
      background: {
        title: 'Background music',
        volumeLabel: 'Background music volume',
        mute: 'Mute background music',
        unmute: 'Unmute background music',
        duckFailed: 'Failed to duck background audio',
        restoreFailed: 'Failed to restore background audio',
      },
      history: {
        title: 'Story history',
        back: '← Back',
        forward: 'Forward →',
        backLabel: 'Go to previous scene',
        forwardLabel: 'Go to next scene',
        listLabel: 'Visited scenes',
      },
      dialogue: {
        playAll: '▶️ Play all',
        stopAll: '⏹ Stop playback',
        playAllAria: 'Play all dialogue audio',
        playLine: '▶️ Play line',
        stopLine: '⏹ Stop line',
        lineFallback: '(Line {index})',
        playbackError: 'Audio playback failed',
      },
      choices: {
        endMessage: 'The End',
        continue: 'Continue',
        autoNextMissing: 'Destination scene is missing.',
        noneAvailable: 'No choices available.',
        cueCardTitle: 'Cue card',
        cueCardCloseLabel: 'Close cue card',
        cueCardTriggerLabel: 'Show cue card for {label}',
      },
    },
    persistence: {
      autosaveUnavailable: 'Autosave disabled: IndexedDB not supported.',
      autosaveOpenFailed: 'Autosave disabled: unable to open browser storage.',
      autosaveReadFailed: 'Autosave disabled: unable to read saved project.',
      autosaveWriteFailed: 'Autosave disabled: storage error.',
    },
  },
};

let activeLocale = 'en';
const listeners = new Set();

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolvePath(dictionary, pathSegments) {
  return pathSegments.reduce((current, segment) => {
    if (!isPlainObject(current) && typeof current !== 'string') {
      return undefined;
    }
    if (isPlainObject(current)) {
      return current[segment];
    }
    return undefined;
  }, dictionary);
}

function formatValue(template, vars) {
  if (typeof template !== 'string') {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      const value = vars[key];
      return value == null ? '' : String(value);
    }
    return match;
  });
}

export function getAvailableLocales() {
  return Object.keys(translations);
}

export function getActiveLocale() {
  return activeLocale;
}

export function setActiveLocale(locale) {
  const requested = typeof locale === 'string' && locale.trim() ? locale.trim() : 'en';
  const next = translations[requested] ? requested : 'en';
  if (next === activeLocale) {
    return activeLocale;
  }
  activeLocale = next;
  for (const handler of listeners) {
    try {
      handler(activeLocale);
    } catch (err) {
      console.error('Locale listener failed', err);
    }
  }
  return activeLocale;
}

export function ensureLocale(locale) {
  if (typeof locale !== 'string' || !locale.trim()) {
    return 'en';
  }
  const trimmed = locale.trim();
  return translations[trimmed] ? trimmed : 'en';
}

export function onLocaleChange(handler) {
  if (typeof handler !== 'function') {
    return () => {};
  }
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function translate(id, vars = {}) {
  if (!id) {
    return '';
  }
  const segments = String(id).split('.');
  const localesToCheck = [activeLocale, 'en'];
  for (const locale of localesToCheck) {
    const dictionary = translations[locale];
    if (!dictionary) continue;
    const value = resolvePath(dictionary, segments);
    if (value == null) continue;
    if (typeof value === 'function') {
      return value(vars, { locale: activeLocale });
    }
    return formatValue(value, vars);
  }
  return formatValue(vars.default ?? id, vars);
}

export function addTranslations(locale, entries) {
  if (typeof locale !== 'string' || !locale.trim()) {
    throw new Error('Locale code must be a non-empty string');
  }
  const code = locale.trim();
  if (!isPlainObject(entries)) {
    throw new Error('Translation entries must be an object');
  }
  const target = translations[code] ?? {};
  translations[code] = mergeDictionaries(target, entries);
}

function mergeDictionaries(target, source) {
  const output = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value)) {
      output[key] = mergeDictionaries(
        isPlainObject(output[key]) ? output[key] : {},
        value,
      );
    } else {
      output[key] = value;
    }
  }
  return output;
}

export { translations };
