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
const whitelistListEl = document.getElementById('whitelist-list');

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

  renderWhitelist(Array.isArray(data.whitelist) ? data.whitelist : []);
  hiddenCountEl.textContent = data.hiddenCount || 0;
}

/**
 * Persist current UI state back to storage and notify content scripts.
 */
async function saveSettings() {
  const whitelist = getCurrentWhitelist();

  await chrome.storage.sync.set({
    enabled: toggleEnabled.checked,
    hideBlue: toggleBlue.checked,
    hideGold: toggleGold.checked,
    hideGray: toggleGray.checked,
    whitelist,
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
 * Read the current whitelist from the DOM list.
 * @returns {string[]}
 */
function getCurrentWhitelist() {
  const items = whitelistListEl.querySelectorAll('.block-blue-whitelist-item');
  return Array.from(items).map(li => li.dataset.username);
}

/**
 * Render the whitelist <ul> from an array of usernames.
 * @param {string[]} list
 */
function renderWhitelist(list) {
  whitelistListEl.innerHTML = '';

  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'block-blue-whitelist-empty';
    empty.textContent = '暂无白名单用户';
    whitelistListEl.appendChild(empty);
    return;
  }

  for (const username of list) {
    const li = document.createElement('li');
    li.className = 'block-blue-whitelist-item';
    li.dataset.username = username;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `@${username}`;

    const removeBtn = document.createElement('button');
    removeBtn.textContent = '×';
    removeBtn.title = '移除';
    removeBtn.addEventListener('click', () => {
      li.remove();
      // If list is now empty, show placeholder
      if (whitelistListEl.children.length === 0) {
        renderWhitelist([]);
      }
      saveSettings();
    });

    li.appendChild(nameSpan);
    li.appendChild(removeBtn);
    whitelistListEl.appendChild(li);
  }
}

/**
 * Add a username to the whitelist (from the input field).
 */
function addToWhitelist() {
  const raw = whitelistInput.value.trim().replace(/^@/, '');
  if (!raw) return;

  // Validate: Twitter usernames are 1-15 alphanumeric + underscore
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(raw)) {
    whitelistInput.classList.add('block-blue-input-error');
    setTimeout(() => whitelistInput.classList.remove('block-blue-input-error'), 600);
    return;
  }

  const username = raw.toLowerCase();
  const current = getCurrentWhitelist();

  // No duplicates
  if (current.includes(username)) {
    whitelistInput.value = '';
    return;
  }

  current.push(username);
  renderWhitelist(current);
  whitelistInput.value = '';
  saveSettings();
}

// ============================================================
// Event Listeners
// ============================================================

toggleEnabled.addEventListener('change', saveSettings);
toggleBlue.addEventListener('change', saveSettings);
toggleGold.addEventListener('change', saveSettings);
toggleGray.addEventListener('change', saveSettings);

whitelistAddBtn.addEventListener('click', addToWhitelist);

whitelistInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addToWhitelist();
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
      if (response && typeof response.autoFollowedCount === 'number') {
        const el = document.getElementById('auto-followed-count');
        if (el) el.textContent = response.autoFollowedCount;
      }
    })
    .catch(() => {
      // Content script not available — fall back to stored count
    });
}

// ============================================================
// Init
// ============================================================

loadSettings().then(() => refreshStats());
