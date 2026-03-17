'use strict';

// ============================================================
// Extension Context Guard
// ============================================================

/**
 * Check whether the extension context is still valid.
 * After an extension reload/update, the old content script remains in the page
 * but all chrome.* APIs throw "Extension context invalidated".
 *
 * @returns {boolean}
 */
function isContextValid() {
  return !!(chrome && chrome.runtime && chrome.runtime.id);
}

// ============================================================
// Constants
// ============================================================

/** Attribute marking an element as already scanned */
const PROCESSED_ATTR = 'data-block-blue-processed';

/** Attribute marking an element as replaced with a placeholder */
const REPLACED_ATTR = 'data-block-blue-replaced';

/** CSS selectors for containers that may hold verified badges */
const SELECTORS = [
  '[data-testid="tweet"]',
  '[data-testid="UserCell"]',
];

/**
 * Partial aria-label keywords used by Twitter for the verified badge
 * across different locales (case-insensitive matching).
 */
const VERIFIED_KEYWORDS = [
  'verified',
  '認証済み',
  '已验证',
  '已認證',
  'verifiziert',
  'vérifié',
  'verificado',
  'verificato',
  '인증',
];

/** Keywords that indicate the logged-in user is following someone */
const FOLLOWING_KEYWORDS = [
  'following',       // en
  'フォロー中',      // ja
  '正在关注',        // zh-CN
  '正在關注',        // zh-TW
  'siguiendo',       // es
  'suivi',           // fr
  'folge ich',       // de
  'seguindo',        // pt
  'segui già',       // it
  '팔로잉',          // ko
];

/** Enumeration of badge colour types */
const BADGE_TYPES = Object.freeze({
  BLUE: 'blue',
  GOLD: 'gold',
  GRAY: 'gray',
});

// ============================================================
// State
// ============================================================

/** Current plugin settings */
const settings = {
  enabled: true,
  hideBlue: true,
  hideGold: false,
  hideGray: false,
  whitelist: [],
};

/** Whitelist stored as a Set for O(1) lookup (lowercase usernames) */
let whitelistSet = new Set();

/** Running count of elements hidden during this page session */
let hiddenCount = 0;

/** MutationObserver instance */
let observer = null;

/** Timer id for batched storage writes of hiddenCount */
let saveTimer = null;

/** Flag to skip onChanged events triggered by our own whitelist saves */
let _selfSavingWhitelist = false;

// ============================================================
// Default settings (also used as keys for chrome.storage.sync)
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
// Settings Management
// ============================================================

/**
 * Keep whitelist order stable for storage consistency.
 * @param {string[]} list
 * @returns {string[]}
 */
function sortWhitelist(list) {
  return [...list].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

/**
 * Load settings from chrome.storage.sync and refresh local state.
 * @returns {Promise<void>}
 */
async function loadSettings() {
  if (!isContextValid()) return;
  const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings.enabled = result.enabled;
  settings.hideBlue = result.hideBlue;
  settings.hideGold = result.hideGold;
  settings.hideGray = result.hideGray;
  settings.whitelist = sortWhitelist(Array.isArray(result.whitelist) ? result.whitelist : []);
  whitelistSet = new Set(settings.whitelist.map(u => u.toLowerCase()));
  hiddenCount = typeof result.hiddenCount === 'number' ? result.hiddenCount : 0;
}

/**
 * Persist hiddenCount back to storage (debounced to avoid rate-limit).
 */
function debouncedSaveHiddenCount() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!isContextValid()) return;
    chrome.storage.sync.set({ hiddenCount });
  }, 1000);
}

// ============================================================
// Badge Detection
// ============================================================

/**
 * Determine whether an SVG element is a Twitter verified badge.
 * Uses aria-label keyword matching as the primary signal and falls
 * back to a structural heuristic (22×22 viewBox + ≥2 paths).
 *
 * @param {SVGElement} svg
 * @returns {boolean}
 */
