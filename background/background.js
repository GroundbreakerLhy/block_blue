'use strict';

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
// Installation
// ============================================================

/**
 * On first install, write default settings to chrome.storage.sync.
 * On update, merge any new keys without overwriting user preferences.
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.set(DEFAULT_SETTINGS);
    return;
  }

  if (details.reason === 'update') {
    chrome.storage.sync.get(null, (existing) => {
      const merged = { ...DEFAULT_SETTINGS, ...existing };
      chrome.storage.sync.set(merged);
    });
  }
});
