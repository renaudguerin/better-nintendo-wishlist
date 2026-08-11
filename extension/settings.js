/**
 * Better Wishlist for Nintendo eShop — Extension-wide Settings
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'nwm_settings_v1';
  const STORAGE_KEYS = Object.freeze({
    showCrossRegion: `${STORAGE_KEY}_showCrossRegion`,
    saleUrgencyDays: `${STORAGE_KEY}_saleUrgencyDays`,
    theme: `${STORAGE_KEY}_theme`,
  });
  const DEFAULTS = Object.freeze({
    showCrossRegion: false,
    saleUrgencyDays: 7,
    theme: 'system',
  });
  let cached = { ...DEFAULTS };
  const generations = {
    showCrossRegion: 0,
    saleUrgencyDays: 0,
    theme: 0,
  };

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function repair(value) {
    const candidate = isObject(value) ? value : {};
    return {
      showCrossRegion: typeof candidate.showCrossRegion === 'boolean'
        ? candidate.showCrossRegion
        : DEFAULTS.showCrossRegion,
      saleUrgencyDays: Number.isInteger(candidate.saleUrgencyDays) &&
        candidate.saleUrgencyDays >= 1 && candidate.saleUrgencyDays <= 30
        ? candidate.saleUrgencyDays
        : DEFAULTS.saleUrgencyDays,
      theme: ['system', 'light', 'dark'].includes(candidate.theme)
        ? candidate.theme
        : DEFAULTS.theme,
    };
  }

  function decodeStored(result) {
    const source = isObject(result) ? result : {};
    return repair({
      showCrossRegion: source[STORAGE_KEYS.showCrossRegion],
      saleUrgencyDays: source[STORAGE_KEYS.saleUrgencyDays],
      theme: source[STORAGE_KEYS.theme],
    });
  }

  function getStorage() {
    try {
      return globalThis.chrome && globalThis.chrome.storage && globalThis.chrome.storage.local;
    } catch (_err) {
      return null;
    }
  }

  function runtimeFailed() {
    try {
      return Boolean(globalThis.chrome && globalThis.chrome.runtime &&
        globalThis.chrome.runtime.lastError);
    } catch (_err) {
      return true;
    }
  }

  function load() {
    return new Promise((resolve) => {
      const storage = getStorage();
      if (!storage || typeof storage.get !== 'function') {
        resolve({ ...cached });
        return;
      }
      try {
        const readGenerations = { ...generations };
        storage.get(Object.values(STORAGE_KEYS), (result) => {
          if (runtimeFailed()) {
            resolve({ ...cached });
            return;
          }
          const decoded = decodeStored(result);
          const merged = { ...cached };
          for (const field of Object.keys(STORAGE_KEYS)) {
            if (generations[field] === readGenerations[field]) {
              merged[field] = decoded[field];
            }
          }
          cached = merged;
          resolve({ ...cached });
        });
      } catch (_err) {
        resolve({ ...cached });
      }
    });
  }

  async function update(patch) {
    const previous = await load();
    const candidate = isObject(patch) ? patch : {};
    const next = { ...previous };
    const record = {};
    if (Object.hasOwn(candidate, 'showCrossRegion') &&
        typeof candidate.showCrossRegion === 'boolean') {
      next.showCrossRegion = candidate.showCrossRegion;
      record[STORAGE_KEYS.showCrossRegion] = next.showCrossRegion;
    }
    if (Object.hasOwn(candidate, 'saleUrgencyDays') &&
        Number.isInteger(candidate.saleUrgencyDays) &&
        candidate.saleUrgencyDays >= 1 && candidate.saleUrgencyDays <= 30) {
      next.saleUrgencyDays = candidate.saleUrgencyDays;
      record[STORAGE_KEYS.saleUrgencyDays] = next.saleUrgencyDays;
    }
    if (Object.hasOwn(candidate, 'theme') &&
        ['system', 'light', 'dark'].includes(candidate.theme)) {
      next.theme = candidate.theme;
      record[STORAGE_KEYS.theme] = next.theme;
    }
    if (Object.keys(record).length === 0) return previous;
    const storage = getStorage();
    if (!storage || typeof storage.set !== 'function') return previous;
    const writeGenerations = { ...generations };

    return new Promise((resolve) => {
      try {
        storage.set(record, () => {
          if (runtimeFailed()) {
            resolve({ ...cached });
            return;
          }
          const committed = { ...cached };
          if (Object.hasOwn(record, STORAGE_KEYS.showCrossRegion)) {
            if (generations.showCrossRegion === writeGenerations.showCrossRegion) {
              committed.showCrossRegion = next.showCrossRegion;
            }
          }
          if (Object.hasOwn(record, STORAGE_KEYS.saleUrgencyDays)) {
            if (generations.saleUrgencyDays === writeGenerations.saleUrgencyDays) {
              committed.saleUrgencyDays = next.saleUrgencyDays;
            }
          }
          if (Object.hasOwn(record, STORAGE_KEYS.theme) &&
              generations.theme === writeGenerations.theme) {
            committed.theme = next.theme;
          }
          cached = committed;
          resolve({ ...cached });
        });
      } catch (_err) {
        resolve(previous);
      }
    });
  }

  function subscribe(listener) {
    let changes;
    try {
      changes = globalThis.chrome && globalThis.chrome.storage &&
        globalThis.chrome.storage.onChanged;
    } catch (_err) {
      changes = null;
    }
    if (typeof listener !== 'function' || !changes || typeof changes.addListener !== 'function') {
      return () => {};
    }

    const onChanged = (entries, areaName) => {
      if (areaName !== 'local' || !isObject(entries)) return;
      let changed = false;
      const next = { ...cached };
      if (entries[STORAGE_KEYS.showCrossRegion]) {
        const value = entries[STORAGE_KEYS.showCrossRegion].newValue;
        next.showCrossRegion = typeof value === 'boolean' ? value : DEFAULTS.showCrossRegion;
        generations.showCrossRegion++;
        changed = true;
      }
      if (entries[STORAGE_KEYS.saleUrgencyDays]) {
        const value = entries[STORAGE_KEYS.saleUrgencyDays].newValue;
        next.saleUrgencyDays = Number.isInteger(value) && value >= 1 && value <= 30
          ? value
          : DEFAULTS.saleUrgencyDays;
        generations.saleUrgencyDays++;
        changed = true;
      }
      if (entries[STORAGE_KEYS.theme]) {
        const value = entries[STORAGE_KEYS.theme].newValue;
        next.theme = ['system', 'light', 'dark'].includes(value) ? value : DEFAULTS.theme;
        generations.theme++;
        changed = true;
      }
      if (!changed) return;
      cached = next;
      listener({ ...cached });
    };
    try {
      changes.addListener(onChanged);
    } catch (_err) {
      return () => {};
    }
    return () => {
      try {
        if (typeof changes.removeListener === 'function') changes.removeListener(onChanged);
      } catch (_err) { /* unavailable extension context */ }
    };
  }

  globalThis.NWMSettings = Object.freeze({
    STORAGE_KEY,
    STORAGE_KEYS,
    DEFAULTS,
    repair,
    load,
    update,
    subscribe,
  });
})();
