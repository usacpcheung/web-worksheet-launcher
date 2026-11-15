// Package staging and attempt restoration share one lifecycle commit boundary.
export function createAttemptOpeningMethods({
  mapLegacyJsonToPackageModel, parseWorksheetPackage, isolateReadPackageAssets, nowIso, createLocalId, resolveImportedWorksheetPayload, assertReadImportCurrent, skippedReadImport, normalizeRestoredCheckStatus, getSourceIdentity, computeViewerPayloadFingerprint, DEFAULT_LEARNER_ID, imageAnswerRefs, t, VIEWER_NOTIFICATION_DEFAULT_TTL_MS, parseLocalAttemptPackage, ensureUint8Array
}) {
  return {
  async startImportedWorksheetFromJsonText(rawJson) {
    let parsedWorksheet;
    try {
      parsedWorksheet = JSON.parse(rawJson);
    } catch (error) {
      throw new Error(`Unable to parse worksheet JSON. ${error?.message || String(error)}`);
    }

    let mappedPackage;
    try {
      mappedPackage = mapLegacyJsonToPackageModel(parsedWorksheet);
    } catch (error) {
      throw new Error(`Imported worksheet is invalid. ${error?.message || String(error)}`);
    }

    return this.startImportedWorksheetFromPackageModel(mappedPackage);
  },

  async startImportedWorksheetFromPackageFile(fileOrBytes, options = {}) {
    let packageModel;
    try {
      packageModel = parseWorksheetPackage(fileOrBytes);
    } catch (error) {
      throw new Error(`Unable to import worksheet package. ${error?.message || String(error)}`);
    }
    return this.startImportedWorksheetFromPackageModel(packageModel, options);
  },

  async startImportedWorksheetFromPackageModel(packageModel, options = {}) {
    packageModel = isolateReadPackageAssets(packageModel);
    const worksheet = packageModel?.worksheet;
    if (!worksheet || typeof worksheet !== 'object') {
      throw new Error('Imported worksheet package is missing worksheet content.');
    }
    if (options.isCurrent && !options.isCurrent()) return skippedReadImport();
    const importedAt = nowIso();
    const packageAssets = Array.isArray(packageModel?.assets) ? packageModel.assets : [];

    const importedRecord = {
      localId: createLocalId('imported'),
      worksheet,
      importedAt,
    };
    importedRecord.metadata = {
      localId: importedRecord.localId,
      origin: 'imported_file',
      updatedAt: importedRecord.importedAt,
    };

    const payload = resolveImportedWorksheetPayload(importedRecord);
    try { await this.validateViewerPayload(payload); }
    catch (error) { if (options.isCurrent && !options.isCurrent()) return skippedReadImport(); throw error; }
    if (options.isCurrent && !options.isCurrent()) return skippedReadImport();

    const persistedAssetIds = [];
    try {
      assertReadImportCurrent(options);
      await this.storage.importedWorksheets.put(importedRecord);

      assertReadImportCurrent(options);
      if (packageAssets.length > 0 && this.storage.localAssets?.put) {
        try {
          for (const asset of packageAssets) {
            if (!asset || typeof asset !== 'object' || typeof asset.assetId !== 'string' || !asset.assetId.trim()) {
              continue;
            }
            if (!(asset.binary instanceof Uint8Array) || asset.binary.byteLength === 0) {
              continue;
            }
            assertReadImportCurrent(options);
            persistedAssetIds.push(asset.assetId);
            await this.storage.localAssets.put({
              localId: asset.assetId,
              binary: asset.binary,
              metadata: {
                localId: asset.assetId,
                origin: 'imported_package_asset',
                updatedAt: importedAt,
                kind: asset.kind || null,
                usage: asset.usage || null,
                mimeType: asset.mimeType || null,
                path: asset.path || null,
              },
            });
            assertReadImportCurrent(options);
          }
        } catch (error) {
          if (error?.code === 'READ_IMPORT_SUPERSEDED') throw error;
          throw new Error(`Failed to save imported package assets. ${error?.message || String(error)}`);
        }
      }
    } catch (error) {
      await this.storage.importedWorksheets?.remove?.(importedRecord.localId).catch(() => {});
      await Promise.all(
        persistedAssetIds.map((assetId) => this.storage.localAssets?.remove?.(assetId).catch(() => {}))
      );
      if (error?.code === 'ATTEMPT_OPEN_CANCELLED') return { ok: false, cancelled: true };
      if (error?.code === 'READ_IMPORT_SUPERSEDED' || (options.isCurrent && !options.isCurrent())) return skippedReadImport();
      if (String(error?.message || '').startsWith('Failed to save imported package assets.')) {
        throw error;
      }
      throw new Error(`Failed to save imported worksheet. ${error?.message || String(error)}`);
    }

    let committed = false;
    try {
      assertReadImportCurrent(options);
      const attempt = this.createLocalAttemptState(payload, 'imported_worksheet', {
        sourceImportedWorksheetId: importedRecord.localId,
        sourceSubject: options?.sourceSubject || worksheet?.subject || '',
        sourceOwner: options?.sourceOwner || worksheet?.owner || '',
      });
      attempt.checkResult = null;
      await this.lifecycle?.replace(attempt, { isCurrent: options.isCurrent, replacementKey: options.replacementKey });
      committed = Boolean(this.lifecycle);
      this.applyAttemptState(attempt, { markDirty: !this.lifecycle });
      this.persistResumeMetadata();
      return this.state;
    } catch (error) {
      if (committed) throw error; // Keep the saved snapshot recoverable after a rendering failure.
      await this.storage.importedWorksheets?.remove?.(importedRecord.localId).catch(() => {});
      await Promise.all(
        persistedAssetIds.map((assetId) => this.storage.localAssets?.remove?.(assetId).catch(() => {}))
      );
      if (error?.code === 'ATTEMPT_OPEN_CANCELLED') return { ok: false, cancelled: true };
      if (error?.code === 'READ_IMPORT_SUPERSEDED' || (options.isCurrent && !options.isCurrent())) return skippedReadImport();
      throw new Error(`Imported worksheet is invalid. ${error?.message || String(error)}`);
    }
  },

  mapUploadedAttemptCheckResult(checking) {
    if (!checking || typeof checking !== 'object') return null;
    const items = checking.items && typeof checking.items === 'object' ? checking.items : {};
    const byBlockId = {};
    const statusByBlockId = {};
    Object.entries(items).forEach(([blockId, item]) => {
      if (typeof blockId !== 'string' || !blockId) return;
      const status = normalizeRestoredCheckStatus(item?.result);
      if (!status) return;
      statusByBlockId[blockId] = status;
      if (status === 'correct' || status === 'incorrect') {
        byBlockId[blockId] = status === 'correct';
      }
    });
    return {
      statusByBlockId,
      byBlockId,
      correctCount: Number(checking.correctCount) || 0,
      totalQuestions: Number(checking.totalQuestions) || 0,
      checkedAt: checking.checkedAt || nowIso(),
    };
  },

  async restoreAttemptPackageAsLocalAttempt(packageModel, options = {}) {
    packageModel = isolateReadPackageAssets(packageModel);
    if (options.isCurrent && !options.isCurrent()) return skippedReadImport();
    const importedAt = nowIso();
    const rawAttempt = packageModel?.attempt && typeof packageModel.attempt === 'object' ? packageModel.attempt : {};
    const attemptStatus = String(rawAttempt.status || 'in_progress');
    const isInProgress = attemptStatus === 'in_progress';
    const isChecked = attemptStatus === 'checked';
    const isSubmitted = attemptStatus === 'submitted';
    if (!isInProgress && !isChecked && !isSubmitted) {
      throw new Error(options.unsupportedStatusMessage || t('viewer.notifications.localAttemptImport.invalidPackage'));
    }

    const importedRecord = {
      localId: createLocalId('imported'),
      worksheet: packageModel.worksheet,
      importedAt,
      metadata: {
        localId: null,
        origin: options.worksheetOrigin || 'uploaded_attempt_restore',
        updatedAt: importedAt,
      },
    };
    importedRecord.metadata.localId = importedRecord.localId;
    const payload = resolveImportedWorksheetPayload(importedRecord);
    try { await this.validateViewerPayload(payload); }
    catch (error) { if (options.isCurrent && !options.isCurrent()) return skippedReadImport(); throw error; }
    if (options.isCurrent && !options.isCurrent()) return skippedReadImport();

    const restoredLocalAttemptId = createLocalId('attempt');
    const restoredStartedAt = rawAttempt.createdAt || nowIso();
    const restoredUpdatedAt = rawAttempt.updatedAt || nowIso();
    const checkResult = isChecked ? this.mapUploadedAttemptCheckResult(rawAttempt.checking) : null;
    const restoredSubject = String(options.subject || '').trim();
    const restoredOwner = String(options.owner || '').trim();
    const sourceId = getSourceIdentity('imported_worksheet', { sourceImportedWorksheetId: importedRecord.localId });
    const sourceFingerprint = computeViewerPayloadFingerprint(payload);
    const restoredAttemptRecord = {
      localId: restoredLocalAttemptId,
      localAttemptId: restoredLocalAttemptId,
      viewerPayload: payload,
      learnerId: DEFAULT_LEARNER_ID,
      worksheetId: payload?.worksheetId || null,
      snapshotId: payload?.snapshotId || null,
      sourceType: 'imported_worksheet',
      sourceId,
      sourceFingerprint,
      sourceLocalDraftId: null,
      sourceImportedWorksheetId: importedRecord.localId,
      lastActiveBlockId: payload?.blocks?.[0]?.blockId || null,
      lastActiveIndex: 0,
      studentName: typeof rawAttempt.metadata?.studentName === 'string' ? rawAttempt.metadata.studentName : '',
      studentNameResolved: rawAttempt.metadata?.studentNameResolved === true,
      attemptNameMode: options.serverName && options.serverName !== rawAttempt.metadata?.attemptName
        ? undefined : rawAttempt.metadata?.attemptNameMode,
      attemptNameDraft: options.serverName || rawAttempt.metadata?.attemptName || '',
      savedAttemptName: options.serverName || '',
      savedAttemptSubject: options.serverName ? (options.subject ?? '') : null,
      savedAttemptAccount: options.serverAccount || null,
      status: isInProgress ? 'in_progress' : 'completed',
      startedAt: restoredStartedAt,
      lastSavedAt: restoredUpdatedAt,
      completedAt: isInProgress ? null : (rawAttempt.submittedAt || restoredUpdatedAt),
      submittedAt: isInProgress ? null : (rawAttempt.submittedAt || null),
      answers: rawAttempt.answers && typeof rawAttempt.answers === 'object' ? rawAttempt.answers : {},
      feedback: rawAttempt.feedback,
      subject: restoredSubject,
      owner: restoredOwner,
      restoredAttemptCheckResult: checkResult,
      metadata: {
        localId: restoredLocalAttemptId,
        origin: options.attemptOrigin || 'imported_worksheet',
        sourceImportedWorksheetId: importedRecord.localId,
        sourceId,
        sourceFingerprint,
        subject: restoredSubject,
        owner: restoredOwner,
        updatedAt: restoredUpdatedAt,
      },
    };

    const worksheetAssetIds = new Set(this.collectAttemptPackageAssetIds(packageModel.worksheet));
    const answerAssetIds = new Set(payload.blocks.flatMap(block => block.responseConfig?.inputType === 'image_response'
      ? imageAnswerRefs(rawAttempt.answers?.[block.blockId]?.value || [], block.responseConfig.maxImages).map(ref => ref.assetId) : []));
    const persistedAssetIds = [];
    let didPersistImportedWorksheet = false;
    let didAttemptPersistAttempt = false;
    try {
      assertReadImportCurrent(options);
      didPersistImportedWorksheet = true;
      await this.storage.importedWorksheets.put(importedRecord);
      assertReadImportCurrent(options);
      for (const asset of Array.isArray(packageModel.assets) ? packageModel.assets : []) {
        if (!asset?.assetId || !(asset.binary instanceof Uint8Array)) continue;
        assertReadImportCurrent(options);
        persistedAssetIds.push(asset.assetId);
        await this.storage.localAssets.put({
          localId: asset.assetId,
          binary: asset.binary,
          metadata: {
            localId: asset.assetId,
            ...(answerAssetIds.has(asset.assetId) && !worksheetAssetIds.has(asset.assetId) ? { ownerAttemptId: restoredLocalAttemptId } : {}),
            origin: options.assetOrigin || 'uploaded_attempt_restore',
            updatedAt: importedAt,
            mimeType: asset.mimeType || null,
            kind: asset.kind || null,
            usage: asset.usage || null,
            path: asset.path || null,
          },
        });
        assertReadImportCurrent(options);
      }
      assertReadImportCurrent(options);
      didAttemptPersistAttempt = true;
      if (this.lifecycle) await this.lifecycle.replace(restoredAttemptRecord, { isCurrent: options.isCurrent, replacementKey: options.replacementKey });
      else await this.storage.attempts.put(restoredAttemptRecord);
      if (!this.lifecycle) assertReadImportCurrent(options);
    } catch (error) {
      if (didAttemptPersistAttempt) {
        await this.storage.attempts?.remove?.(restoredLocalAttemptId).catch(() => {});
      }
      if (didPersistImportedWorksheet) {
        await this.storage.importedWorksheets?.remove?.(importedRecord.localId).catch(() => {});
      }
      await Promise.all(persistedAssetIds.map((assetId) => this.storage.localAssets?.remove?.(assetId).catch(() => {})));
      if (error?.code === 'ATTEMPT_OPEN_CANCELLED') return { ok: false, cancelled: true };
      if (error?.code === 'READ_IMPORT_SUPERSEDED' || (options.isCurrent && !options.isCurrent())) return skippedReadImport();
      throw error;
    }

    this.applyAttemptState(restoredAttemptRecord, { markDirty: false });
    this.state.checkResult = checkResult;
    this.state.restoredAttemptCheckResult = checkResult;
    this.state.serverActionMessage = options.serverActionMessage === undefined
      ? t('viewer.notifications.uploadedAttempt.restoredWithId', { id: restoredLocalAttemptId })
      : options.serverActionMessage;
    this.pushNotification({
      kind: 'success',
      text: options.successMessage || t('viewer.notifications.uploadedAttempt.restored'),
      ttlMs: VIEWER_NOTIFICATION_DEFAULT_TTL_MS,
    });
    this.persistResumeMetadata();
    return { ok: true, data: { localAttemptId: restoredLocalAttemptId } };
  },

  async importAttemptPackageFromFile(fileOrBytes) {
    const file = fileOrBytes && typeof fileOrBytes === 'object' && 'arrayBuffer' in fileOrBytes ? fileOrBytes : null;
    const name = String(file?.name || '').toLowerCase();
    if (file && !name.endsWith('.zip')) {
      throw new Error(t('viewer.notifications.localAttemptImport.zipRequired'));
    }
    const bytes = file
      ? new Uint8Array(await file.arrayBuffer())
      : ensureUint8Array(fileOrBytes);
    if (!bytes) throw new Error(t('viewer.notifications.localAttemptImport.zipRequired'));
    try {
      const packageModel = parseLocalAttemptPackage(bytes);
      return await this.restoreAttemptPackageAsLocalAttempt(packageModel, {
        subject: packageModel?.worksheet?.subject || '',
        owner: packageModel?.worksheet?.owner || '',
        worksheetOrigin: 'local_attempt_package_import',
        assetOrigin: 'local_attempt_package_import',
        attemptOrigin: 'imported_attempt_package',
        successMessage: t('viewer.notifications.uploadedAttempt.restored'),
        serverActionMessage: null,
      });
    } catch (error) {
      const message = error?.message || t('viewer.notifications.localAttemptImport.invalidPackage');
      const safeMessages = new Set([
        t('viewer.notifications.localAttemptImport.zipRequired'),
        t('viewer.notifications.localAttemptImport.invalidPackage'),
        t('viewer.notifications.localAttemptImport.worksheetPackageNotAttempt'),
      ]);
      throw new Error(safeMessages.has(message) ? message : t('viewer.notifications.localAttemptImport.failed'));
    }
  },
  };
}
