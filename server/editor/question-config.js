import { normalizeAudioTracks } from './audio-tracks.js';
import { optionImageRef, imageDescription } from '../app/option-images.js';
import { emptyBlankConfig } from '../app/fill-in-blanks.js';
import { isLongText, LONG_TEXT_LIMIT } from '../app/text-answer.js';
import { getNumberCorrectAnswerConfigViolation } from '../app/contracts/number-input-validator.js';

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Data transformations only: no editor/session, DOM, persistence or API access.
// Missing option IDs use the editor's generator; existing IDs remain unchanged.
export function createQuestionConfigHelpers({ createLocalId, normalizeMediaRefs }) {
  function mapOptionsTextToLines(rawText) {
    if (!rawText) return [];
    return String(rawText)
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function mapOptionsTextToResponseOptions(rawText) {
    return mapOptionsTextToLines(rawText)
      .map((line) => ({ id: createLocalId('opt'), value: line, label: line }));
  }

  function normalizeResponseOption(option, fallback = '') {
    if (isRecord(option)) {
      const id = isNonEmptyString(option.id) ? String(option.id) : createLocalId('opt');
      const value = String(option.value ?? option.label ?? fallback) || (optionImageRef(option) ? id : '');
      const label = String(option.label ?? option.value ?? fallback);
      return {
        id,
        value,
        label,
        mediaRefs: normalizeMediaRefs(option.mediaRefs).filter(ref => ['option_audio', 'option_image'].includes(ref.usage)),
        ...(option.imageDescription !== undefined ? { imageDescription: imageDescription(option.imageDescription) } : {}),
        audioTracks: normalizeAudioTracks(option.audioTracks),
      };
    }
    const normalized = String(option ?? fallback);
    return { id: createLocalId('opt'), value: normalized, label: normalized, mediaRefs: [], audioTracks: [] };
  }

  function getOptionValueForAnswerKey(option) {
    if (isRecord(option)) {
      if (option.value !== undefined && option.value !== null) {
        return String(option.value);
      }
      if (option.label !== undefined && option.label !== null) {
        return String(option.label);
      }
      return null;
    }
    if (typeof option === 'string' || typeof option === 'number' || typeof option === 'boolean') {
      return String(option);
    }
    return null;
  }

  function getOptionIdForAnswerKey(option) {
    if (isRecord(option) && isNonEmptyString(option.id)) {
      return String(option.id);
    }
    return null;
  }

  function getDuplicateOptionValues(options) {
    const seen = new Set();
    const duplicates = new Set();
    (Array.isArray(options) ? options : []).forEach((option, index) => {
      const normalized = normalizeResponseOption(option, `option_${index}`);
      const value = String(normalized.value ?? '').trim();
      if (!value) return;
      if (seen.has(value)) {
        duplicates.add(value);
        return;
      }
      seen.add(value);
    });
    return Array.from(duplicates);
  }

  function normalizeNumberRulesConfig(numberRules) {
    const source = isRecord(numberRules) ? numberRules : {};
    const allowedKinds = Array.isArray(source.allowedKinds)
      ? source.allowedKinds.filter((kind) => kind === 'integer' || kind === 'decimal')
      : ['integer', 'decimal'];
    return {
      allowedKinds: allowedKinds.length > 0 ? Array.from(new Set(allowedKinds)) : ['integer', 'decimal'],
      allowSigned: source.allowSigned !== false,
      decimalPlacesAllowed:
        Number.isInteger(source.decimalPlacesAllowed) && source.decimalPlacesAllowed >= 0
          ? source.decimalPlacesAllowed
          : null,
    };
  }

  function countDecimalPlaces(value) {
    if (!Number.isFinite(value)) return 0;
    const text = value.toString();

    // Simple case: no scientific notation.
    if (!text.includes('e') && !text.includes('E')) {
      const part = text.split('.')[1];
      return part ? part.length : 0;
    }

    // Scientific notation: use mantissa and exponent to determine decimal digits.
    const [mantissa, exponentPart] = text.toLowerCase().split('e');
    const exponent = Number(exponentPart);
    if (!Number.isFinite(exponent)) return 0;

    const decimalIndex = mantissa.indexOf('.');
    const decimalDigitsInMantissa = decimalIndex === -1 ? 0 : mantissa.length - decimalIndex - 1;

    if (exponent >= 0) {
      // Positive exponent moves the decimal point to the right.
      return Math.max(decimalDigitsInMantissa - exponent, 0);
    }

    // Negative exponent moves the decimal point to the left.
    return decimalDigitsInMantissa + (-exponent);
  }

  function isValidNumberCorrectAnswerForConfig(value, config) {
    return getNumberCorrectAnswerConfigViolation(value, config) === null;
  }

  function getNumberQuestionValidationErrors(config, rawValues = {}) {
    const normalizedConfig = normalizeQuestionResponseConfig({
      ...(isRecord(config) ? config : {}),
      inputType: 'number',
    });
    const errors = {
      min: null,
      max: null,
      decimalPlacesAllowed: null,
      correctAnswer: null,
    };

    const minValue = Number.isFinite(normalizedConfig.min) ? Number(normalizedConfig.min) : null;
    const maxValue = Number.isFinite(normalizedConfig.max) ? Number(normalizedConfig.max) : null;
    if (minValue !== null && maxValue !== null && maxValue < minValue) {
      const rangeMessage = 'Max must be greater than or equal to Min';
      errors.min = rangeMessage;
      errors.max = rangeMessage;
    }
    const hasRangeError = Boolean(errors.min || errors.max);

    const decimalPlacesRaw = rawValues.decimalPlacesAllowed;
    let decimalPlacesAllowed = normalizedConfig.numberRules?.decimalPlacesAllowed ?? null;
    if (decimalPlacesRaw !== undefined) {
      const text = String(decimalPlacesRaw).trim();
      if (text === '') {
        decimalPlacesAllowed = null;
      } else if (!/^\d+$/.test(text)) {
        errors.decimalPlacesAllowed = 'Decimal places allowed must be a non-negative integer';
      } else {
        const parsed = Number.parseInt(text, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          errors.decimalPlacesAllowed = 'Decimal places allowed must be a non-negative integer';
        } else {
          decimalPlacesAllowed = parsed;
        }
      }
    }
    const hasDecimalPlacesError = Boolean(errors.decimalPlacesAllowed);

    const rawCorrectAnswer = rawValues.correctAnswer;
    const hasRawCorrectAnswer = rawCorrectAnswer !== undefined;
    const hasStoredCorrectAnswer = typeof normalizedConfig.correctAnswer === 'number'
      && Number.isFinite(normalizedConfig.correctAnswer);
    const shouldValidateCorrectAnswer = hasRawCorrectAnswer
      ? String(rawCorrectAnswer).trim() !== ''
      : hasStoredCorrectAnswer;

    if (shouldValidateCorrectAnswer) {
      const correctAnswer = hasRawCorrectAnswer ? Number(rawCorrectAnswer) : Number(normalizedConfig.correctAnswer);
      if (!Number.isFinite(correctAnswer)) {
        errors.correctAnswer = 'Correct answer must be a valid number';
        return errors;
      }

      if (!normalizedConfig.numberRules?.allowSigned && correctAnswer < 0) {
        errors.correctAnswer = 'Correct answer must be positive when signed values are disabled';
        return errors;
      }
      if (!hasRangeError) {
        if (minValue !== null && correctAnswer < minValue) {
          errors.correctAnswer = 'Correct answer must be greater than or equal to Min';
          return errors;
        }
        if (maxValue !== null && correctAnswer > maxValue) {
          errors.correctAnswer = 'Correct answer must be less than or equal to Max';
          return errors;
        }
      }
      if (
        !hasDecimalPlacesError
        && decimalPlacesAllowed !== null
        && Number.isInteger(decimalPlacesAllowed)
        && countDecimalPlaces(correctAnswer) > decimalPlacesAllowed
      ) {
        errors.correctAnswer = 'Correct answer has more decimal places than allowed';
      }
    }

    return errors;
  }

  function normalizeQuestionResponseConfig(responseConfig, options = {}) {
    const forContract = options.forContract === true;
    const source = isRecord(responseConfig) ? { ...responseConfig } : {};
    const inputType = source.inputType == null ? 'text' : source.inputType;

    const normalized = {
      ...source,
      inputType,
    };

    if (inputType === 'fill_in_blanks') return source.passage ? structuredClone(source) : emptyBlankConfig();
    for (const key of ['passage','mode','reuseWords','distractors']) delete normalized[key];
    if (inputType === 'image_response') return { inputType, maxImages: source.maxImages ?? 3 };
    delete normalized.maxImages;
    if (inputType !== 'text') delete normalized.textMode;
    if (inputType === 'text') {
      normalized.maxLength = Number.isFinite(source.maxLength) ? Number(source.maxLength) : isLongText(source) ? LONG_TEXT_LIMIT : 200;
      normalized.displayMode = !isLongText(source) && source.displayMode === 'single_line' ? 'single_line' : 'multi_line';
      delete normalized.options;
      delete normalized.selectionMode;
      delete normalized.shuffleOptions;
      delete normalized.min;
      delete normalized.max;
      delete normalized.numberRules;
      delete normalized.correctAnswer;
    } else if (inputType === 'boolean') {
      delete normalized.options;
      delete normalized.selectionMode;
      delete normalized.shuffleOptions;
      delete normalized.min;
      delete normalized.max;
      delete normalized.numberRules;
      delete normalized.maxLength;
      delete normalized.displayMode;
      if (typeof source.correctAnswer === 'boolean') {
        normalized.correctAnswer = source.correctAnswer;
      } else {
        delete normalized.correctAnswer;
      }
    } else if (inputType === 'number') {
      delete normalized.options;
      delete normalized.selectionMode;
      delete normalized.shuffleOptions;
      if (Number.isFinite(source.min)) normalized.min = Number(source.min); else delete normalized.min;
      if (Number.isFinite(source.max)) normalized.max = Number(source.max); else delete normalized.max;
      normalized.numberRules = normalizeNumberRulesConfig(source.numberRules);
      delete normalized.maxLength;
      delete normalized.displayMode;
      if (
        typeof source.correctAnswer === 'number'
        && Number.isFinite(source.correctAnswer)
        && isValidNumberCorrectAnswerForConfig(source.correctAnswer, normalized)
      ) {
        normalized.correctAnswer = Number(source.correctAnswer);
      } else {
        delete normalized.correctAnswer;
      }
    } else if (inputType === 'multiple_choice') {
      normalized.selectionMode = source.selectionMode === 'multi' ? 'multi' : 'single';
      normalized.shuffleOptions = Boolean(source.shuffleOptions);
      const sourceOptions = Array.isArray(source.options) ? source.options : [];
      const normalizedOptions = sourceOptions
        ? sourceOptions.map((option, index) => normalizeResponseOption(option, `option_${index}`))
        : [];
      const optionById = new Map();
      const optionIdByValue = new Map();
      normalizedOptions.forEach((option, index) => {
        const optionId = getOptionIdForAnswerKey(option);
        const optionValue = getOptionValueForAnswerKey(optionImageRef(option) ? option : sourceOptions[index]);
        if (!optionId || optionValue === null) return;
        optionById.set(optionId, optionValue);
        if (!optionIdByValue.has(optionValue)) {
          optionIdByValue.set(optionValue, []);
        }
        optionIdByValue.get(optionValue).push(optionId);
      });
      const consumeOptionIdByValue = (optionValue, consumedIds) => {
        const candidates = optionIdByValue.get(optionValue) || [];
        const available = candidates.find((candidateId) => !consumedIds.has(candidateId));
        if (available) {
          consumedIds.add(available);
          return available;
        }
        return null;
      };

      const ambiguousFromValueMigration = new Set();
      const consumedIds = new Set();
      let selectedSingleOptionId = null;
      let selectedMultiOptionIds = [];

      if (typeof source.correctAnswerOptionId === 'string' && optionById.has(source.correctAnswerOptionId)) {
        selectedSingleOptionId = source.correctAnswerOptionId;
      } else if (typeof source.correctAnswer === 'string') {
        const candidates = optionIdByValue.get(source.correctAnswer) || [];
        if (candidates.length > 1) {
          ambiguousFromValueMigration.add(source.correctAnswer);
        }
        selectedSingleOptionId = consumeOptionIdByValue(source.correctAnswer, consumedIds);
      }

      if (Array.isArray(source.correctAnswerOptionIds)) {
        const dedupedIds = [];
        const seenIds = new Set();
        source.correctAnswerOptionIds.forEach((optionId) => {
          if (typeof optionId !== 'string' || seenIds.has(optionId) || !optionById.has(optionId)) return;
          seenIds.add(optionId);
          dedupedIds.push(optionId);
        });
        selectedMultiOptionIds = dedupedIds;
      } else if (Array.isArray(source.correctAnswer)) {
        const dedupedIds = [];
        const seenIds = new Set();
        source.correctAnswer.forEach((optionValue) => {
          if (typeof optionValue !== 'string') return;
          const candidates = optionIdByValue.get(optionValue) || [];
          if (candidates.length > 1) {
            ambiguousFromValueMigration.add(optionValue);
          }
          const mappedId = consumeOptionIdByValue(optionValue, consumedIds);
          if (!mappedId || seenIds.has(mappedId)) return;
          seenIds.add(mappedId);
          dedupedIds.push(mappedId);
        });
        selectedMultiOptionIds = dedupedIds;
      }

      normalized.options = forContract
        ? normalizedOptions.map((option) => ({ value: option.value, label: option.label, ...(optionImageRef(option) ? { id: option.id, mediaRefs: [optionImageRef(option)], imageDescription: option.imageDescription || '' } : {}) }))
        : normalizedOptions;

      if (normalized.selectionMode === 'single') {
        if (selectedSingleOptionId && optionById.has(selectedSingleOptionId)) {
          normalized.correctAnswerOptionId = selectedSingleOptionId;
          normalized.correctAnswer = optionById.get(selectedSingleOptionId);
        } else {
          delete normalized.correctAnswerOptionId;
          delete normalized.correctAnswer;
        }
        delete normalized.correctAnswerOptionIds;
      } else {
        const validOptionIds = selectedMultiOptionIds.filter((optionId) => optionById.has(optionId));
        normalized.correctAnswerOptionIds = validOptionIds;
        normalized.correctAnswer = validOptionIds.map((optionId) => optionById.get(optionId));
        delete normalized.correctAnswerOptionId;
      }
      if (!forContract && ambiguousFromValueMigration.size > 0) {
        normalized.correctAnswerMappingWarning = `Ambiguous value-to-option mapping for duplicate values: ${Array.from(ambiguousFromValueMigration).join(', ')}.`;
      } else {
        delete normalized.correctAnswerMappingWarning;
      }
      delete normalized.maxLength;
      delete normalized.displayMode;
      delete normalized.min;
      delete normalized.max;
      delete normalized.numberRules;
      if (forContract) {
        delete normalized.correctAnswerOptionId;
        delete normalized.correctAnswerOptionIds;
        delete normalized.correctAnswerMappingWarning;
      }
    } else {
      delete normalized.correctAnswerOptionId;
      delete normalized.correctAnswerOptionIds;
      delete normalized.correctAnswerMappingWarning;
      delete normalized.maxLength;
      delete normalized.displayMode;
      delete normalized.options;
      delete normalized.selectionMode;
      delete normalized.shuffleOptions;
      delete normalized.min;
      delete normalized.max;
      delete normalized.numberRules;
      delete normalized.correctAnswer;
    }

    return normalized;
  }

  return {
    normalizeQuestionResponseConfig, normalizeResponseOption,
    mapOptionsTextToLines, mapOptionsTextToResponseOptions,
    getDuplicateOptionValues, getNumberQuestionValidationErrors,
  };
}
