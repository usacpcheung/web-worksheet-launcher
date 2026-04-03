const MB = 1024 * 1024;

const MEDIA_LIMITS = Object.freeze({
  imageMaxBytes: 8 * MB,
  audioMaxBytes: 5 * MB,
});

const IMAGE_MIME_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp']);
const AUDIO_MIME_TYPES = Object.freeze(['audio/mpeg', 'audio/mp3']);
const AUDIO_EXTENSIONS = Object.freeze(['mp3']);

export {
  MEDIA_LIMITS,
  IMAGE_MIME_TYPES,
  IMAGE_EXTENSIONS,
  AUDIO_MIME_TYPES,
  AUDIO_EXTENSIONS,
};
