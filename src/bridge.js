// The only module that knows about the native host. Everything else calls `call()` / `on()`,
// so porting Sustenido to another shell (Tauri on macOS/Linux) means rewriting this file alone.
const host = window.chrome.webview;
const pending = new Map();
const listeners = new Map();
let seq = 0;

host.addEventListener('message', ({ data }) => {
  if (data.type !== 'reply') return listeners.get(data.type)?.(data);
  const request = pending.get(data.rid);
  if (!request) return;
  pending.delete(data.rid);
  if (data.error) request.reject(new Error(data.error));
  else request.resolve(data.result);
});

/** Request/response to the host. Rejects with the host's error message. */
export function call(type, payload = {}, files) {
  return new Promise((resolve, reject) => {
    const rid = ++seq;
    pending.set(rid, { resolve, reject });
    const message = { ...payload, type, rid };
    // Files travel as native objects so the host receives real paths (drag & drop).
    if (files) host.postMessageWithAdditionalObjects(message, files);
    else host.postMessage(message);
  });
}

/** Host-initiated events: 'open' (files from Explorer or a second launch) and 'closing'. */
export const on = (type, fn) => listeners.set(type, fn);
