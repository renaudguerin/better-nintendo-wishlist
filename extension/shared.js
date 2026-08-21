/**
 * Better Wishlist for Nintendo eShop — Shared Pure Helpers
 */
(function () {
  'use strict';

  const SALE_END_URGENT_DAYS = 7;
  const DEFAULT_SORT = 'sale-end';
  const VALID_CONTENT_TYPES = new Set(['all', 'title', 'aoc', 'bundle']);
  const VALID_SORT_VALUES = new Set([
    'name-az',
    'name-za',
    'price-asc',
    'price-desc',
    'discount',
    'release-date',
    'sale-end',
    'date-added-newest',
    'date-added-oldest',
  ]);

  /** Format a sale end date as a localised date string. */
  function formatSaleEnd(isoDate) {
    if (!isoDate) return '';
    const end = new Date(isoDate);
    if (isNaN(end.getTime())) return '';
    const now = new Date();
    if (end - now < 0) return 'Ended';
    return `Ends ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }

  /**
   * Format a release date at the precision Nintendo actually published.
   *
   * Savanna's `releaseDateOnEshop` is variable precision: `2027` for a title
   * announced without a month, `2026-10` for a month-only window, and a full
   * `2026-10-22` once the day is set. Parsing a partial value with `new Date()`
   * would silently invent 1 January, so each shape is formatted separately.
   * Date-only values are built from local parts, because `new Date('2026-10-22')`
   * is UTC midnight and renders as the previous day west of Greenwich.
   */
  function formatReleaseDate(isoDate) {
    if (!isoDate) return '';
    const value = String(isoDate);
    const prefix = 'Out ';
    const parts = value.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:$|T)/);

    if (parts && !parts[2]) return `${prefix}${parts[1]}`;

    // `new Date(2026, 12, 40)` rolls over into a real date, so every calendar
    // component is checked back against the parsed input.
    const localDate = (year, month, day) => {
      const date = new Date(year, month - 1, day);
      const isFaithful = date.getFullYear() === year &&
        date.getMonth() === month - 1 &&
        date.getDate() === day;
      return isFaithful ? date : null;
    };

    if (parts && !parts[3]) {
      const monthOnly = localDate(Number(parts[1]), Number(parts[2]), 1);
      if (!monthOnly) return '';
      return `${prefix}${monthOnly.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`;
    }

    const release = parts && !value.includes('T')
      ? localDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))
      : new Date(value);
    if (!release || isNaN(release.getTime())) return '';
    const options = release.getFullYear() === new Date().getFullYear()
      ? { month: 'long', day: 'numeric' }
      : { month: 'long', day: 'numeric', year: 'numeric' };
    return `${prefix}${release.toLocaleDateString(undefined, options)}`;
  }

  /** Is this sale ending within SALE_END_URGENT_DAYS? */
  function isSaleEndUrgent(isoDate, urgencyDays) {
    if (!isoDate) return false;
    const end = new Date(isoDate);
    const days = Number.isInteger(urgencyDays) && urgencyDays >= 1 && urgencyDays <= 30
      ? urgencyDays
      : SALE_END_URGENT_DAYS;
    return (end - new Date()) < days * 24 * 60 * 60 * 1000;
  }

  function createComparator(sortBy) {
    const compareOriginalOrder = (a, b) => a.originalIndex - b.originalIndex;
    const compareMissingLast = (a, b, comparePresent) => {
      const aPresent = a !== null && a !== undefined;
      const bPresent = b !== null && b !== undefined;
      if (aPresent && bPresent) return comparePresent(a, b);
      if (aPresent) return -1;
      if (bPresent) return 1;
      return 0;
    };
    const getTimestamp = (value) => {
      if (value === null || value === undefined || value === '') return null;
      const timestamp = new Date(value).getTime();
      return Number.isFinite(timestamp) ? timestamp : null;
    };
    const compareDates = (a, b, direction) => compareMissingLast(
      getTimestamp(a), getTimestamp(b), (left, right) => direction * (left - right));
    const comparePrices = (a, b, direction) => compareMissingLast(
      Number.isFinite(a) ? a : null,
      Number.isFinite(b) ? b : null,
      (left, right) => direction * (left - right));

    const comparators = {
      'name-az': (a, b) => a.name.localeCompare(b.name),
      'name-za': (a, b) => b.name.localeCompare(a.name),
      'price-asc': (a, b) => comparePrices(a.price, b.price, 1),
      'price-desc': (a, b) => comparePrices(a.price, b.price, -1),
      'discount': (a, b) => b.discountPct - a.discountPct,
      'release-date': (a, b) => compareDates(a.releaseDate, b.releaseDate, -1),
      'sale-end': (a, b) => compareDates(a.saleEnd, b.saleEnd, 1),
      'date-added-newest': (a, b) => compareDates(a.addedAt, b.addedAt, -1),
      'date-added-oldest': (a, b) => compareDates(a.addedAt, b.addedAt, 1),
    };

    const isDateAddedSort = sortBy === 'date-added-newest' || sortBy === 'date-added-oldest';
    const selectedSort = Object.hasOwn(comparators, sortBy) ? sortBy : DEFAULT_SORT;
    const cmp = comparators[selectedSort];

    return (a, b) => {
      const aUnavailable = a.status === 'unavailable';
      const bUnavailable = b.status === 'unavailable';
      if (!isDateAddedSort) {
        if (aUnavailable && !bUnavailable) return 1;
        if (!aUnavailable && bUnavailable) return -1;
      }

      return cmp(a, b) || compareOriginalOrder(a, b);
    };
  }

  function normalizeItemStatus(itemData) {
    return itemData && itemData.availability === 'available' ? 'available' : 'unavailable';
  }

  /** Repair persisted filter/sort preferences against an adapter capability schema. */
  function repairPreferences(preferences, capabilities, options) {
    const saved = preferences && typeof preferences === 'object' && !Array.isArray(preferences)
      ? preferences
      : {};
    const filters = capabilities && capabilities.filters ? capabilities.filters : {};
    const supportedSorts = new Set(capabilities && Array.isArray(capabilities.sorts)
      ? capabilities.sorts
      : VALID_SORT_VALUES);
    const contentType = filters.contentType !== false &&
      typeof saved.contentType === 'string' && VALID_CONTENT_TYPES.has(saved.contentType)
      ? saved.contentType
      : 'all';
    const fallbackSort = supportedSorts.has(DEFAULT_SORT)
      ? DEFAULT_SORT
      : (supportedSorts.values().next().value || DEFAULT_SORT);
    const sortBy = typeof saved.sortBy === 'string' && supportedSorts.has(saved.sortBy)
      ? saved.sortBy
      : fallbackSort;
    const validPlatforms = new Set(['all', ...((capabilities && capabilities.platforms) || [])
      .map((platform) => platform.code)]);
    let platform = filters.platform !== false && typeof saved.platform === 'string'
      ? saved.platform
      : 'all';
    const deferPlatformValidation = Boolean(options && options.deferPlatformValidation);
    if (!deferPlatformValidation && !validPlatforms.has(platform)) platform = 'all';

    const onSale = filters.onSale !== false && saved.onSale === true;
    return {
      filters: { onSale, platform, contentType },
      sortBy,
      repaired: saved.onSale !== onSale || saved.platform !== platform ||
        saved.contentType !== contentType || saved.sortBy !== sortBy,
    };
  }

  function itemMatchesFilters(itemView, filters) {
    if (!itemView) return false;

    if (itemView.status === 'unavailable' && itemView.catalogRelation !== 'foreign') {
      if (filters.search || filters.platform !== 'all' || filters.contentType !== 'all') return false;
    }
    if (filters.search && !itemView.name.toLowerCase().includes(filters.search.toLowerCase())) return false;
    if (filters.onSale && (itemView.status === 'unavailable' || itemView.discountPct === null)) return false;
    if (filters.platform !== 'all' && itemView.platform !== filters.platform) return false;
    if (filters.contentType !== 'all' && itemView.contentType !== filters.contentType) return false;
    return true;
  }

  function getVisibleSelection(visibleIds, selectedIds) {
    const visible = Array.from(visibleIds);
    const selected = Array.from(selectedIds);
    const selectedSet = new Set(selected);
    const visibleSet = new Set(visible);
    const visibleSelectedIds = visible.filter((id) => selectedSet.has(id));
    const hiddenSelectedCount = selected.reduce(
      (count, id) => count + (visibleSet.has(id) ? 0 : 1), 0);

    return {
      visibleCount: visible.length,
      selectedVisibleCount: visibleSelectedIds.length,
      hiddenSelectedCount,
      visibleSelectedIds,
    };
  }

  /** Decide the master-checkbox action from its new checked state. */
  function getSelectAllAction(selection, checked) {
    if (typeof checked === 'boolean') {
      return checked ? 'select-visible' : 'clear-all';
    }
    const visibleCount = Number(selection && selection.visibleCount) || 0;
    const selectedVisibleCount = Number(selection && selection.selectedVisibleCount) || 0;
    return visibleCount > 0 && selectedVisibleCount === visibleCount
      ? 'clear-all'
      : 'select-visible';
  }

  let operationLocked = false;

  /** Run one async operation at a time. Returns false when another operation owns the lock. */
  async function withLock(fn) {
    if (typeof fn !== 'function') throw new TypeError('Locked operation must be a function');
    if (operationLocked) return false;

    operationLocked = true;
    try {
      await fn();
      return true;
    } finally {
      operationLocked = false;
    }
  }

  /** If a mount point's parent chain (up to, not including, boundary) crosses
   *  a container hidden by the active native policy, re-anchor the insertion just
   *  before the TOPMOST hidden ancestor so inserted nodes stay visible.
   *  Extra fields on the mount object (e.g. hr) are passed through. */
  function hoistMountPoint(boundary, mount, hiddenSelectors) {
    const selector = Array.isArray(hiddenSelectors)
      ? hiddenSelectors.join(',')
      : hiddenSelectors;
    if (typeof selector !== 'string' || !selector.trim()) return mount;

    let topmostHidden = null;
    for (let node = mount.parent; node && node !== boundary; node = node.parentElement) {
      if (node.nodeType === 1 && node.matches(selector)) {
        topmostHidden = node;
      }
    }

    if (!topmostHidden || !topmostHidden.parentNode) return mount;
    return { ...mount, parent: topmostHidden.parentNode, before: topmostHidden };
  }

  /** If the mount point sits inside a policy-defined width-capped wrapper, re-anchor
   *  it just AFTER the topmost such wrapper (the heading stays inside it,
   *  above our UI) so the container query sees the full section width. */
  function hoistBelowWidthCap(boundary, mount, widthCapSelector) {
    if (typeof widthCapSelector !== 'string' || !widthCapSelector.trim()) return mount;

    let topmostCapped = null;
    for (let node = mount.parent; node && node !== boundary; node = node.parentElement) {
      if (node.nodeType === 1 && node.matches(widthCapSelector)) {
        topmostCapped = node;
      }
    }

    if (!topmostCapped || !topmostCapped.parentNode) return mount;
    return { ...mount, parent: topmostCapped.parentNode, before: topmostCapped.nextSibling };
  }

  /** Create a one-shot LIFO rollback stack for provisional mutations. */
  function makeRollback() {
    let steps = [];

    return Object.freeze({
      add(step) {
        if (typeof step !== 'function') {
          throw new TypeError('Rollback step must be a function');
        }
        steps.push(step);
      },
      clear() {
        steps = [];
      },
      run() {
        const errors = [];
        const pending = steps;
        steps = [];

        for (let i = pending.length - 1; i >= 0; i--) {
          try {
            pending[i]();
          } catch (err) {
            errors.push(err);
          }
        }

        return errors;
      },
    });
  }

  /** Return the start offsets for fixed-interval attempts before a deadline. */
  function getPollSchedule(intervalMs, totalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 ||
        !Number.isFinite(totalMs) || totalMs <= 0) {
      return [];
    }

    const offsets = [];
    for (let offset = 0; offset < totalMs; offset += intervalMs) {
      offsets.push(offset);
    }
    return offsets;
  }

  globalThis.NWM = Object.freeze({
    hoistMountPoint,
    hoistBelowWidthCap,
    formatSaleEnd,
    formatReleaseDate,
    isSaleEndUrgent,
    createComparator,
    normalizeItemStatus,
    repairPreferences,
    itemMatchesFilters,
    getVisibleSelection,
    getSelectAllAction,
    withLock,
    makeRollback,
    getPollSchedule,
  });
})();
