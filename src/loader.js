/*
 * Isolated-world content script.
 *
 * Two jobs, both of which have to happen here because the MAIN world has no
 * access to the chrome.* APIs:
 *
 *  1. Hand the page the URL of the module bundle and let it import it. The
 *     hook is already installed by then - it runs as a separate MAIN-world
 *     content script at document_start, which is the only way to get in front
 *     of the vendor app's own socket.
 *  2. Broker chrome.storage on the page's behalf, so cue stacks survive a
 *     reload without being written into the device's own localStorage.
 */

const src = chrome.runtime.getURL('src/main.js');

const script = document.createElement('script');
script.type = 'module';
script.textContent = `import(${JSON.stringify(src)});`;
(document.head || document.documentElement).append(script);
script.remove();

window.addEventListener('message', async (ev) => {
  if (ev.source !== window || !ev.data || ev.data.__wru !== 'storage') return;
  const { id, op, key, value } = ev.data;
  let result = null;
  try {
    if (op === 'set') await chrome.storage.local.set({ [key]: value });
    else result = (await chrome.storage.local.get(key))[key] ?? null;
  } catch (err) {
    console.error('[webRCS unleashed] storage', op, 'failed', err);
  }
  window.postMessage({ __wru: 'storage:result', id, value: result }, '*');
});
