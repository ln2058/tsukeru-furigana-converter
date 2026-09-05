/*
Module: tooltip-async-state
Purpose: Coordinate lazy tooltip enrichment requests across one lookup session.

Inputs:
- Section names, loader promises, and success/error callbacks from content-tooltip.js.

Outputs:
- Per-section idle/loading/loaded/empty/error state and stale-result suppression.

Side Effects:
- None; this helper stores coordinator state and invokes caller callbacks only for the current session.

Failure Modes:
- Loader failures become an error section result; stale resolve/reject callbacks are ignored.

Security Notes:
- Does not render or interpret remote data; callers remain responsible for validation and sanitization.
*/
(function attachTooltipAsyncState(root) {
  function createTooltipAsyncCoordinator() {
    let sessionVersion = 0;
    let sessionWord = '';
    const sections = new Map();

    function reset(word = '') {
      sessionVersion += 1;
      sessionWord = String(word || '');
      sections.clear();
      return sessionVersion;
    }

    function invalidate() {
      sessionVersion += 1;
      sections.clear();
      return sessionVersion;
    }

    function isCurrent(version, word = sessionWord) {
      return version === sessionVersion && String(word || '') === sessionWord;
    }

    function getState(name) {
      return sections.get(name)?.status || 'idle';
    }

    function open(name, loader, callbacks = {}) {
      const existing = sections.get(name);
      if (existing && existing.status !== 'idle') {
        return existing.promise;
      }

      const requestVersion = sessionVersion;
      const requestWord = sessionWord;
      const entry = { status: 'loading', promise: null };
      const request = Promise.resolve().then(loader).then(
        (value) => {
          if (!isCurrent(requestVersion, requestWord) || sections.get(name) !== entry) {
            return { status: 'stale' };
          }
          entry.status = value == null ? 'empty' : 'loaded';
          entry.value = value;
          if (typeof callbacks.onSuccess === 'function') {
            callbacks.onSuccess(value, entry.status);
          }
          return { status: entry.status, value };
        },
        (error) => {
          if (!isCurrent(requestVersion, requestWord) || sections.get(name) !== entry) {
            return { status: 'stale' };
          }
          entry.status = 'error';
          entry.error = error;
          if (typeof callbacks.onError === 'function') {
            callbacks.onError(error);
          }
          return { status: 'error', error };
        }
      );
      entry.promise = request;
      sections.set(name, entry);
      return request;
    }

    return { reset, invalidate, isCurrent, getState, open };
  }

  root.TsukeruTooltipAsyncState = { createTooltipAsyncCoordinator };
})(typeof globalThis !== 'undefined' ? globalThis : window);