function isVerifiedBadge(svg) {
  if (!svg || svg.tagName.toLowerCase() !== 'svg') return false;

  // Primary: aria-label contains a known "verified" keyword
  const label = (svg.getAttribute('aria-label') || '').toLowerCase();
  if (label && VERIFIED_KEYWORDS.some(kw => label.includes(kw))) return true;

  // Fallback: structural check — the Twitter badge is a 22×22 SVG with ≥2 <path>s
  if (
    svg.getAttribute('viewBox') === '0 0 22 22' &&
    svg.querySelectorAll('path').length >= 2
  ) {
    return true;
  }

  return false;
}

/**
 * Classify the badge colour from its computed CSS `color` property.
 *
 * @param {SVGElement} svg – A verified-badge SVG
 * @returns {'blue'|'gold'|'gray'|null}
 */
function getBadgeColorType(svg) {
  const color = getComputedStyle(svg).color;
  const match = color.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (!match) return null;

  const r = parseInt(match[1], 10);
  const g = parseInt(match[2], 10);
  const b = parseInt(match[3], 10);

  // Blue badge — e.g. rgb(29, 155, 240)
  if (b > 180 && r < 80) return BADGE_TYPES.BLUE;

  // Gold badge — e.g. rgb(229, 175, 29)
  if (r > 180 && g > 140 && b < 80) return BADGE_TYPES.GOLD;

  // Gray badge — approximately equal RGB channels in the mid range
  if (
    Math.abs(r - g) < 40 &&
    Math.abs(g - b) < 40 &&
    r > 70 &&
    r < 200
  ) {
    return BADGE_TYPES.GRAY;
  }

  return null;
}

// ============================================================
// Username Extraction
// ============================================================

/**
 * Extract the primary author's username from a tweet or user-cell element.
 * Looks for the first `<a>` whose href is a bare `/@username` path.
 *
 * @param {HTMLElement} element
 * @returns {string|null} Lowercase username (without @), or null.
 */
