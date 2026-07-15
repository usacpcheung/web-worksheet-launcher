export const AUDIO_TRACK_LANGUAGES = Object.freeze(['cantonese', 'mandarin', 'english']);

const LANGUAGE_ORDER = new Map(AUDIO_TRACK_LANGUAGES.map((language, index) => [language, index]));

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeTrack(track) {
  if (!isRecord(track)) return null;
  const language = typeof track.language === 'string' ? track.language : '';
  const assetId = typeof track.assetId === 'string' ? track.assetId.trim() : '';
  const sourceTextHash = typeof track.sourceTextHash === 'string' ? track.sourceTextHash.trim() : '';
  const voicePresetId = track.voicePresetId == null
    ? null
    : (typeof track.voicePresetId === 'string' ? track.voicePresetId.trim() : '');

  if (
    !AUDIO_TRACK_LANGUAGES.includes(language)
    || !assetId
    || !sourceTextHash
    || (voicePresetId !== null && voicePresetId !== language)
  ) {
    return null;
  }

  return { language, assetId, voicePresetId, sourceTextHash };
}

export function normalizeAudioTracks(audioTracks) {
  const seenLanguages = new Set();
  return (Array.isArray(audioTracks) ? audioTracks : [])
    .map(normalizeTrack)
    .filter((track) => {
      if (!track || seenLanguages.has(track.language)) return false;
      seenLanguages.add(track.language);
      return true;
    })
    .sort((left, right) => LANGUAGE_ORDER.get(left.language) - LANGUAGE_ORDER.get(right.language));
}

export function collectAudioTrackAssetIds(audioTracks) {
  return normalizeAudioTracks(audioTracks).map((track) => track.assetId);
}

export function assertValidAudioTracks(audioTracks, assetById, location) {
  if (audioTracks == null) return [];
  if (!Array.isArray(audioTracks)) {
    throw new Error(`${location}.audioTracks must be an array`);
  }
  if (audioTracks.length > AUDIO_TRACK_LANGUAGES.length) {
    throw new Error(`${location}.audioTracks supports at most ${AUDIO_TRACK_LANGUAGES.length} tracks`);
  }

  const normalized = [];
  const seenLanguages = new Set();
  audioTracks.forEach((track, index) => {
    const itemLocation = `${location}.audioTracks[${index}]`;
    if (!isRecord(track)) throw new Error(`${itemLocation} must be an object`);
    if (!AUDIO_TRACK_LANGUAGES.includes(track.language)) {
      throw new Error(`${itemLocation}.language must be cantonese, mandarin, or english`);
    }
    if (seenLanguages.has(track.language)) {
      throw new Error(`${location}.audioTracks has duplicate language: ${track.language}`);
    }
    seenLanguages.add(track.language);
    if (typeof track.assetId !== 'string' || !track.assetId.trim()) {
      throw new Error(`${itemLocation}.assetId must be a non-empty string`);
    }
    const asset = assetById.get(track.assetId);
    if (!asset) throw new Error(`${itemLocation}.assetId does not exist in the package manifest`);
    if (asset.kind !== 'audio') throw new Error(`${itemLocation}.assetId must reference an audio asset`);
    if (track.voicePresetId !== null && track.voicePresetId !== undefined && track.voicePresetId !== track.language) {
      throw new Error(`${itemLocation}.voicePresetId must match its language or be null`);
    }
    if (typeof track.sourceTextHash !== 'string' || !track.sourceTextHash.trim()) {
      throw new Error(`${itemLocation}.sourceTextHash must be a non-empty string`);
    }
    normalized.push({
      language: track.language,
      assetId: track.assetId,
      voicePresetId: track.voicePresetId ?? null,
      sourceTextHash: track.sourceTextHash,
    });
  });

  return normalized.sort((left, right) => LANGUAGE_ORDER.get(left.language) - LANGUAGE_ORDER.get(right.language));
}
