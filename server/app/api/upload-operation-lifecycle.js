// One owner per upload or UI flow. Aborting does not release ownership: the
// owner must settle before a later operation can start. No network/retry policy.
export class UploadOperationSlot {
  #current = null;

  begin(contextIsCurrent = () => true) {
    if (this.#current) return null;
    const controller = new AbortController();
    const operation = {
      controller,
      signal: controller.signal,
      isCurrent: () => this.#current === operation,
      canPublish: () => this.#current === operation && contextIsCurrent(),
      canProgress: () => operation.canPublish() && !controller.signal.aborted,
      finish: () => {
        if (this.#current !== operation) return false;
        this.#current = null;
        return true;
      },
    };
    this.#current = operation;
    return operation;
  }
}

export const staleUploadResult = () => ({ ok: false, skipped: true, status: 'stale_upload' });
export const canceledUploadResult = () => ({ ok: false, error: {
  code: 'ABORTED', message: 'Upload was canceled. The server may already have saved it. Check uploaded items before uploading again.',
} });