function extractUsername(element) {
  const links = element.querySelectorAll('a[role="link"][href]');
  for (const link of links) {
    const href = link.getAttribute('href');
    if (!href) continue;
    const m = href.match(/^\/([a-zA-Z0-9_]{1,15})$/);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// ============================================================
// Following Detection & Whitelist Sync
// ============================================================

/**
 * Save whitelist to chrome.storage.sync immediately.
 */
function saveWhitelistNow() {
  if (!isContextValid()) return;
  _selfSavingWhitelist = true;
  chrome.storage.sync.set({ whitelist: settings.whitelist }, () => {
    _selfSavingWhitelist = false;
  });
}

/**
 * Add a username to the whitelist (if not already present).
 * @param {string} username – Lowercase username
 * @returns {boolean} Whether a new entry was added.
 */
function addToWhitelist(username) {
  if (!username || whitelistSet.has(username)) return false;
  whitelistSet.add(username);
  settings.whitelist.push(username);
  settings.whitelist = sortWhitelist(settings.whitelist);
  return true;
}

/**
 * Remove a username from the whitelist.
 * @param {string} username – Lowercase username
 * @returns {boolean} Whether the entry existed and was removed.
 */
function removeFromWhitelist(username) {
  if (!username || !whitelistSet.has(username)) return false;
  whitelistSet.delete(username);
  settings.whitelist = settings.whitelist.filter(u => u !== username);
  settings.whitelist = sortWhitelist(settings.whitelist);
  return true;
}

/**
 * Check whether a specific element (tweet / UserCell) contains indicators
 * that the author is being followed by the logged-in user.
 *
 * @param {HTMLElement} element
 * @returns {boolean}
 */
function isFollowedInElement(element) {
  // Unfollow button inside this element
  if (element.querySelector('[data-testid$="-unfollow"]')) return true;

  // Button whose text matches "Following" keywords (works on UserCells)
  const buttons = element.querySelectorAll('[role="button"]');
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim().toLowerCase();
    if (FOLLOWING_KEYWORDS.some(kw => text === kw.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Check whether an unfollow button for this username exists anywhere
 * on the current page (sidebar, profile header, other UserCells).
 *
 * @param {string} username – Lowercase username
 * @returns {boolean}
 */
function isFollowedOnPage(username) {
  return !!document.querySelector(`[data-testid="${username}-unfollow"]`);
}

/**
 * Detect if the user is on the "Following" tab of the home timeline.
 *
 * @returns {boolean}
 */
function isOnFollowingTab() {
  if (!/^\/(home)?$/.test(location.pathname)) return false;

  const tabs = document.querySelectorAll('[role="tab"][aria-selected="true"]');
  for (const tab of tabs) {
    const text = (tab.textContent || '').trim().toLowerCase();
    if (FOLLOWING_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

/**
 * Listen for clicks on follow/unfollow buttons to detect real-time
 * follow/unfollow actions by the user.
 */
function setupFollowClickListener() {
  document.addEventListener('click', (e) => {
    // Detect click on an unfollow button → user is about to unfollow
    const unfollowBtn = e.target.closest('[data-testid$="-unfollow"]');
    if (unfollowBtn) {
      const match = (unfollowBtn.getAttribute('data-testid') || '').match(/^(.+)-unfollow$/);
      if (match?.[1]) {
        const username = match[1].toLowerCase();
        // Twitter shows a confirmation dialog; wait for it to be dismissed
        setTimeout(() => {
          if (!isContextValid()) return;
          // If the unfollow button is gone → unfollow was confirmed
          if (!document.querySelector(
            `[data-testid="${match[1]}-unfollow"], [data-testid="${username}-unfollow"]`
          )) {
            if (removeFromWhitelist(username)) {
              saveWhitelistNow();
              rescanAll();
            }
          }
        }, 2000);
      }
      return;
    }

    // Detect click on a follow button → user is about to follow
    const followBtn = e.target.closest('[data-testid$="-follow"]:not([data-testid$="-unfollow"])');
    if (followBtn) {
      const match = (followBtn.getAttribute('data-testid') || '').match(/^(.+)-follow$/);
      if (match?.[1]) {
        const username = match[1].toLowerCase();
        // Follow is instant (no dialog) — save immediately
        if (addToWhitelist(username)) {
          saveWhitelistNow();
          rescanAll();
        }
      }
    }
  }, true);
}

// ============================================================
// Smooth Two-Phase Hiding
// ============================================================

/**
 * Badge-type → display label mapping.
 */
const BADGE_LABELS = Object.freeze({
  [BADGE_TYPES.BLUE]: chrome.i18n.getMessage('badgeBlue'),
  [BADGE_TYPES.GOLD]: chrome.i18n.getMessage('badgeGold'),
  [BADGE_TYPES.GRAY]: chrome.i18n.getMessage('badgeGray'),
});

/**
 * Replace the original tweet / user-cell content with a slim grey
 * placeholder bar.  The bar shows the badge type and allows the user
 * to click to reveal the original content.
 *
 * @param {HTMLElement} element  – The tweet / UserCell container
 * @param {string}      badgeType – One of BADGE_TYPES values
 */
function replaceWithPlaceholder(element, badgeType) {
  // Stash original children so we can restore on click
  const fragment = document.createDocumentFragment();
  while (element.firstChild) {
    fragment.appendChild(element.firstChild);
  }
  // Keep a reference for restoration
  element._blockBlueOriginal = fragment;
  element._blockBlueOriginalPadding = element.style.padding;

  element.setAttribute(REPLACED_ATTR, 'true');

  // Build placeholder bar
  const bar = document.createElement('div');
  bar.className = 'block-blue-placeholder';

  // Badge colour dot
  const dot = document.createElement('span');
  dot.className = `block-blue-placeholder-dot block-blue-placeholder-dot--${badgeType}`;
  bar.appendChild(dot);

  // Text
  const label = BADGE_LABELS[badgeType] || chrome.i18n.getMessage('badgeVerified');
  const text = document.createElement('span');
  text.textContent = chrome.i18n.getMessage('placeholderBlocked', [label]);
  bar.appendChild(text);

  // "Show" link (visible on hover)
  const show = document.createElement('span');
  show.className = 'block-blue-placeholder-show';
  show.textContent = chrome.i18n.getMessage('placeholderShow');
  bar.appendChild(show);

  // Click to reveal
  bar.addEventListener('click', () => {
    restoreElement(element);
  });

  element.appendChild(bar);
}

/**
 * Restore a placeholder-replaced element back to its original content.
 *
 * @param {HTMLElement} element
 */
function restoreElement(element) {
  const original = element._blockBlueOriginal;
  if (!original) return;

  // Remove placeholder
  element.innerHTML = '';
  element.appendChild(original);
  element.removeAttribute(REPLACED_ATTR);
  element.style.padding = element._blockBlueOriginalPadding || '';

  delete element._blockBlueOriginal;
  delete element._blockBlueOriginalPadding;

  // Keep PROCESSED_ATTR so it won't be re-hidden until a full rescan
}

// ============================================================
// Core Processing Logic
// ============================================================

/**
 * Decide whether a container element should be hidden based on the
 * verified badge it contains and the current user settings.
 *
 * @param {HTMLElement} element – A tweet / user-cell container
 * @returns {boolean}
 */
/**
 * Check whether a container element should be blocked, and if so return
 * the badge type.  Returns `null` when the element should NOT be blocked.
 *
 * @param {HTMLElement} element – A tweet / user-cell container
 * @returns {string|null}  One of BADGE_TYPES values, or null.
 */
function getBlockBadgeType(element) {
  if (!settings.enabled) return null;

  const svgs = element.querySelectorAll('svg');
  let badgeType = null;

  for (const svg of svgs) {
    if (!isVerifiedBadge(svg)) continue;

    // Ignore badges that live inside a quoted-tweet card (they belong to a
    // different author)
    if (svg.closest('a[href*="/status/"]')) continue;

    badgeType = getBadgeColorType(svg);
    if (badgeType) break;
  }

  // No recognised badge → do not block
  if (!badgeType) return null;

  // Respect per-type toggles
  if (badgeType === BADGE_TYPES.BLUE && !settings.hideBlue) return null;
  if (badgeType === BADGE_TYPES.GOLD && !settings.hideGold) return null;
  if (badgeType === BADGE_TYPES.GRAY && !settings.hideGray) return null;

  // --- Whitelist check ---
  const username = extractUsername(element);
  if (username && whitelistSet.has(username)) return null;

  // --- Real-time follow detection (at processing time) ---
  if (username) {
    let followed = false;

    // On the Following tab, every tweet author is someone we follow
    if (isOnFollowingTab()) followed = true;

    // This element itself has follow-state indicators (e.g. UserCell)
    if (!followed && isFollowedInElement(element)) followed = true;

    // There's an unfollow button for this user elsewhere on the page
    if (!followed && isFollowedOnPage(username)) followed = true;

    if (followed) {
      addToWhitelist(username);
      saveWhitelistNow();
      return null;
    }
  }

  return badgeType;
}

/**
 * Process a single container element — mark it as scanned and optionally
 * hide it with a smooth animation.
 *
 * @param {HTMLElement} element
 */
function processElement(element) {
  // Skip already-processed elements
  if (element.getAttribute(PROCESSED_ATTR)) return;
  element.setAttribute(PROCESSED_ATTR, 'true');

  const badgeType = getBlockBadgeType(element);
  if (badgeType) {
    replaceWithPlaceholder(element, badgeType);
    hiddenCount++;
  }
}

/**
 * Walk a DOM subtree and process every relevant container found inside it.
 *
 * @param {Node} root
 */
function processTree(root) {
  if (!(root instanceof HTMLElement)) return;

  const selectorString = SELECTORS.join(', ');

  // The root itself might be a target
  if (root.matches && root.matches(selectorString)) {
    processElement(root);
  }

  const elements = root.querySelectorAll(selectorString);
  for (const el of elements) {
    processElement(el);
  }
}

// ============================================================
// Re-scan (settings change / URL navigation)
// ============================================================

/**
 * Clear all processing markers and re-evaluate every container on the page.
 */
function rescanAll() {
  // Restore any placeholder-replaced elements back to original content
  document.querySelectorAll(`[${REPLACED_ATTR}]`).forEach(el => {
    restoreElement(el);
  });
  // Clear processed markers
  document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach(el => {
    el.removeAttribute(PROCESSED_ATTR);
  });

  hiddenCount = 0;

  if (settings.enabled) {
    processTree(document.body);
    startObserver();
  } else {
    stopObserver();
  }

  debouncedSaveHiddenCount();
}

// ============================================================
// MutationObserver
// ============================================================

/**
 * Callback fed to MutationObserver.
 *
 * Processes added nodes **synchronously** (no debounce) so that elements
 * are hidden before the browser paints them, eliminating flicker.
 *
 * @param {MutationRecord[]} mutations
 */
function handleMutations(mutations) {
  if (!settings.enabled || !isContextValid()) return;

  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        processTree(node);
      }
    }
  }

  debouncedSaveHiddenCount();
}

/**
 * (Re-)start the MutationObserver on `document.body`.
 */
function startObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * Disconnect the MutationObserver.
 */
function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// ============================================================
// URL Change Detection (Twitter is a SPA)
// ============================================================

/**
 * Monkey-patch `history.pushState` / `replaceState` and listen for
 * `popstate` so we detect client-side navigation and rescan.
 */
function setupUrlChangeDetection() {
  let lastUrl = location.href;

  const onUrlChange = () => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Give the new view a moment to render before rescanning
      setTimeout(rescanAll, 500);
    }
  };

  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    onUrlChange();
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    onUrlChange();
  };

  window.addEventListener('popstate', onUrlChange);
}

// ============================================================
// Message Handling (popup ↔ content script)
// ============================================================

/**
 * Respond to messages from the popup or background service worker.
 */
function setupMessageListener() {
  if (!isContextValid()) return;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_STATS') {
      sendResponse({ hiddenCount });
      return true; // keep channel open for async response
    }

    if (message.type === 'SETTINGS_CHANGED') {
      loadSettings().then(() => rescanAll());
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'GET_SELF_USERNAME') {
      const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"][href]');
      const href = profileLink ? profileLink.getAttribute('href') : '';
      const match = href ? href.match(/^\/([a-zA-Z0-9_]{1,15})$/) : null;
      sendResponse({ username: match ? match[1].toLowerCase() : null });
      return true;
    }

    return false;
  });
}

