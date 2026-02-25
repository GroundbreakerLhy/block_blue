'use strict';

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

/** Manual whitelist stored as a Set for O(1) lookup (lowercase usernames) */
let whitelistSet = new Set();

/**
 * Auto-detected followed users (session cache).
 * Populated by scanning DOM for "Following" indicators.
 */
let followedUsersSet = new Set();

/** Running count of elements hidden during this page session */
let hiddenCount = 0;

/** MutationObserver instance */
let observer = null;

/** Timer id for batched storage writes of hiddenCount */
let saveTimer = null;

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
 * Load settings from chrome.storage.sync and refresh local state.
 * @returns {Promise<void>}
 */
async function loadSettings() {
  const result = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings.enabled = result.enabled;
  settings.hideBlue = result.hideBlue;
  settings.hideGold = result.hideGold;
  settings.hideGray = result.hideGray;
  settings.whitelist = Array.isArray(result.whitelist) ? result.whitelist : [];
  whitelistSet = new Set(settings.whitelist.map(u => u.toLowerCase()));
  hiddenCount = typeof result.hiddenCount === 'number' ? result.hiddenCount : 0;
}

/**
 * Persist hiddenCount back to storage (debounced to avoid rate-limit).
 */
function debouncedSaveHiddenCount() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
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
// Following Detection
// ============================================================

/**
 * Check whether the logged-in user follows the author of a tweet / user-cell,
 * based on DOM cues visible inside the container.
 *
 * Signals checked (in order of reliability):
 *  1. A `<span>` or `<button>` containing "Following"-like text inside the element.
 *     (Twitter renders a "Following" button or label for followed accounts.)
 *  2. The current timeline tab is "Following" — everyone shown there is followed.
 *
 * @param {HTMLElement} element – A tweet or UserCell container
 * @returns {boolean}
 */
function isFollowedUser(element) {
  // ---------- Signal 1: "Following" button / span within the element ----------
  // Twitter uses a div/span with "Following" text, or a button with aria-label
  // containing "Following @username" for the follow state.
  const buttons = element.querySelectorAll(
    '[role="button"], button, [data-testid$="-unfollow"], [data-testid$="-follow"]'
  );
  for (const btn of buttons) {
    const text = (btn.textContent || '').trim().toLowerCase();
    const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
    const combined = text + ' ' + ariaLabel;

    if (FOLLOWING_KEYWORDS.some(kw => combined.includes(kw.toLowerCase()))) {
      return true;
    }
  }

  // ---------- Signal 2: "Following" tab detection ----------
  // If user is on the "Following" tab of the home timeline, all tweets are
  // from followed accounts.
  if (isOnFollowingTab()) return true;

  return false;
}

/**
 * Cache flag for the "Following" tab check (refreshed on URL change).
 * null = not yet checked; true/false = cached result.
 */
let _onFollowingTab = null;

/**
 * Detect if the user is on the "Following" tab of the home timeline.
 * Reads from a cached value that is cleared on URL changes.
 *
 * @returns {boolean}
 */
function isOnFollowingTab() {
  if (_onFollowingTab !== null) return _onFollowingTab;

  // Only applies to the home page
  if (!/^\/(home)?$/.test(location.pathname)) {
    _onFollowingTab = false;
    return false;
  }

  // The active tab has aria-selected="true"
  const tabs = document.querySelectorAll('[role="tab"][aria-selected="true"]');
  for (const tab of tabs) {
    const text = (tab.textContent || '').trim().toLowerCase();
    if (FOLLOWING_KEYWORDS.some(kw => text.includes(kw.toLowerCase()))) {
      _onFollowingTab = true;
      return true;
    }
  }

  _onFollowingTab = false;
  return false;
}

// ============================================================
// Smooth Two-Phase Hiding
// ============================================================

/**
 * Badge-type → display label mapping.
 */
const BADGE_LABELS = Object.freeze({
  [BADGE_TYPES.BLUE]: '蓝标',
  [BADGE_TYPES.GOLD]: '金标',
  [BADGE_TYPES.GRAY]: '灰标',
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
  const label = BADGE_LABELS[badgeType] || '认证';
  const text = document.createElement('span');
  text.textContent = `${label}用户内容已被屏蔽`;
  bar.appendChild(text);

  // "Show" link (visible on hover)
  const show = document.createElement('span');
  show.className = 'block-blue-placeholder-show';
  show.textContent = '点击显示';
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

  // --- Whitelist checks ---
  const username = extractUsername(element);

  // Manual whitelist
  if (username && whitelistSet.has(username)) return null;

  // Auto-detected followed users
  if (username && followedUsersSet.has(username)) return null;

  // Detect following status from DOM and cache it
  if (username && isFollowedUser(element)) {
    followedUsersSet.add(username);
    return null;
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
  // Invalidate Following-tab cache
  _onFollowingTab = null;

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
  if (!settings.enabled) return;

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
      // Invalidate Following-tab cache on navigation
      _onFollowingTab = null;
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
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_STATS') {
      sendResponse({
        hiddenCount,
        autoFollowedCount: followedUsersSet.size,
      });
      return true; // keep channel open for async response
    }

    if (message.type === 'SETTINGS_CHANGED') {
      loadSettings().then(() => rescanAll());
      sendResponse({ ok: true });
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
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;

    // Avoid a feedback loop: if only hiddenCount changed, ignore it
    const keys = Object.keys(changes);
    if (keys.length === 1 && keys[0] === 'hiddenCount') return;

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
  await loadSettings();

  // Listeners are always active so the plugin can be toggled at runtime
  setupMessageListener();
  setupStorageListener();
  setupUrlChangeDetection();

  if (settings.enabled) {
    processTree(document.body);
    debouncedSaveHiddenCount();
    startObserver();
  }
}

init();
