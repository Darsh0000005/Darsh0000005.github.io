// Small fetch helper: per-request timeout, retries with backoff, clean cancellation.

export class HttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Ties a per-request timeout to the caller's cancel signal.
function requestSignal(parent, timeoutMs) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      parent?.removeEventListener('abort', cancel);
    },
  };
}

/**
 * GET a URL and return its body as bytes. Network errors, timeouts and
 * transient HTTP statuses are retried; other HTTP errors throw HttpError.
 * If `signal` is aborted, its reason is thrown.
 */
export async function fetchBytes(url, { signal, retries = 2, timeoutMs = 45000 } = {}) {
  let failure;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1) + Math.random() * 250, signal);
    const request = requestSignal(signal, timeoutMs);
    try {
      const response = await fetch(url, { signal: request.signal, credentials: 'omit' });
      if (response.ok) return new Uint8Array(await response.arrayBuffer());
      failure = new HttpError(response.status);
      if (!RETRYABLE_STATUSES.has(response.status)) break;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      failure = err;
    } finally {
      request.release();
    }
  }
  throw failure;
}