// ============================================================
// Storage Change Listener
// ============================================================

/**
 * React to setting changes made in other tabs or by the popup.
 */
function setupStorageListener() {
  if (!isContextValid()) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;

    const keys = Object.keys(changes);
    // Skip internal saves (hiddenCount or our own whitelist sync)
    if (keys.length === 1 && keys[0] === 'hiddenCount') return;
    if (_selfSavingWhitelist && keys.length === 1 && keys[0] === 'whitelist') return;

    loadSettings().then(() => rescanAll());
  });
}

// ============================================================
// Initialisation
// ============================================================

/**
 * Entry point — load settings, wire up listeners, perform the first scan.
 */
async function init() {
  if (!isContextValid()) return;
  await loadSettings();

  // One-time migration: merge old followed-users cache into unified whitelist
  const local = await chrome.storage.local.get({ followedUsers: [] });
  if (Array.isArray(local.followedUsers) && local.followedUsers.length > 0) {
    let migrated = false;
    for (const u of local.followedUsers) {
      if (addToWhitelist(u)) migrated = true;
    }
    if (migrated) saveWhitelistNow();
    chrome.storage.local.remove('followedUsers');
  }

  // Listeners are always active so the plugin can be toggled at runtime
  setupMessageListener();
  setupStorageListener();
  setupUrlChangeDetection();
  setupFollowClickListener();

  if (settings.enabled) {
    processTree(document.body);
    debouncedSaveHiddenCount();
    startObserver();
  }
}

init();
