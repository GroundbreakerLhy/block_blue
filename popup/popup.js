'use strict';

// ============================================================
// DOM References
// ============================================================

const toggleEnabled = document.getElementById('toggle-enabled');
const toggleBlue = document.getElementById('toggle-blue');
const toggleGold = document.getElementById('toggle-gold');
const toggleGray = document.getElementById('toggle-gray');

const whitelistInput = document.getElementById('whitelist-input');
const whitelistAddBtn = document.getElementById('whitelist-add');
const whitelistRemoveInput = document.getElementById('whitelist-remove-input');
const whitelistRemoveBtn = document.getElementById('whitelist-remove-btn');
const whitelistViewBtn = document.getElementById('whitelist-view-btn');
const whitelistResetBtn = document.getElementById('whitelist-reset-btn');
const whitelistModal = document.getElementById('whitelist-modal');
const whitelistModalContent = document.getElementById('whitelist-modal-content');
const whitelistModalCloseBtn = document.getElementById('whitelist-modal-close');

const hiddenCountEl = document.getElementById('hidden-count');

// ============================================================
// Default Settings
// ============================================================

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  hideBlue: true,
  hideGold: false,
  hideGray: false,
  whitelist: [],
  hiddenCount: 0,
});

/** In-memory copy of the whitelist array. */
let currentWhitelist = [];

/**
 * Keep whitelist order stable for display and storage.
 */
function sortWhitelist(list) {
  return [...list].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

// ============================================================
// Settings Load / Save
// ============================================================

/**
 * Load settings from storage and populate the UI.
 */
async function loadSettings() {
  const data = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  toggleEnabled.checked = data.enabled;
  toggleBlue.checked = data.hideBlue;
  toggleGold.checked = data.hideGold;
  toggleGray.checked = data.hideGray;

  currentWhitelist = sortWhitelist(Array.isArray(data.whitelist) ? data.whitelist : []);
  hiddenCountEl.textContent = data.hiddenCount || 0;
}

/**
 * Persist current UI state back to storage and notify content scripts.
 */
async function saveSettings() {
  currentWhitelist = sortWhitelist(currentWhitelist);

  await chrome.storage.sync.set({
    enabled: toggleEnabled.checked,
    hideBlue: toggleBlue.checked,
    hideGold: toggleGold.checked,
    hideGray: toggleGray.checked,
    whitelist: currentWhitelist,
  });

  // Notify active tab's content script that settings changed
  notifyContentScript();
}

/**
 * Send a message to the content script in the active Twitter/X tab.
 */
async function notifyContentScript() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) return;

  // Ignore errors when the content script isn't injected (non-Twitter tabs)
  chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED' }).catch(() => {});
}

// ============================================================
// Whitelist Management
// ============================================================

/**
 * Add a username to the whitelist (from the input field).
 */
function addToWhitelist() {
  const raw = whitelistInput.value.trim().replace(/^@/, '');
  if (!raw) return;

  if (!/^[a-zA-Z0-9_]{1,15}$/.test(raw)) {
    whitelistInput.classList.add('block-blue-input-error');
    setTimeout(() => whitelistInput.classList.remove('block-blue-input-error'), 600);
    return;
  }

  const username = raw.toLowerCase();

  if (currentWhitelist.includes(username)) {
    whitelistInput.value = '';
    return;
  }

  currentWhitelist.push(username);
  currentWhitelist = sortWhitelist(currentWhitelist);
  whitelistInput.value = '';
  saveSettings();
}

/**
 * Remove a username from the whitelist (from the remove input field).
 */
function removeFromWhitelistByInput() {
  const raw = whitelistRemoveInput.value.trim().replace(/^@/, '');
  if (!raw) return;

  const username = raw.toLowerCase();
  const idx = currentWhitelist.indexOf(username);

  if (idx === -1) {
    whitelistRemoveInput.classList.add('block-blue-input-error');
    setTimeout(() => whitelistRemoveInput.classList.remove('block-blue-input-error'), 600);
    return;
  }

  currentWhitelist.splice(idx, 1);
  whitelistRemoveInput.value = '';
  saveSettings();
}

/**
 * Show current whitelist entries in a dialog.
 */
function viewWhitelist() {
  if (currentWhitelist.length === 0) {
    const emptyMsg = chrome.i18n.getMessage('whitelistViewEmpty') || 'Whitelist is empty.';
    window.alert(emptyMsg);
    return;
  }

  const listText = currentWhitelist.map(username => `@${username}`).join('\n');
  whitelistModalContent.textContent = listText;
  whitelistModal.hidden = false;
}

/**
 * Close whitelist modal.
 */
function closeWhitelistModal() {
  whitelistModal.hidden = true;
}

/**
 * Reset whitelist, then jump to Following page and ask user to rescan.
 */
async function resetWhitelistAndJumpToFollowing() {
  const confirmMsg = chrome.i18n.getMessage('whitelistResetConfirm') ||
    'Reset whitelist now?';
  if (!window.confirm(confirmMsg)) return;

  currentWhitelist = [];
  await saveSettings();

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  let username = null;
  if (tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_SELF_USERNAME' });
      if (response?.username) username = response.username;
    } catch {
      // Ignore when content script is unavailable in current tab.
    }
  }

  const followingUrl = username
    ? `https://x.com/${username}/following`
    : 'https://x.com/following';

  const doneMsg = chrome.i18n.getMessage('whitelistResetDone') ||
    'Whitelist reset. Jumping to Following page, please wait a moment for auto-record.';
  window.alert(doneMsg);

  if (tab?.id) {
    chrome.tabs.update(tab.id, { url: followingUrl });
    return;
  }

  chrome.tabs.create({ url: followingUrl });
}

// ============================================================
// Event Listeners
// ============================================================

toggleEnabled.addEventListener('change', saveSettings);
toggleBlue.addEventListener('change', saveSettings);
toggleGold.addEventListener('change', saveSettings);
toggleGray.addEventListener('change', saveSettings);

whitelistAddBtn.addEventListener('click', addToWhitelist);
whitelistRemoveBtn.addEventListener('click', removeFromWhitelistByInput);
whitelistViewBtn.addEventListener('click', viewWhitelist);
whitelistResetBtn.addEventListener('click', resetWhitelistAndJumpToFollowing);
whitelistModalCloseBtn.addEventListener('click', closeWhitelistModal);

whitelistModal.addEventListener('click', (e) => {
  if (e.target === whitelistModal) closeWhitelistModal();
});

whitelistInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addToWhitelist();
});

whitelistRemoveInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') removeFromWhitelistByInput();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !whitelistModal.hidden) closeWhitelistModal();
});

// ============================================================
// Stats Refresh
// ============================================================

/**
 * Fetch the live hidden count from the content script.
 */
async function refreshStats() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: 'GET_STATS' })
    .then(response => {
      if (response && typeof response.hiddenCount === 'number') {
        hiddenCountEl.textContent = response.hiddenCount;
      }
    })
    .catch(() => {
      // Content script not available — fall back to stored count
    });
}

// ============================================================
// i18n
// ============================================================

/**
 * Populate all elements with `data-i18n` attribute using chrome.i18n.
 */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

// ============================================================
// Init
// ============================================================

applyI18n();
loadSettings().then(() => refreshStats());
