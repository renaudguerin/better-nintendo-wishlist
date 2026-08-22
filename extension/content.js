/**
 * Better Wishlist for Nintendo eShop — Content Script
 * Adds filtering, searching, and sorting to the Nintendo eShop wishlist page.
 */
(function () {
  'use strict';

  const adapterRegistry = globalThis.NWMAdapters;
  const adapter = adapterRegistry && adapterRegistry.find(window.location);
  if (!adapter) return;

  const NWM = globalThis.NWM;
  if (!NWM) {
    console.error('[NWM] Shared helpers are missing; aborting initialization');
    return;
  }
  const settingsApi = globalThis.NWMSettings || Object.freeze({
    DEFAULTS: Object.freeze({ showCrossRegion: false, saleUrgencyDays: 7, theme: 'system' }),
    repair: (value) => ({
      showCrossRegion: value && value.showCrossRegion === true,
      saleUrgencyDays: value && Number.isInteger(value.saleUrgencyDays) &&
        value.saleUrgencyDays >= 1 && value.saleUrgencyDays <= 30
        ? value.saleUrgencyDays
        : 7,
      theme: value && ['system', 'light', 'dark'].includes(value.theme)
        ? value.theme
        : 'system',
    }),
    load: async () => ({ showCrossRegion: false, saleUrgencyDays: 7, theme: 'system' }),
    update: async (patch) => ({
      showCrossRegion: patch?.showCrossRegion === true,
      saleUrgencyDays: 7,
      theme: ['system', 'light', 'dark'].includes(patch?.theme) ? patch.theme : 'system',
    }),
    subscribe: () => () => {},
  });
  const nativePolicy = adapter.getNativePolicy();
  if (!nativePolicy || typeof nativePolicy.rootSelector !== 'string' ||
      typeof nativePolicy.findSection !== 'function' ||
      typeof nativePolicy.getMountPoint !== 'function') {
    console.error(`[NWM] Adapter "${adapter.id}" returned an invalid native policy`);
    return;
  }

  // ── Constants ──────────────────────────────────────────────────────────
  const DEBOUNCE_MS = 200;
  const BULK_DELETE_DELAY_MS = 150;
  const LOCK_NOTICE_MS = 2500;
  const STORAGE_KEY = 'nwm_preferences';
  const MANAGED_NATIVE_CLASS = 'nwm-managed-native';

  // ── State ──────────────────────────────────────────────────────────────
  let allItemIds = [];
  let itemData = new Map(); // id -> exact canonical adapter item
  let domNodes = new Map();   // id -> DOM element
  let scrollContainer = null;
  let sectionEl = null;
  let toolbarEl = null;
  let nativeSuppressObserver = null;
  let isLoading = false;
  let isBulkDeleting = false;
  let loadStatus = { reportedTotal: 0, partial: false };
  let hasCommittedSnapshot = false;
  let statusSummary = null;
  let statusOverride = null;
  let lockNotice = '';
  let lockNoticeTimer = null;
  let globalSettings = { ...settingsApi.DEFAULTS };
  let settingsLoaded = false;
  let crossRegionRefreshScheduled = false;
  let crossRegionRefreshRunning = false;
  const selectedIds = new Set();
  const staticCapabilities = adapterRegistry.normalizeCapabilities(adapter.getCapabilities());
  let capabilities = staticCapabilities;

  // Filter/sort state
  let filters = {
    search: '',
    onSale: false,
    platform: 'all',
    contentType: 'all', // 'all', 'title', 'bundle', 'aoc'
  };
  let sortBy = 'sale-end';

  // ── Utilities ──────────────────────────────────────────────────────────

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function showLockNotice() {
    lockNotice = 'Please wait for the current wishlist action to finish';
    clearTimeout(lockNoticeTimer);
    lockNoticeTimer = setTimeout(() => {
      lockNotice = '';
      renderStatus();
    }, LOCK_NOTICE_MS);
    renderStatus();
  }

  async function runWithLock(fn) {
    const acquired = await NWM.withLock(fn);
    if (!acquired) showLockNotice();
    return acquired;
  }

  function loadPreferences() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const repaired = NWM.repairPreferences(JSON.parse(saved), capabilities, {
          deferPlatformValidation: true,
        });
        filters = { ...filters, ...repaired.filters };
        sortBy = repaired.sortBy;
        return repaired.repaired;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  function savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        onSale: filters.onSale,
        platform: filters.platform,
        contentType: filters.contentType,
        sortBy,
      }));
    } catch (e) { /* ignore */ }
  }

  // ── Data Loading ──────────────────────────────────────────────────────

  function getSnapshotCapabilities(snapshot) {
    const candidate = adapterRegistry.normalizeCapabilities(adapter.getCapabilities(snapshot));
    const staticSignature = ({ filters, sorts, actions, crossRegionResolution }) => JSON.stringify({
      filters,
      sorts,
      actions,
      crossRegionResolution,
    });
    if (staticSignature(candidate) !== staticSignature(staticCapabilities)) {
      throw new Error(`Adapter "${adapter.id}" changed static capabilities after loading`);
    }
    return {
      filters: staticCapabilities.filters,
      sorts: staticCapabilities.sorts,
      actions: staticCapabilities.actions,
      platforms: candidate.platforms,
    };
  }

  async function loadSnapshot(options) {
    const includeCrossRegion = options && typeof options.includeCrossRegion === 'boolean'
      ? options.includeCrossRegion
      : globalSettings.showCrossRegion && staticCapabilities.crossRegionResolution;
    const snapshot = await adapter.loadItems({ includeCrossRegion });
    adapterRegistry.validateSnapshot(snapshot);
    if (snapshot.adapterId !== adapter.id) {
      throw new Error(`Adapter "${adapter.id}" returned snapshot for "${snapshot.adapterId}"`);
    }
    const snapshotItemData = new Map();
    const ids = [];

    for (const item of snapshot.items) {
      const id = item.id;
      ids.push(id);
      snapshotItemData.set(id, item);
    }

    const uiSnapshot = {
      ids,
      itemData: snapshotItemData,
      capabilities: getSnapshotCapabilities(snapshot),
      meta: {
        reportedTotal: snapshot.total,
        partial: snapshot.partial,
      },
    };

    console.log('[NWM] Loaded', ids.length, 'wishlist items');
    return uiSnapshot;
  }

  function isItemMutationEligible(item) {
    if (!item || item.canDelete !== true) return false;
    return !(staticCapabilities.crossRegionResolution &&
      item.availability === 'unavailable' &&
      item.resolutionStatus === 'not-requested');
  }

  async function deleteWishlistItem(id) {
    const item = itemData.get(String(id));
    if (!capabilities.actions.delete || !isItemMutationEligible(item)) {
      throw new Error('This wishlist item cannot be deleted');
    }
    await adapter.deleteItem(item);
    return true;
  }

  function removeItemFromState(id) {
    const sid = String(id);
    const idx = allItemIds.indexOf(sid);
    if (idx !== -1) allItemIds.splice(idx, 1);
    itemData.delete(sid);
    selectedIds.delete(sid);
    const node = domNodes.get(sid);
    if (node) node.remove();
    domNodes.delete(sid);
  }

  function pruneSelection() {
    const validIds = new Set(capabilities.actions.select
      ? allItemIds.filter((id) => isItemMutationEligible(itemData.get(id)))
      : []);
    for (const id of [...selectedIds]) {
      if (!validIds.has(id)) selectedIds.delete(id);
    }
  }

  function getVisibleItemIds() {
    return allItemIds.filter((id) => itemMatchesFilters(id));
  }

  function getVisibleSelectableItemIds() {
    if (!capabilities.actions.select) return [];
    return getVisibleItemIds().filter((id) => isItemMutationEligible(itemData.get(id)));
  }

  function syncItemSelectionState(id) {
    const node = domNodes.get(id);
    if (!node) return;
    const selected = selectedIds.has(id);
    node.classList.toggle('nwm-item-selected', selected);
    const checkbox = node.querySelector('.nwm-select-checkbox');
    if (checkbox) checkbox.checked = selected;
  }

  function updateSelectionUi() {
    pruneSelection();

    for (const id of domNodes.keys()) {
      syncItemSelectionState(id);
    }

    const visibleIds = getVisibleSelectableItemIds();
    const selection = NWM.getVisibleSelection(visibleIds, selectedIds);
    const visibleCount = selection.visibleCount;
    const selectedVisibleCount = selection.selectedVisibleCount;

    const selectAll = document.getElementById('nwm-select-all');
    if (selectAll) {
      selectAll.disabled = isBulkDeleting || visibleCount === 0;
      selectAll.checked = visibleCount > 0 && selectedVisibleCount === visibleCount;
      selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleCount;
    }

    const bulkDeleteBtn = document.getElementById('nwm-bulk-delete');
    if (bulkDeleteBtn) {
      bulkDeleteBtn.style.display = selectedVisibleCount > 0 ? '' : 'none';
      bulkDeleteBtn.disabled = isBulkDeleting || loadStatus.partial;
      bulkDeleteBtn.textContent = selectedVisibleCount > 0
        ? `Remove selected (${selectedVisibleCount})`
        : 'Remove selected';
    }

    renderStatus();
  }

  async function bulkDeleteSelectedItems() {
    return runWithLock(async () => {
      if (!capabilities.actions.bulkDelete) return;
      const selection = NWM.getVisibleSelection(getVisibleSelectableItemIds(), selectedIds);
      const ids = selection.visibleSelectedIds;
      if (ids.length === 0 || loadStatus.partial) return;

      const label = ids.length === 1 ? 'item' : 'items';
      let confirmMessage = `Remove ${ids.length} selected ${label} from your wishlist?`;
      if (selection.hiddenSelectedCount > 0) {
        const hiddenLabel = selection.hiddenSelectedCount === 1 ? 'item is' : 'items are';
        confirmMessage += `\n\n${selection.hiddenSelectedCount} other selected ${hiddenLabel} filtered out and will not be removed.`;
      }
      if (!confirm(confirmMessage)) return;

      isBulkDeleting = true;
      updateSelectionUi();

      let deleted = 0;
      const failures = [];

      try {
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          updateStatus(`Removing ${i + 1} of ${ids.length} selected items…`);

          const node = domNodes.get(id);
          const deleteBtn = node && node.querySelector('.nwm-delete-btn');
          if (deleteBtn) {
            deleteBtn.disabled = true;
            deleteBtn.style.opacity = '0.3';
          }

          try {
            await deleteWishlistItem(id);
            removeItemFromState(id);
            deleted++;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            failures.push({ id, message });
            console.warn(`[NWM] Bulk delete failed for ${id}:`, message);
            if (deleteBtn) {
              deleteBtn.disabled = false;
              deleteBtn.style.opacity = '';
            }
          }

          updateSelectionUi();

          if (i + 1 < ids.length) {
            await sleep(BULK_DELETE_DELAY_MS);
          }
        }
      } finally {
        isBulkDeleting = false;
        updateSelectionUi();
        applyFiltersAndSort();
      }

      if (failures.length > 0) {
        const failedLabel = failures.length === 1 ? 'item' : 'items';
        const details = failures
          .slice(0, 3)
          .map((failure) => `${failure.id}: ${failure.message}`)
          .join('\n');
        const suffix = failures.length > 3 ? `\n...and ${failures.length - 3} more.` : '';
        alert(`Removed ${deleted} of ${ids.length} selected items. ${failures.length} ${failedLabel} could not be removed.\n${details}${suffix}`);
      }
    });
  }

  // ── DOM Manipulation ──────────────────────────────────────────────────

  function findWishlistSection() {
    return nativePolicy.findSection(document);
  }

  function waitForSection(timeoutMs) {
    const existing = findWishlistSection();
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const section = findWishlistSection();
        if (!section) return;
        cleanup();
        resolve(section);
      });

      const cleanup = () => {
        observer.disconnect();
        clearTimeout(timeoutId);
      };

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Wishlist section not found before timeout'));
      }, timeoutMs || 10000);

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  function isExtensionNode(node) {
    if (!node) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(element && (
      element.id === 'nwm-toolbar' ||
      element.id === 'nwm-item-list' ||
      element.classList.contains('nwm-item-managed') ||
      element.querySelector('#nwm-toolbar, #nwm-item-list') ||
      element.closest('#nwm-toolbar, #nwm-item-list')
    ));
  }

  function isExtensionOwnedTarget(node) {
    if (!node) return false;
    const element = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(element && (
      element.id === 'nwm-toolbar' ||
      element.id === 'nwm-item-list' ||
      element.classList.contains('nwm-item-managed') ||
      element.closest('#nwm-toolbar, #nwm-item-list')
    ));
  }

  function getNativeMountPoint(section) {
    return nativePolicy.getMountPoint(section);
  }

  function hideDividerProvisionally(hr, rollback) {
    if (!hr) return;
    const previousStyle = hr.getAttribute('style');
    hr.style.display = 'none';
    rollback.add(() => {
      if (previousStyle == null) hr.removeAttribute('style');
      else hr.setAttribute('style', previousStyle);
    });
  }

  function mountProvisionalToolbar(toolbar, rollback) {
    const mount = getNativeMountPoint(sectionEl);
    hideDividerProvisionally(mount.hr, rollback);
    mount.parent.insertBefore(toolbar, mount.before);
    rollback.add(() => toolbar.remove());
  }

  function removeDuplicateOwnedIds(id, keepNode) {
    for (const node of document.querySelectorAll(`#${id}`)) {
      if (node !== keepNode && isExtensionNode(node)) node.remove();
    }
  }

  function mountManagedNodes(targetSection) {
    if (!toolbarEl || !scrollContainer) return;

    removeDuplicateOwnedIds('nwm-toolbar', toolbarEl);
    removeDuplicateOwnedIds('nwm-item-list', scrollContainer);

    const mount = getNativeMountPoint(targetSection);
    if (mount.hr) mount.hr.style.display = 'none';

    const fragment = document.createDocumentFragment();
    fragment.appendChild(toolbarEl);
    fragment.appendChild(scrollContainer);
    mount.parent.insertBefore(fragment, mount.before);
  }

  function getManagedNativeNodes(targetSection, policyRoot) {
    if (typeof nativePolicy.getManagedNativeNodes !== 'function') return [];

    const returnedNodes = nativePolicy.getManagedNativeNodes(targetSection);
    if (!returnedNodes || typeof returnedNodes[Symbol.iterator] !== 'function') {
      throw new Error('Adapter returned invalid managed native nodes');
    }

    const nodes = [];
    for (const node of returnedNodes) {
      if (!node || node.nodeType !== 1 ||
          (!targetSection.contains(node) && !policyRoot.contains(node))) {
        throw new Error('Adapter returned an invalid managed native node');
      }
      // Hiding a node that encloses our own UI would blank the page. If a
      // storefront reshuffles its DOM into that shape, leave the native
      // furniture visible rather than trading a duplicate heading for a
      // blank one.
      if (isExtensionNode(node)) {
        console.warn('[NWM] Skipping managed native node that encloses extension UI:', node);
        continue;
      }
      nodes.push(node);
    }
    return [...new Set(nodes)];
  }

  function suppressManagedNativeNodes(targetSection, policyRoot, rollback) {
    for (const node of getManagedNativeNodes(targetSection, policyRoot)) {
      if (node.classList.contains(MANAGED_NATIVE_CLASS)) continue;
      const previousClass = node.getAttribute('class');
      node.classList.add(MANAGED_NATIVE_CLASS);
      if (rollback) {
        rollback.add(() => {
          if (previousClass == null) node.removeAttribute('class');
          else node.setAttribute('class', previousClass);
        });
      }
    }
  }

  function mutationsAreExtensionOnly(records) {
    return records.length > 0 && records.every((record) => {
      if (record.type !== 'childList') return false;
      const changedNodes = [...record.addedNodes, ...record.removedNodes];
      if (changedNodes.length === 0) return false;
      return isExtensionOwnedTarget(record.target) || changedNodes.every(isExtensionNode);
    });
  }

  function startSuppressionObserver(root) {
    const policyRoot = root || document.querySelector(nativePolicy.rootSelector);
    if (!policyRoot) {
      throw new Error('Wishlist policy root not found');
    }

    if (nativeSuppressObserver) nativeSuppressObserver.disconnect();
    nativeSuppressObserver = new MutationObserver((records) => {
      if (mutationsAreExtensionOnly(records)) return;

      const currentSection = findWishlistSection();
      if (!currentSection) return;

      const sectionChanged = currentSection !== sectionEl;
      sectionEl = currentSection;
      applyTheme();
      if (sectionEl.classList.contains('nwm-booting')) {
        sectionEl.classList.remove('nwm-booting');
      }
      if (!sectionEl.classList.contains('nwm-managed-section')) {
        sectionEl.classList.add('nwm-managed-section');
      }

      suppressManagedNativeNodes(sectionEl, policyRoot);

      removeDuplicateOwnedIds('nwm-toolbar', toolbarEl);
      removeDuplicateOwnedIds('nwm-item-list', scrollContainer);

      if (sectionChanged || !toolbarEl?.isConnected || !scrollContainer?.isConnected ||
          !sectionEl.contains(toolbarEl) || !sectionEl.contains(scrollContainer)) {
        mountManagedNodes(sectionEl);
      }
    });
    nativeSuppressObserver.observe(policyRoot, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
  }

  function createEl(tagName, options) {
    const node = document.createElement(tagName);
    const opts = options || {};

    if (opts.className) node.className = opts.className;
    if (opts.text != null) node.textContent = opts.text;
    if (opts.style) Object.assign(node.style, opts.style);

    if (opts.attrs) {
      for (const [name, value] of Object.entries(opts.attrs)) {
        if (value == null) continue;
        node.setAttribute(name, String(value));
      }
    }

    return node;
  }

  function createSvgEl(tagName, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tagName);
    if (attrs) {
      for (const [name, value] of Object.entries(attrs)) {
        if (value == null) continue;
        node.setAttribute(name, String(value));
      }
    }
    return node;
  }

  function appendChildren(parent, children) {
    for (const child of children) {
      if (child) parent.appendChild(child);
    }
    return parent;
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
    return node;
  }

  function createDeleteButton(id) {
    const button = createEl('button', {
      className: 'nwm-delete-btn',
      attrs: {
        'data-id': id,
        title: 'Remove from wishlist',
        'aria-label': 'Remove from wishlist',
        type: 'button',
      },
    });

    const svg = createSvgEl('svg', {
      width: '24',
      height: '24',
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
    });

    svg.appendChild(createSvgEl('path', {
      d: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z',
      fill: '#ccc',
    }));

    button.appendChild(svg);
    return button;
  }

  function createDeleteRow(id, item) {
    const mutationEligible = isItemMutationEligible(item);
    const maySelect = capabilities.actions.select && mutationEligible;
    const mayDelete = capabilities.actions.delete && mutationEligible;
    if (!maySelect && !mayDelete) return null;

    const row = createEl('div', { className: 'nwm-item-controls' });
    if (maySelect) {
      const label = createEl('label', { className: 'nwm-select-label' });
      const checkbox = createEl('input', {
        className: 'nwm-select-checkbox',
        attrs: {
          type: 'checkbox',
          'data-id': id,
          'aria-label': 'Select item',
        },
      });
      checkbox.checked = selectedIds.has(id);
      label.appendChild(checkbox);
      label.appendChild(createEl('span', { text: 'Select' }));
      row.appendChild(label);
    }
    if (mayDelete) row.appendChild(createDeleteButton(id));
    return row;
  }

  function createStatusBadge(label, backgroundColor) {
    return createEl('div', {
      text: label,
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        background: backgroundColor,
        color: '#fff',
        padding: '4px 8px',
        fontSize: '12px',
        fontWeight: '700',
        borderRadius: '2px',
      },
    });
  }

  function createMetaPair(elements) {
    const pair = createEl('div', {
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      },
    });
    appendChildren(pair, elements);
    return pair;
  }

  function createReleaseDateLabel(isoDate) {
    const label = NWM.formatReleaseDate(isoDate);
    if (!label) return null;
    return createEl('span', {
      className: 'nwm-release-date',
      text: label,
    });
  }

  function appendMetadataBadges(row, item) {
    if (item.owned) {
      row.appendChild(createStatusBadge('OWNED', '#2e7d32'));
    }

    if (item.isNew) {
      row.appendChild(createStatusBadge('NEW', '#ef6c00'));
    }
  }

  function appendTypeBadge(row, item) {
    if (item.contentType === 'aoc') {
      row.appendChild(createStatusBadge('DLC', '#1565c0'));
    } else if (item.contentType === 'bundle') {
      row.appendChild(createStatusBadge('BUNDLE', '#6d4c41'));
    }
  }

  function createBadgeRow() {
    return createEl('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      },
    });
  }

  function createSwitch2Band() {
    return createEl('div', {
      text: 'Nintendo Switch 2',
      style: {
        display: 'flex',
        height: '16px',
        width: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#e60012',
        borderRadius: '4px 4px 0 0',
        color: '#fff',
        fontSize: '10px',
        fontWeight: '700',
        letterSpacing: '0.2px',
      },
    });
  }

  function createPriceContent(item) {
    const regular = item.pricing.regular;
    const sale = item.pricing.sale;
    const isPreOrder = item.salesStatus === 'preorder';
    const isUnreleased = item.salesStatus === 'unreleased';
    const wrapper = createEl('div');
    const badgeRow = createBadgeRow();

    if (!regular && !sale) {
      appendTypeBadge(badgeRow, item);
      if (isPreOrder) {
        badgeRow.appendChild(createMetaPair([
          createStatusBadge('PRE-ORDER', '#1a73e8'),
          createReleaseDateLabel(item.releaseDate),
        ]));
        wrapper.appendChild(badgeRow);
        appendMetadataBadges(badgeRow, item);
        return wrapper;
      }
      if (isUnreleased) {
        badgeRow.appendChild(createMetaPair([
          createStatusBadge('UPCOMING', '#888'),
          createReleaseDateLabel(item.releaseDate),
        ]));
        appendMetadataBadges(badgeRow, item);
        wrapper.appendChild(badgeRow);
        return wrapper;
      }
      appendMetadataBadges(badgeRow, item);
      if (badgeRow.childNodes.length > 0) {
        wrapper.appendChild(badgeRow);
        return wrapper;
      }
      return null;
    }

    if (sale) {
      const discountWrap = createEl('div', {
        style: {
          background: '#e60012',
          color: '#fff',
          display: 'inline-flex',
          alignItems: 'center',
          flexWrap: 'wrap',
        },
      });

      const regularRaw = regular && Number.isFinite(regular.value) ? regular.value : 0;
      const saleRaw = Number.isFinite(sale.value) ? sale.value : null;
      const discountPct = regularRaw > 0 && saleRaw !== null
        ? Math.round((1 - saleRaw / regularRaw) * 100)
        : 0;
      discountWrap.appendChild(createEl('div', {
        text: `${discountPct}% OFF`,
        style: {
          padding: '4px 8px',
          fontSize: '14px',
          fontWeight: '700',
        },
      }));

      appendTypeBadge(badgeRow, item);
      if (isPreOrder) {
        badgeRow.appendChild(createMetaPair([
          createStatusBadge('PRE-ORDER', '#1a73e8'),
          createReleaseDateLabel(item.releaseDate),
        ]));
      } else if (isUnreleased) {
        badgeRow.appendChild(createMetaPair([
          createStatusBadge('UPCOMING', '#888'),
          createReleaseDateLabel(item.releaseDate),
        ]));
      }
      const saleEnd = NWM.formatSaleEnd(item.pricing.saleEndAt);
      const saleDate = saleEnd ? createEl('span', {
          className: `nwm-sale-end${NWM.isSaleEndUrgent(
            item.pricing.saleEndAt,
            globalSettings.saleUrgencyDays,
          ) ? ' nwm-urgent' : ''}`,
          text: saleEnd,
        }) : null;
      badgeRow.appendChild(createMetaPair([discountWrap, saleDate]));
      appendMetadataBadges(badgeRow, item);

      const priceRow = createEl('div', { className: 'nwm-price-row' });
      priceRow.appendChild(createEl('p', {
        text: sale.formatted || '',
        style: {
          color: '#e60012',
          fontSize: '20px',
          fontWeight: '700',
        },
      }));

      if (regular) {
        priceRow.appendChild(createEl('p', {
          className: 'nwm-price-regular-muted',
          text: regular.formatted || '',
          style: {
            textDecoration: 'line-through',
            color: '#888',
            fontSize: '14px',
          },
        }));
      }

      wrapper.appendChild(badgeRow);
      wrapper.appendChild(priceRow);
      return wrapper;
    }

    appendTypeBadge(badgeRow, item);
    if (isPreOrder) {
      badgeRow.appendChild(createMetaPair([
        createStatusBadge('PRE-ORDER', '#1a73e8'),
        createReleaseDateLabel(item.releaseDate),
      ]));
    } else if (isUnreleased) {
      badgeRow.appendChild(createMetaPair([
        createStatusBadge('UPCOMING', '#888'),
        createReleaseDateLabel(item.releaseDate),
      ]));
    }
    appendMetadataBadges(badgeRow, item);
    if (badgeRow.childNodes.length > 0) wrapper.appendChild(badgeRow);

    if (regular) {
      const priceRow = createEl('div', { className: 'nwm-price-row' });
      priceRow.appendChild(createEl('p', {
        className: 'nwm-price-regular',
        text: regular.formatted || '',
        style: {
          fontSize: '20px',
          fontWeight: '700',
        },
      }));
      wrapper.appendChild(priceRow);
    }

    return wrapper.childNodes.length > 0 ? wrapper : null;
  }

  function createItemNode(id, item) {
    if (!item) return null;

    const container = createEl('div', {
      className: 'nwm-item-card nwm-item-managed',
      attrs: { 'data-id': id },
    });
    container.dataset.nwmId = id;

    if (item.availability === 'unavailable') {
      const row = createEl('div', { className: 'nwm-item-row' });
      const imageWrap = createEl('div', { className: 'nwm-item-media' });
      const image = createEl('img', {
        attrs: { alt: item.imageUrl ? item.name : 'No image available', loading: 'lazy' },
        style: {
          background: '#f0f0f0',
          width: '220px',
          height: '124px',
        },
      });
      if (item.imageUrl) image.src = item.imageUrl;
      imageWrap.appendChild(image);
      row.appendChild(imageWrap);

      const details = createEl('div', { className: 'nwm-item-details nwm-unavailable-details' });
      if (item.catalogRelation === 'foreign') {
        const badge = createEl('span', {
          className: 'nwm-region-badge',
          text: item.catalogRegion,
          attrs: {
            title: `Catalog region ${item.catalogRegion}`,
            'aria-label': `Catalog region ${item.catalogRegion}`,
          },
        });
        const heading = createEl('div', { className: 'nwm-foreign-heading' });
        appendChildren(heading, [badge, createEl('strong', { text: item.name })]);
        details.appendChild(heading);
        if (item.platformLabel) details.appendChild(createEl('span', {
          className: 'nwm-foreign-platform',
          text: item.platformLabel,
        }));
        details.appendChild(createEl('span', {
          className: 'nwm-unavailable-copy',
          text: 'Available in another checked region',
        }));
      } else {
        const unavailableCopy = item.resolutionStatus === 'complete-unresolved'
          ? 'No longer sold in checked regions'
          : item.resolutionStatus === 'partial'
            ? 'Not available in your current region; the other-region check did not finish'
            : 'Not available in your current region, or no longer sold';
        details.appendChild(createEl('span', {
          className: 'nwm-unavailable-copy',
          text: unavailableCopy,
        }));
      }
      row.appendChild(details);

      appendChildren(container, [createDeleteRow(id, item), row]);
      return container;
    }

    const isSwitch2 = item.platformLabel === 'Nintendo Switch 2';
    const platformText = item.platformLabel || '';

    const row = createEl('div', { className: 'nwm-item-row' });
    const imageWrap = createEl('div', { className: 'nwm-item-media' });
    const imageLink = createEl('a', {
      className: 'nwm-item-link',
      attrs: { href: item.productUrl, target: '_blank', rel: 'noopener noreferrer' },
    });
    const imageInner = createEl('div', { className: 'nwm-item-image-inner' });
    if (isSwitch2) {
      imageInner.appendChild(createSwitch2Band());
    }

    const image = createEl('img', {
      attrs: {
        alt: item.name,
        loading: 'lazy',
      },
      style: {
        width: '220px',
        height: 'auto',
      },
    });
    if (item.imageUrl) {
      image.src = item.imageUrl;
    }

    imageInner.appendChild(image);
    imageLink.appendChild(imageInner);
    imageWrap.appendChild(imageLink);

    const details = createEl('div', { className: 'nwm-item-details' });
    const contentStack = createEl('div', { className: 'nwm-item-stack' });
    const platformRow = createEl('div', {
      className: 'nwm-platform-text',
      style: {
        color: '#888',
        fontSize: '14px',
        display: 'flex',
        flexWrap: 'wrap',
        columnGap: '4px',
      },
    });
    platformRow.appendChild(createEl('div', { text: platformText }));

    const titleLink = createEl('a', {
      className: 'nwm-item-link nwm-item-title',
      text: item.name,
      attrs: { href: item.productUrl, target: '_blank', rel: 'noopener noreferrer' },
      style: {
        fontSize: '16px',
        color: '#333',
        textDecoration: 'none',
      },
    });

    contentStack.appendChild(platformRow);
    contentStack.appendChild(titleLink);

    const priceContent = createPriceContent(item);
    if (priceContent) contentStack.appendChild(priceContent);

    let actions = null;
    if (capabilities.actions.reviews) {
      const reviewsUrl = 'https://www.google.com/search?q=' +
        encodeURIComponent(`${item.name} ${platformText} reviews`);
      actions = createEl('div', { className: 'nwm-item-actions' });
      actions.appendChild(createEl('a', {
        text: 'Search reviews',
        attrs: { href: reviewsUrl, target: '_blank', rel: 'noopener noreferrer' },
        style: {
          border: '1px solid #e60012',
          color: '#e60012',
          padding: '6px 16px',
          borderRadius: '4px',
          textDecoration: 'none',
          fontSize: '14px',
        },
      }));
    }

    details.appendChild(contentStack);
    if (actions) details.appendChild(actions);
    row.appendChild(imageWrap);
    row.appendChild(details);

    appendChildren(container, [createDeleteRow(id, item), row]);

    return container;
  }

  function bindItemListEvents(container) {
    // Event delegation for delete buttons
    container.onclick = async (e) => {
      const btn = e.target.closest('.nwm-delete-btn');
      if (!btn) return;
      const id = btn.dataset.id;
      if (!id || !capabilities.actions.delete ||
          !isItemMutationEligible(itemData.get(id))) return;

      await runWithLock(async () => {
        if (!confirm('Remove this item from your wishlist?')) return;

        btn.disabled = true;
        btn.style.opacity = '0.3';
        try {
          await deleteWishlistItem(id);
          removeItemFromState(id);
          applyFiltersAndSort();
          updateSelectionUi();
        } catch (err) {
          console.error('[NWM] Delete failed:', err);
          btn.disabled = false;
          btn.style.opacity = '';
          alert('Could not remove this item. ' + err.message);
        }
      });
    };

    container.onchange = (e) => {
      const checkbox = e.target.closest('.nwm-select-checkbox');
      if (!checkbox) return;
      const id = checkbox.dataset.id;
      if (!id || !capabilities.actions.select ||
          !isItemMutationEligible(itemData.get(id))) return;

      if (checkbox.checked) selectedIds.add(id);
      else selectedIds.delete(id);

      updateSelectionUi();
    };
  }

  function buildItemList(snapshot) {
    const container = document.createElement('div');
    container.id = 'nwm-item-list';
    const snapshotDomNodes = new Map();

    for (const id of snapshot.ids) {
      const sid = String(id);
      const node = createItemNode(sid, snapshot.itemData.get(sid));
      if (node) {
        snapshotDomNodes.set(sid, node);
        container.appendChild(node);
      }
    }

    bindItemListEvents(container);
    return { container, domNodes: snapshotDomNodes };
  }

  function commitSnapshot(snapshot, rollback) {
    const previousContainer = scrollContainer;
    const policyRoot = document.querySelector(nativePolicy.rootSelector);
    if (!policyRoot) throw new Error('Wishlist policy root not found');
    if (!sectionEl || !policyRoot.contains(sectionEl) || !toolbarEl ||
        !toolbarEl.isConnected || !sectionEl.contains(toolbarEl)) {
      throw new Error('Wishlist section changed before snapshot commit');
    }
    const previousCapabilities = capabilities;
    capabilities = snapshot.capabilities;
    let built;
    try {
      built = buildItemList(snapshot);
    } catch (err) {
      capabilities = previousCapabilities;
      throw err;
    }

    if (previousContainer && previousContainer.isConnected) {
      previousContainer.replaceWith(built.container);
    } else if (toolbarEl && toolbarEl.parentNode) {
      toolbarEl.parentNode.insertBefore(built.container, toolbarEl.nextSibling);
      if (rollback) rollback.add(() => built.container.remove());
    } else {
      throw new Error('Toolbar was detached before snapshot commit');
    }

    const committedSection = sectionEl;
    if (!committedSection.classList.contains('nwm-managed-section')) {
      committedSection.classList.add('nwm-managed-section');
      if (rollback) {
        rollback.add(() => committedSection.classList.remove('nwm-managed-section'));
      }
    }
    committedSection.classList.remove('nwm-booting');

    allItemIds = snapshot.ids;
    itemData = snapshot.itemData;
    loadStatus = snapshot.meta;
    domNodes = built.domNodes;
    scrollContainer = built.container;

    const firstCommit = !hasCommittedSnapshot;
    hasCommittedSnapshot = true;
    applyTheme();
    suppressManagedNativeNodes(committedSection, policyRoot, rollback);
    if (firstCommit) startSuppressionObserver(policyRoot);

    isLoading = false;
    hideLoadingProgress();
  }

  // ── Filtering & Sorting ───────────────────────────────────────────────

  function getItemView(id) {
    const item = itemData.get(id);
    const sale = item?.pricing.sale;
    const regular = item?.pricing.regular;
    let currentPrice = null;
    let discountPct = null;

    if (sale) {
      currentPrice = Number.isFinite(sale.value) ? sale.value : null;
      discountPct = 0;
    } else if (regular) {
      currentPrice = Number.isFinite(regular.value) ? regular.value : null;
    }

    if (sale && regular && Number.isFinite(regular.value) &&
        Number.isFinite(sale.value) && regular.value > 0) {
      discountPct = Math.round((1 - sale.value / regular.value) * 100);
    }

    return {
      id: String(id),
      originalIndex: allItemIds.indexOf(String(id)),
      name: item?.name || '',
      price: currentPrice,
      discountPct,
      releaseDate: item?.releaseDate || null,
      saleEnd: item?.pricing.saleEndAt || null,
      platform: item?.platformCode || '',
      contentType: item?.contentType || 'unknown',
      addedAt: item?.addedAt || null,
      status: item?.availability || 'unavailable',
      catalogRelation: item?.catalogRelation || 'unresolved',
    };
  }

  function isItemOnSale(id) {
    return getItemView(id).discountPct !== null;
  }

  function itemMatchesFilters(id) {
    const item = itemData.get(id);
    if (item?.availability === 'unavailable' && !isUnavailableItemRevealed(item)) return false;
    return NWM.itemMatchesFilters(getItemView(id), filters);
  }

  function isUnavailableItemRevealed(item) {
    if (!globalSettings.showCrossRegion) return false;
    // A capable adapter must classify the row before exposing its existing
    // deletion capability. Legacy/read-only adapters can reveal generic rows
    // immediately because they cannot turn them into mutation candidates.
    return !staticCapabilities.crossRegionResolution || item.resolutionStatus !== 'not-requested';
  }

  function isItemInVisibilityScope(id) {
    const item = itemData.get(id);
    return Boolean(item && (item.availability !== 'unavailable' || isUnavailableItemRevealed(item)));
  }

  function getSortedIds() {
    const ids = allItemIds.map(String);

    const cmp = NWM.createComparator(sortBy);

    ids.sort((a, b) => cmp(getItemView(a), getItemView(b)));

    return ids;
  }

  function applyFiltersAndSort() {
    if (!scrollContainer || isLoading) return;

    const sortedIds = getSortedIds();
    let visibleCount = 0;
    let visibilityScopeCount = 0;
    let saleCount = 0;

    // Reorder and filter
    for (const id of sortedIds) {
      const node = domNodes.get(id);
      if (!node) continue;

      if (isItemInVisibilityScope(id)) visibilityScopeCount++;
      const visible = itemMatchesFilters(id);
      if (visible) {
        node.classList.remove('nwm-hidden');
        visibleCount++;
        if (isItemOnSale(id)) saleCount++;
      } else {
        node.classList.add('nwm-hidden');
      }

      // Reorder by appending (moves existing node)
      scrollContainer.appendChild(node);
    }

    updateFilteredStatus(visibleCount, visibilityScopeCount, allItemIds.length, saleCount);
    savePreferences();
    updateSelectionUi();
  }

  // ── Toolbar UI ─────────────────────────────────────────────────────────

  function syncSettingsControls() {
    const theme = document.getElementById('nwm-setting-theme');
    if (theme) theme.value = globalSettings.theme;
  }

  // Content scripts cannot call chrome.runtime.openOptionsPage, so the page is
  // opened as a web-accessible resource instead. Chrome's own entry point sits
  // in chrome://extensions, which nobody finds; this extension has no toolbar
  // popup either, so without this link the options page is effectively hidden.
  function optionsPageUrl() {
    try {
      const runtime = globalThis.chrome && globalThis.chrome.runtime;
      const url = runtime && typeof runtime.getURL === 'function'
        ? runtime.getURL('options.html')
        : null;
      return typeof url === 'string' && url.startsWith('chrome-extension://') ? url : null;
    } catch (_err) {
      return null;
    }
  }

  function createOptionsPageLink() {
    const url = optionsPageUrl();
    if (!url) return null;
    return createEl('a', {
      className: 'nwm-settings-link',
      text: 'More settings',
      attrs: {
        id: 'nwm-settings-options-link',
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    });
  }

  function applyTheme(rollback) {
    if (!settingsLoaded && !hasCommittedSnapshot) return;
    const policyRoot = document.querySelector(nativePolicy.rootSelector);
    if (!policyRoot) return;

    const themedSection = sectionEl;
    const addedThemeHostClass = !policyRoot.classList.contains('nwm-theme-host');
    const previousRootTheme = policyRoot.getAttribute('data-nwm-theme');
    const previousSectionTheme = themedSection && themedSection.getAttribute('data-nwm-theme');
    if (rollback) {
      rollback.add(() => {
        if (addedThemeHostClass) policyRoot.classList.remove('nwm-theme-host');
        if (previousRootTheme == null) policyRoot.removeAttribute('data-nwm-theme');
        else policyRoot.setAttribute('data-nwm-theme', previousRootTheme);
        if (themedSection) {
          if (previousSectionTheme == null) themedSection.removeAttribute('data-nwm-theme');
          else themedSection.setAttribute('data-nwm-theme', previousSectionTheme);
        }
      });
    }

    if (sectionEl && sectionEl.dataset.nwmTheme !== globalSettings.theme) {
      sectionEl.dataset.nwmTheme = globalSettings.theme;
    }
    if (addedThemeHostClass) {
      policyRoot.classList.add('nwm-theme-host');
    }
    if (policyRoot.dataset.nwmTheme !== globalSettings.theme) {
      policyRoot.dataset.nwmTheme = globalSettings.theme;
    }
  }

  async function persistHeaderSetting(patch) {
    const next = await settingsApi.update(patch);
    applyGlobalSettings(next);
    syncSettingsControls();
  }

  function createManagedHeader(rollback) {
    const header = createEl('div', {
      className: 'nwm-header',
      attrs: { id: 'nwm-header' },
    });
    const identity = createEl('div', { className: 'nwm-header-identity' });
    identity.appendChild(createEl('a', {
      className: 'nwm-header-title',
      text: 'Better Wishlist for Nintendo eShop',
      attrs: {
        href: 'https://chrome.google.com/webstore/detail/jlibjocfcijoaflpjmaibdehimjadpeg',
        target: '_blank',
        rel: 'noopener noreferrer',
        title: 'Open the Chrome Web Store listing in a new tab',
      },
    }));
    const note = createEl('div', { className: 'nwm-header-note' });
    appendChildren(note, [
      document.createTextNode('Not affiliated with Nintendo. '),
      createEl('a', {
        className: 'nwm-header-donate',
        text: '☕️ Buy me a coffee.',
        attrs: {
          href: 'https://ko-fi.com/renaudguerin',
          target: '_blank',
          rel: 'noopener noreferrer',
          title: 'Support the project on Ko-fi (opens in a new tab)',
        },
      }),
    ]);
    identity.appendChild(note);

    const actions = createEl('div', { className: 'nwm-header-actions' });

    const settingsWrap = createEl('div', { className: 'nwm-settings-wrap' });
    const settingsButton = createEl('button', {
      className: 'nwm-settings-button',
      text: '⚙',
      attrs: {
        id: 'nwm-settings-button',
        type: 'button',
        title: 'Better Wishlist settings',
        'aria-label': 'Open Better Wishlist settings',
        'aria-expanded': 'false',
        'aria-controls': 'nwm-settings-popover',
      },
    });
    const popover = createEl('div', {
      className: 'nwm-settings-popover',
      attrs: {
        id: 'nwm-settings-popover',
        role: 'group',
        'aria-label': 'Better Wishlist settings',
      },
    });
    popover.hidden = true;

    const themeLabel = createEl('label', {
      className: 'nwm-settings-field',
      text: 'Theme',
      attrs: { for: 'nwm-setting-theme' },
    });
    const themeSelect = createEl('select', {
      attrs: { id: 'nwm-setting-theme' },
    });
    for (const [value, label] of [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]) {
      themeSelect.appendChild(createEl('option', { text: label, attrs: { value } }));
    }
    themeLabel.appendChild(themeSelect);
    appendChildren(popover, [themeLabel, createOptionsPageLink()]);
    appendChildren(settingsWrap, [settingsButton, popover]);
    actions.appendChild(settingsWrap);
    appendChildren(header, [identity, actions]);

    const closePopover = (returnFocus) => {
      if (popover.hidden) return;
      popover.hidden = true;
      settingsButton.setAttribute('aria-expanded', 'false');
      if (returnFocus) settingsButton.focus();
    };
    settingsButton.addEventListener('click', () => {
      const opening = popover.hidden;
      popover.hidden = !opening;
      settingsButton.setAttribute('aria-expanded', String(opening));
      if (opening) {
        syncSettingsControls();
        themeSelect.focus();
      }
    });
    themeSelect.addEventListener('change', () => {
      persistHeaderSetting({ theme: themeSelect.value });
    });

    const onDocumentClick = (event) => {
      if (!popover.hidden && !settingsWrap.contains(event.target)) closePopover(false);
    };
    const onSettingsKeydown = (event) => {
      if (event.key === 'Escape' && !popover.hidden) {
        event.preventDefault();
        closePopover(true);
      }
    };
    document.addEventListener('click', onDocumentClick);
    document.addEventListener('keydown', onSettingsKeydown);
    rollback.add(() => document.removeEventListener('click', onDocumentClick));
    rollback.add(() => document.removeEventListener('keydown', onSettingsKeydown));
    syncSettingsControls();
    return header;
  }

  function createToolbar(rollback) {
    toolbarEl = document.createElement('div');
    toolbarEl.id = 'nwm-toolbar';
    const rowOne = createEl('div', { className: 'nwm-row' });
    const searchInput = capabilities.filters.search ? createEl('input', {
      attrs: {
        type: 'text',
        id: 'nwm-search',
        placeholder: 'Search games (/)',
        autocomplete: 'off',
      },
    }) : null;
    const saleToggle = capabilities.filters.onSale ? createEl('button', {
      className: 'nwm-toggle',
      text: 'On Sale',
      attrs: {
        id: 'nwm-sale-toggle',
        title: 'Show only discounted titles',
        type: 'button',
      },
    }) : null;
    const typeFilter = capabilities.filters.contentType ? createEl('select', {
      className: 'nwm-select',
      attrs: {
        id: 'nwm-type-filter',
        title: 'Filter by type',
      },
    }) : null;
    const platformFilter = capabilities.filters.platform ? createEl('select', {
      className: 'nwm-select',
      attrs: {
        id: 'nwm-platform-filter',
        title: 'Filter by platform',
      },
    }) : null;
    const sortSelect = capabilities.sorts.length > 0 ? createEl('select', {
      className: 'nwm-select',
      attrs: {
        id: 'nwm-sort',
        title: 'Sort by',
      },
    }) : null;
    const selectBar = capabilities.actions.select ? createEl('div', {
      className: 'nwm-select-bar',
      attrs: { id: 'nwm-select-bar' },
    }) : null;
    const selectAllLabel = capabilities.actions.select ? createEl('label', {
      className: 'nwm-select-all',
      attrs: { id: 'nwm-select-all-label', title: 'Select or clear all shown items' },
    }) : null;
    const selectAllCheckbox = capabilities.actions.select ? createEl('input', {
      className: 'nwm-select-all-checkbox',
      attrs: { type: 'checkbox', id: 'nwm-select-all' },
    }) : null;
    if (selectAllLabel) {
      selectAllLabel.appendChild(selectAllCheckbox);
      selectAllLabel.appendChild(createEl('span', { text: 'Select all' }));
    }
    const bulkDeleteBtn = capabilities.actions.bulkDelete ? createEl('button', {
      className: 'nwm-bulk-btn nwm-bulk-btn-danger',
      text: 'Remove selected',
      attrs: {
        id: 'nwm-bulk-delete',
        type: 'button',
      },
    }) : null;

    const typeOptions = [
      ['all', 'All Types'],
      ['title', 'Games'],
      ['aoc', 'DLC'],
      ['bundle', 'Bundles'],
    ];
    const sortLabels = new Map([
      ['name-az', 'Name (A → Z)'],
      ['name-za', 'Name (Z → A)'],
      ['price-asc', 'Price (Low → High)'],
      ['price-desc', 'Price (High → Low)'],
      ['discount', 'Discount %'],
      ['release-date', 'Release Date (Newest)'],
      ['sale-end', 'Sale Ending Soon'],
      ['date-added-newest', 'Date Added (Newest)'],
      ['date-added-oldest', 'Date Added (Oldest)'],
    ]);

    if (typeFilter) typeOptions.forEach(([value, label]) => {
      typeFilter.appendChild(createEl('option', {
        text: label,
        attrs: { value },
      }));
    });
    if (platformFilter) [['all', 'All Platforms'], ...capabilities.platforms.map(
      (platform) => [platform.code, platform.label])].forEach(([value, label]) => {
      platformFilter.appendChild(createEl('option', {
        text: label,
        attrs: { value },
      }));
    });
    if (sortSelect) capabilities.sorts.forEach((value) => {
      sortSelect.appendChild(createEl('option', {
        text: sortLabels.get(value),
        attrs: { value },
      }));
    });

    const sortDivider = sortSelect ? createEl('span', {
      className: 'nwm-vdivider',
      attrs: { 'aria-hidden': 'true' },
    }) : null;
    const sortLabel = sortSelect
      ? createEl('span', { className: 'nwm-sort-label', text: 'Sort by' })
      : null;

    if (selectBar) appendChildren(selectBar, [selectAllLabel, bulkDeleteBtn]);
    appendChildren(rowOne, [searchInput, saleToggle, typeFilter, platformFilter, sortDivider, sortLabel, sortSelect]);

    const rowTwo = createEl('div', { className: 'nwm-row' });
    rowTwo.appendChild(createEl('div', {
      attrs: {
        id: 'nwm-status',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      },
      text: 'Loading…',
    }));

    const progressBar = createEl('div', {
      className: 'nwm-progress-indeterminate',
      attrs: {
        id: 'nwm-progress-bar',
        role: 'progressbar',
        'aria-label': 'Loading wishlist items',
        'aria-valuetext': 'Loading wishlist items',
      },
    });
    progressBar.appendChild(createEl('div', { attrs: { id: 'nwm-progress-fill' } }));

    appendChildren(toolbarEl, [
      createManagedHeader(rollback), rowOne, rowTwo, selectBar, progressBar,
    ]);

    mountProvisionalToolbar(toolbarEl, rollback);

    // Bind events
    if (searchInput) {
      searchInput.addEventListener('input', debounce(() => {
        filters.search = searchInput.value.trim();
        applyFiltersAndSort();
      }, DEBOUNCE_MS));
    }

    if (saleToggle) {
      saleToggle.addEventListener('click', () => {
        filters.onSale = !filters.onSale;
        saleToggle.classList.toggle('active', filters.onSale);
        applyFiltersAndSort();
      });
    }

    if (typeFilter) typeFilter.addEventListener('change', () => {
      filters.contentType = typeFilter.value;
      applyFiltersAndSort();
    });

    if (platformFilter) platformFilter.addEventListener('change', () => {
      filters.platform = platformFilter.value;
      applyFiltersAndSort();
    });

    if (sortSelect) sortSelect.addEventListener('change', () => {
      sortBy = sortSelect.value;
      applyFiltersAndSort();
    });

    if (selectAllCheckbox) selectAllCheckbox.addEventListener('change', () => {
      const visibleIds = getVisibleSelectableItemIds();
      const selection = NWM.getVisibleSelection(visibleIds, selectedIds);
      const action = NWM.getSelectAllAction(selection, selectAllCheckbox.checked);

      if (action === 'clear-all') {
        selectedIds.clear();
      } else {
        visibleIds.forEach((id) => selectedIds.add(id));
      }
      updateSelectionUi();
    });

    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', () => {
      bulkDeleteSelectedItems();
    });

    // Keyboard shortcut: / to focus search
    const onDocumentKeydown = (e) => {
      if (!searchInput) return;
      if (e.key === '/' && document.activeElement !== searchInput &&
          !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
        e.preventDefault();
        searchInput.focus();
      }
    };
    if (searchInput) {
      document.addEventListener('keydown', onDocumentKeydown);
      rollback.add(() => document.removeEventListener('keydown', onDocumentKeydown));
    }

    // Restore saved preferences
    const preferencesRepaired = loadPreferences();
    if (saleToggle) saleToggle.classList.toggle('active', filters.onSale);
    if (typeFilter) typeFilter.value = filters.contentType;
    if (platformFilter) platformFilter.value = filters.platform;
    if (sortSelect) sortSelect.value = sortBy;
    if (preferencesRepaired) savePreferences();
    updateSelectionUi();
  }

  function updatePlatformOptions() {
    const platformFilter = document.getElementById('nwm-platform-filter');
    if (platformFilter) {
      clearNode(platformFilter);
      platformFilter.appendChild(createEl('option', {
        text: 'All Platforms',
        attrs: { value: 'all' },
      }));
      for (const platform of capabilities.platforms) {
        platformFilter.appendChild(createEl('option', {
          text: platform.label,
          attrs: { value: platform.code },
        }));
      }
    }

    const repaired = NWM.repairPreferences({ ...filters, sortBy }, capabilities);
    const preferencesWereRepaired = repaired.repaired;
    filters = { ...filters, ...repaired.filters };
    sortBy = repaired.sortBy;

    if (platformFilter) platformFilter.value = filters.platform;
    const typeFilter = document.getElementById('nwm-type-filter');
    if (typeFilter) typeFilter.value = filters.contentType;
    const sortSelect = document.getElementById('nwm-sort');
    if (sortSelect) sortSelect.value = sortBy;
    const saleToggle = document.getElementById('nwm-sale-toggle');
    if (saleToggle) saleToggle.classList.toggle('active', filters.onSale);
    if (preferencesWereRepaired) savePreferences();
    return preferencesWereRepaired;
  }

  function showLoadingProgress() {
    const fill = document.getElementById('nwm-progress-fill');
    const bar = document.getElementById('nwm-progress-bar');
    if (!fill || !bar) return;

    fill.style.removeProperty('width');
    bar.classList.remove('hidden');
    bar.classList.add('nwm-progress-indeterminate');
    bar.removeAttribute('aria-valuemin');
    bar.removeAttribute('aria-valuemax');
    bar.removeAttribute('aria-valuenow');
    bar.setAttribute('aria-valuetext', 'Loading wishlist items');
  }

  function updateProgress(loaded, total) {
    const fill = document.getElementById('nwm-progress-fill');
    const bar = document.getElementById('nwm-progress-bar');
    if (fill && bar && Number.isFinite(total) && total > 0) {
      const safeLoaded = Math.max(0, Math.min(loaded, total));
      const pct = Math.round((safeLoaded / total) * 100);
      bar.classList.remove('nwm-progress-indeterminate');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', String(total));
      bar.setAttribute('aria-valuenow', String(safeLoaded));
      bar.setAttribute('aria-valuetext', `${safeLoaded} of ${total} wishlist items loaded`);
      fill.style.width = pct + '%';
      bar.classList.toggle('hidden', loaded >= total);
    }
    updateStatus(`Loading ${loaded}/${total} items...`);
  }

  function hideLoadingProgress() {
    const bar = document.getElementById('nwm-progress-bar');
    if (!bar) return;
    bar.classList.add('hidden');
    bar.classList.remove('nwm-progress-indeterminate');
  }

  // Items go missing from the list for three unrelated reasons — an active
  // filter, hidden cross-region rows, and a load that did not finish — and this
  // line is the only place any of them is reported, so they share one phrasing.
  function statusCountText() {
    const all = `${allItemIds.length} items`;
    if (!statusSummary) return all;
    if (statusSummary.anyFilterActive) {
      return `${statusSummary.visible} of ${statusSummary.visibilityScope} items shown`;
    }
    if (statusSummary.visibilityScope < statusSummary.total) {
      return `${statusSummary.visibilityScope} of ${statusSummary.total} items shown`;
    }
    return all;
  }

  function appendStatusCounts(statusEl) {
    const countText = statusCountText();
    // A bare item count next to "Loaded 21 of 38" is the same number twice.
    if (!loadStatus.partial || countText !== `${allItemIds.length} items`) {
      appendStatusPart(statusEl, createEl('span', { className: 'nwm-count', text: countText }));
    }
    if (loadStatus.partial) {
      appendStatusPart(statusEl, createEl('span', {
        className: statusEl.querySelector('.nwm-count') ? '' : 'nwm-count',
        text: `Loaded ${allItemIds.length} of ${loadStatus.reportedTotal}`,
      }));
    }
  }

  function appendStatusPart(statusEl, content) {
    if (statusEl.childNodes.length > 0) {
      statusEl.appendChild(document.createTextNode(' · '));
    }
    statusEl.appendChild(typeof content === 'string'
      ? document.createTextNode(content)
      : content);
  }

  function updateSaleUrgencyClasses() {
    for (const [id, node] of domNodes) {
      const saleEnd = node.querySelector('.nwm-sale-end');
      if (!saleEnd) continue;
      saleEnd.classList.toggle('nwm-urgent', NWM.isSaleEndUrgent(
        itemData.get(id)?.pricing.saleEndAt,
        globalSettings.saleUrgencyDays,
      ));
    }
  }

  function scheduleCrossRegionRefresh() {
    if (!staticCapabilities.crossRegionResolution || !hasCommittedSnapshot ||
        !globalSettings.showCrossRegion || crossRegionRefreshScheduled ||
        crossRegionRefreshRunning) return;
    crossRegionRefreshScheduled = true;
    queueMicrotask(async () => {
      crossRegionRefreshScheduled = false;
      if (!globalSettings.showCrossRegion || crossRegionRefreshRunning) return;
      crossRegionRefreshRunning = true;
      try {
        const acquired = await refreshCommittedSnapshot({ includeCrossRegion: true });
        if (!acquired && globalSettings.showCrossRegion) {
          setTimeout(scheduleCrossRegionRefresh, 50);
        }
      } finally {
        crossRegionRefreshRunning = false;
      }
    });
  }

  function applyGlobalSettings(value, options) {
    const next = settingsApi.repair(value);
    const showChanged = next.showCrossRegion !== globalSettings.showCrossRegion;
    const urgencyChanged = next.saleUrgencyDays !== globalSettings.saleUrgencyDays;
    const themeChanged = next.theme !== globalSettings.theme;
    if (!showChanged && !urgencyChanged && !themeChanged) {
      syncSettingsControls();
      return false;
    }
    globalSettings = next;
    if (themeChanged) applyTheme();
    syncSettingsControls();
    if (urgencyChanged) updateSaleUrgencyClasses();
    if (showChanged && hasCommittedSnapshot) {
      applyFiltersAndSort();
      if (next.showCrossRegion && !(options && options.suppressRefresh)) {
        scheduleCrossRegionRefresh();
      }
    }
    return true;
  }

  async function setCrossRegionVisibility(show) {
    const next = await settingsApi.update({ showCrossRegion: show });
    applyGlobalSettings(next);
  }

  function renderStatus() {
    const statusEl = document.getElementById('nwm-status');
    if (!statusEl) return;
    clearNode(statusEl);

    if (statusOverride) {
      if (statusOverride.isError) {
        statusEl.appendChild(createEl('span', {
          className: 'nwm-error',
          text: statusOverride.message,
        }));
        statusEl.appendChild(document.createTextNode(' '));
        const retryBtn = createEl('button', {
          className: 'nwm-retry-btn',
          text: 'Retry',
          attrs: {
            id: 'nwm-retry',
            type: 'button',
          },
        });
        retryBtn.addEventListener('click', () => {
          const retryAction = statusOverride.onRetry || refreshCommittedSnapshot;
          retryAction();
        });
        statusEl.appendChild(retryBtn);
      } else {
        statusEl.appendChild(document.createTextNode(statusOverride.message));
      }
      if (loadStatus.partial && hasCommittedSnapshot) {
        appendStatusPart(statusEl,
          `Loaded ${allItemIds.length} of ${loadStatus.reportedTotal}`);
      }
    } else if (statusSummary && statusSummary.anyFilterActive) {
      appendStatusCounts(statusEl);
      if (statusSummary.saleVisible > 0) {
        appendStatusPart(statusEl, createEl('span', {
          className: 'nwm-sale-count',
          text: `${statusSummary.saleVisible} on sale`,
        }));
      }
    } else {
      let saleCount = 0;
      for (const [id, item] of itemData) {
        if (item.availability !== 'unavailable' && isItemOnSale(id)) {
          saleCount++;
        }
      }

      appendStatusCounts(statusEl);

      if (saleCount > 0) {
        if (capabilities.filters.onSale) {
          const saleLink = createEl('a', {
            className: 'nwm-sale-link',
            text: `${saleCount} on sale`,
            attrs: { href: '#', id: 'nwm-toggle-sale' },
          });
          saleLink.addEventListener('click', (e) => {
            e.preventDefault();
            filters.onSale = !filters.onSale;
            const saleToggle = document.getElementById('nwm-sale-toggle');
            if (saleToggle) saleToggle.classList.toggle('active', filters.onSale);
            applyFiltersAndSort();
          });
          appendStatusPart(statusEl, saleLink);
        } else {
          appendStatusPart(statusEl, `${saleCount} on sale`);
        }
      }
    }

    let unavailableCount = 0;
    for (const [, item] of itemData) {
      if (item.availability === 'unavailable') unavailableCount++;
    }
    if (unavailableCount > 0) {
      const regionToggle = createEl('button', {
        className: 'nwm-region-toggle',
        text: globalSettings.showCrossRegion ? 'Hide' : 'Show',
        attrs: {
          id: 'nwm-toggle-cross-region',
          type: 'button',
          'aria-label': globalSettings.showCrossRegion
            ? `Hide ${unavailableCount} unavailable or foreign items`
            : `Show ${unavailableCount} unavailable or foreign items`,
        },
      });
      regionToggle.addEventListener('click', () => {
        setCrossRegionVisibility(!globalSettings.showCrossRegion);
      });
      appendStatusPart(statusEl, `${unavailableCount} unavailable or from other regions`);
      statusEl.appendChild(document.createTextNode(' '));
      statusEl.appendChild(regionToggle);
    }

    const selection = NWM.getVisibleSelection(getVisibleSelectableItemIds(), selectedIds);
    if (selection.hiddenSelectedCount > 0) {
      appendStatusPart(statusEl, selection.hiddenSelectedCount === 1
        ? '1 selected item is filtered out'
        : `${selection.hiddenSelectedCount} selected items are filtered out`);
    }

    if (lockNotice) {
      appendStatusPart(statusEl, createEl('span', {
        className: 'nwm-lock-notice',
        text: lockNotice,
      }));
    }
  }

  function updateStatus(message, isError, onRetry) {
    statusOverride = message ? { message, isError: Boolean(isError), onRetry } : null;
    renderStatus();
  }

  function updateFilteredStatus(visible, visibilityScope, total, saleVisible) {
    statusSummary = {
      visible,
      visibilityScope,
      total,
      saleVisible,
      anyFilterActive: Boolean(
        filters.search || filters.onSale || filters.platform !== 'all' ||
        filters.contentType !== 'all'),
    };
    statusOverride = null;
    renderStatus();
  }

  function refreshCommittedSnapshot(options) {
    return runWithLock(async () => {
      if (!hasCommittedSnapshot || isLoading) return;

      isLoading = true;
      updateStatus('Loading wishlist…');
      showLoadingProgress();

      try {
        const snapshot = await loadSnapshot(options);
        commitSnapshot(snapshot, null);
        updatePlatformOptions();
        applyFiltersAndSort();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[NWM] Wishlist refresh failed:', message);
        isLoading = false;
        hideLoadingProgress();
        updateStatus(`Could not refresh your wishlist. ${message}`, true,
          refreshCommittedSnapshot);
      }
    });
  }

  function showFailureShell(error) {
    const message = error instanceof Error ? error.message : String(error);
    const targetSection = findWishlistSection() || sectionEl;
    if (!targetSection) return;

    removeDuplicateOwnedIds('nwm-toolbar', null);
    removeDuplicateOwnedIds('nwm-item-list', null);

    const shell = createEl('div', { attrs: { id: 'nwm-toolbar' } });
    const row = createEl('div', { className: 'nwm-row' });
    const status = createEl('div', {
      attrs: {
        id: 'nwm-status',
        role: 'status',
        'aria-live': 'polite',
        'aria-atomic': 'true',
      },
    });
    row.appendChild(status);
    shell.appendChild(row);

    const mount = getNativeMountPoint(targetSection);
    mount.parent.insertBefore(shell, mount.before);
    toolbarEl = shell;
    sectionEl = targetSection;
    updateStatus(`Could not load your wishlist. ${message}`, true, init);
  }

  async function bootstrapFromTop() {
    const rollback = NWM.makeRollback();
    let provisionalSection = null;

    try {
      provisionalSection = await waitForSection(10000);
      sectionEl = provisionalSection;

      if (toolbarEl) toolbarEl.remove();
      toolbarEl = null;
      scrollContainer = null;
      removeDuplicateOwnedIds('nwm-toolbar', null);
      removeDuplicateOwnedIds('nwm-item-list', null);

      const hadBootingClass = sectionEl.classList.contains('nwm-booting');
      sectionEl.classList.add('nwm-booting');
      rollback.add(() => {
        if (!hadBootingClass) provisionalSection.classList.remove('nwm-booting');
      });

      createToolbar(rollback);
      isLoading = true;
      updateStatus('Loading wishlist…');
      showLoadingProgress();

      if (!settingsLoaded) {
        const loadedSettings = await settingsApi.load();
        applyGlobalSettings(loadedSettings, { suppressRefresh: true });
        settingsLoaded = true;
      }
      applyTheme(rollback);
      await adapter.bootstrap();
      const snapshot = await loadSnapshot();
      updateProgress(snapshot.ids.length, snapshot.meta.reportedTotal);
      commitSnapshot(snapshot, rollback);
      rollback.clear();

      try {
        updatePlatformOptions();
        applyFiltersAndSort();
      } catch (postCommitError) {
        console.error('[NWM] Snapshot committed but UI finalization failed:', postCommitError);
        const message = postCommitError instanceof Error
          ? postCommitError.message
          : String(postCommitError);
        updateStatus(`Your wishlist loaded, but the extension could not finish updating the view. ${message}`, true,
          refreshCommittedSnapshot);
      }
    } catch (err) {
      const rollbackErrors = rollback.run();
      for (const rollbackError of rollbackErrors) {
        console.warn('[NWM] Bootstrap rollback step failed:', rollbackError);
      }

      if (nativeSuppressObserver) nativeSuppressObserver.disconnect();
      nativeSuppressObserver = null;
      hasCommittedSnapshot = false;
      isLoading = false;
      allItemIds = [];
      itemData = new Map();
      domNodes = new Map();
      scrollContainer = null;
      loadStatus = { reportedTotal: 0, partial: false };
      statusSummary = null;
      statusOverride = null;
      toolbarEl = null;

      console.error('[NWM] Failed to initialize extension:', err);
      showFailureShell(err);
    }
  }

  // ── Initialization ────────────────────────────────────────────────────

  function init() {
    if (hasCommittedSnapshot) return refreshCommittedSnapshot();
    return runWithLock(bootstrapFromTop);
  }

  settingsApi.subscribe((next) => {
    applyGlobalSettings(next);
  });

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
