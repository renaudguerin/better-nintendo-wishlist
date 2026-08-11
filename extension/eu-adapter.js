/**
 * Better Wishlist for Nintendo eShop — Europe Adapter
 * Maps the page-world Savanna transport into the canonical adapter model.
 */
(function () {
  'use strict';

  const NWMAdapters = globalThis.NWMAdapters;
  const MAX_RETRIES = 3;
  const DELETE_MAX_RETRIES = 2;
  const RETRY_BASE_MS = 1000;
  const DELETE_RETRY_BASE_MS = 750;
  const BRIDGE_TIMEOUT_MS = 60000;
  const PING_INTERVAL_MS = 250;
  const PING_TOTAL_TIMEOUT_MS = 3000;
  const PING_REQUEST_TIMEOUT_MS = 500;
  const BRIDGE_REQUEST_EVENT = 'nwm:request';
  const BRIDGE_RESPONSE_EVENT = 'nwm:response';
  const ROOT_SELECTOR = 'main';
  const NATIVE_SCROLL_SELECTOR = '.infinite-scroll-component__outerdiv, .infinite-scroll-component';
  const NATIVE_ITEM_SELECTOR = [
    'div.border-b.border-black.border-opacity-10.pt-4.pb-6',
    'li.border-b.border-black\\/10',
  ].join(',');
  const HIDDEN_SELECTORS = Object.freeze([
    '.infinite-scroll-component__outerdiv',
    '.infinite-scroll-component',
    'ul.flex.flex-col',
    'div.border-b.border-black\\/10.pb-2.text-base.text-default',
    'div.border-b.border-black.border-opacity-10.pt-4.pb-6:not(.nwm-item-managed)',
    'li.border-b.border-black\\/10:not(.nwm-item-managed)',
  ]);
  const WIDTH_CAP_SELECTOR = '.max-w-single-column';
  const RESOLVER_COUNTRY_ORDER = Object.freeze(['US', 'GB', 'JP']);
  const deleteReferences = new WeakMap();
  let bridgeRequestSeq = 0;

  function matchesEurope(locationLike) {
    return Boolean(locationLike) &&
      locationLike.origin === 'https://ec.nintendo.com' &&
      /^\/my\/wishlist\/?$/.test(locationLike.pathname || '');
  }

  if (!NWMAdapters || !matchesEurope(window.location)) return;

  function findSection(documentLike) {
    const root = documentLike.querySelector(ROOT_SELECTOR);
    const scope = root || documentLike;
    const sections = [...scope.querySelectorAll('section')];

    for (const section of sections) {
      if (section.querySelector(NATIVE_SCROLL_SELECTOR)) return section;
    }
    for (const section of sections) {
      if (section.querySelector(NATIVE_ITEM_SELECTOR)) return section;
    }
    for (const section of sections) {
      const heading = section.querySelector('h1, h2');
      if (heading && section.querySelector('hr')) return section;
    }
    return null;
  }

  function getMountPoint(section) {
    const hr = section.querySelector('hr');
    const scrollOuter = section.querySelector(NATIVE_SCROLL_SELECTOR);
    const nativeItem = section.querySelector(NATIVE_ITEM_SELECTOR);
    const heading = section.querySelector('h1, h2');
    let mount;

    if (hr && hr.parentNode) {
      mount = { parent: hr.parentNode, before: hr, hr };
    } else if (scrollOuter && scrollOuter.parentNode) {
      mount = { parent: scrollOuter.parentNode, before: scrollOuter, hr: null };
    } else if (nativeItem && nativeItem.parentNode) {
      mount = { parent: nativeItem.parentNode, before: nativeItem, hr: null };
    } else if (heading && heading.parentNode) {
      mount = { parent: heading.parentNode, before: heading.nextSibling, hr: null };
    } else {
      mount = { parent: section, before: section.firstChild, hr: null };
    }

    return globalThis.NWM.hoistBelowWidthCap(
      section,
      globalThis.NWM.hoistMountPoint(section, mount, HIDDEN_SELECTORS),
      WIDTH_CAP_SELECTOR,
    );
  }

  function getManagedNativeNodes(section) {
    if (!section) return [];
    const wrappers = new Set();
    for (const wrapper of section.children) {
      if (!wrapper.matches(WIDTH_CAP_SELECTOR)) continue;
      const hasWishListHeading = Array.from(wrapper.querySelectorAll('h1, h2')).some((node) =>
        node.textContent.trim() === 'Wish List');
      if (hasWishListHeading) wrappers.add(wrapper);
    }
    return [...wrappers];
  }

  const nativePolicy = Object.freeze({
    rootSelector: ROOT_SELECTOR,
    nativeItemSelector: NATIVE_ITEM_SELECTOR,
    hiddenSelectors: HIDDEN_SELECTORS,
    findSection,
    getMountPoint,
    getManagedNativeNodes,
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseBridgeDetail(detail) {
    if (typeof detail !== 'string') return null;
    try {
      return JSON.parse(detail);
    } catch (err) {
      return null;
    }
  }

  function requestBridge(action, payload, options) {
    return new Promise((resolve, reject) => {
      const requestId = `nwm-${Date.now()}-${++bridgeRequestSeq}`;
      const requestedTimeout = options && options.timeoutMs;
      const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
        ? requestedTimeout
        : BRIDGE_TIMEOUT_MS;
      let settled = false;

      const cleanup = () => {
        document.removeEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
        clearTimeout(timeoutId);
      };

      const onResponse = (event) => {
        const response = parseBridgeDetail(event.detail);
        if (!response || response.requestId !== requestId) return;
        settled = true;
        cleanup();
        if (response.ok) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || `Bridge request failed: ${action}`));
        }
      };

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Bridge request timed out: ${action}`));
      }, timeoutMs);

      document.addEventListener(BRIDGE_RESPONSE_EVENT, onResponse);
      document.dispatchEvent(new CustomEvent(BRIDGE_REQUEST_EVENT, {
        detail: JSON.stringify({ requestId, action, payload: payload || {} }),
      }));
    });
  }

  function getPollSchedule(intervalMs, totalTimeoutMs) {
    const schedule = [];
    for (let offset = 0; offset < totalTimeoutMs; offset += intervalMs) schedule.push(offset);
    return schedule;
  }

  function pollBridgePing() {
    const schedule = getPollSchedule(PING_INTERVAL_MS, PING_TOTAL_TIMEOUT_MS);
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastError = null;
      const attemptTimers = [];
      const cleanupSchedule = () => {
        for (const timer of attemptTimers) clearTimeout(timer);
        clearTimeout(deadlineTimer);
      };
      const succeed = (data) => {
        if (settled) return;
        settled = true;
        cleanupSchedule();
        resolve(data);
      };

      for (const offset of schedule) {
        attemptTimers.push(setTimeout(() => {
          requestBridge('ping', {}, { timeoutMs: PING_REQUEST_TIMEOUT_MS })
            .then((data) => {
              if (!data || data.ok !== true) throw new Error('Bridge ping returned an unexpected response');
              succeed(data);
            })
            .catch((err) => { lastError = err; });
        }, offset));
      }

      const deadlineTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupSchedule();
        const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
        reject(new Error(`Nintendo bridge was not ready within 3 seconds${detail}`));
      }, PING_TOTAL_TIMEOUT_MS);
    });
  }

  async function requestBridgeWithRetry(action, payload, retries) {
    const retryCount = Number.isInteger(retries) ? retries : MAX_RETRIES;
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        return await requestBridge(action, payload);
      } catch (err) {
        if (attempt >= retryCount) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[NWM] Request failed (attempt ${attempt + 1}/${retryCount + 1}): ${action}`, message);
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
  }

  function isLikelyTransientDeleteError(message) {
    return /Bridge request timed out|GraphQL fetch failed|Failed to fetch|HTTP (429|5\d\d)|904-9001|9001-1620/i.test(message);
  }

  async function requestDeleteWithRetry(id) {
    for (let attempt = 0; attempt <= DELETE_MAX_RETRIES; attempt++) {
      try {
        return await requestBridge('deleteWishlistItem', { id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= DELETE_MAX_RETRIES || !isLikelyTransientDeleteError(message)) throw err;
        console.warn(`[NWM] Delete failed transiently for ${id} (attempt ${attempt + 1}/${DELETE_MAX_RETRIES + 1}):`, message);
        await sleep(DELETE_RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function nullableString(value) {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  function nullableDate(value) {
    const date = nullableString(value);
    return date !== null && Number.isFinite(new Date(date).getTime()) ? date : null;
  }

  function mapMoney(value) {
    if (!isObject(value)) return null;
    const raw = typeof value.rawValue === 'number' ? value.rawValue : Number(value.rawValue);
    return {
      value: Number.isFinite(raw) ? raw : null,
      formatted: nullableString(value.formattedValue),
      currency: nullableString(value.currency),
    };
  }

  function mapContentType(type) {
    if (type === 'ApplicationItem') return 'title';
    if (type === 'DlcItem') return 'aoc';
    if (type === 'BundleItem') return 'bundle';
    return 'unknown';
  }

  function mapProductPath(type) {
    if (type === 'DlcItem') return 'aocs';
    if (type === 'BundleItem') return 'bundles';
    return 'titles';
  }

  function platformLabel(code) {
    if (code === 'HAC') return 'Nintendo Switch';
    if (code === 'BEE') return 'Nintendo Switch 2';
    return code ? `Platform: ${code}` : null;
  }

  function salesStatusValue(statuses, key) {
    const value = isObject(statuses) ? statuses[key] : null;
    const status = isObject(value) ? value.salesStatus : value;
    return typeof status === 'string' && status.trim() ? status.trim() : null;
  }

  function mapSalesStatus(statuses, platformCode) {
    const keys = platformCode === 'HAC'
      ? ['hac', 'offdevice', 'bee']
      : platformCode === 'BEE'
        ? ['bee', 'offdevice', 'hac']
        : ['offdevice', 'hac', 'bee'];
    for (const key of keys) {
      const value = salesStatusValue(statuses, key);
      if (!value) continue;
      const normalized = value.toLowerCase();
      if (normalized === 'preorder' || normalized === 'unreleased') return normalized;
    }
    return null;
  }

  function requireNumericId(value) {
    const id = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new Error('Invalid Europe wishlist item ID');
    }
    return id;
  }

  function mapTransportItem(rawItem, context) {
    if (!isObject(rawItem)) throw new Error('Invalid Europe transport item');
    const id = requireNumericId(rawItem.id);
    const sourceItem = isObject(rawItem.item) ? rawItem.item : null;
    const sourcePrice = isObject(rawItem.price) ? rawItem.price : null;
    const code = sourceItem ? nullableString(sourceItem.platformCode) : null;
    const type = sourceItem ? sourceItem.type : null;

    const isResolved = sourceItem !== null;
    return {
      id,
      name: sourceItem && typeof sourceItem.name === 'string' ? sourceItem.name : '',
      productUrl: sourceItem && context.country && context.language
        ? `/${context.country}/${context.language}/${mapProductPath(type)}/${id}`
        : null,
      imageUrl: sourceItem ? nullableString(sourceItem.imageUrl) : null,
      platformCode: code,
      platformLabel: platformLabel(code),
      contentType: sourceItem ? mapContentType(type) : 'unknown',
      pricing: {
        regular: sourcePrice ? mapMoney(sourcePrice.regular) : null,
        sale: sourcePrice ? mapMoney(sourcePrice.sale) : null,
        saleEndAt: sourcePrice ? nullableDate(sourcePrice.saleEndAt) : null,
      },
      releaseDate: sourceItem ? nullableDate(sourceItem.releaseDate) : null,
      addedAt: nullableDate(rawItem.createdAt),
      salesStatus: sourcePrice ? mapSalesStatus(sourcePrice.statuses, code) : null,
      owned: Boolean(sourcePrice && sourcePrice.owned),
      isNew: false,
      isSpecialTrial: Boolean(sourceItem && sourceItem.isSpecialTrial),
      availability: sourceItem ? 'available' : 'unavailable',
      canDelete: true,
      catalogRegion: isResolved ? context.country : null,
      catalogRelation: isResolved ? 'current' : 'unresolved',
      resolutionStatus: isResolved ? 'resolved' : 'not-requested',
    };
  }

  function mapEuropeTransportEnvelope(transport) {
    if (!isObject(transport) || transport.version !== 2 || !Array.isArray(transport.items)) {
      throw new Error('Unexpected Europe transport response shape');
    }
    const sourceContext = isObject(transport.context) ? transport.context : {};
    if (typeof sourceContext.country !== 'string' || !/^[A-Z]{2}$/.test(sourceContext.country) ||
        typeof sourceContext.language !== 'string' || !sourceContext.language) {
      throw new Error('Unexpected Europe transport context');
    }
    const context = {
      country: sourceContext.country,
      language: sourceContext.language,
      completedCountries: transport.partial === true ? [] : [sourceContext.country],
      failedCountries: transport.partial === true ? [sourceContext.country] : [],
    };
    const items = transport.items.map((item) => mapTransportItem(item, context));
    const snapshot = {
      adapterId: 'eu',
      items,
      total: Number.isFinite(transport.total) && transport.total >= 0 ? transport.total : items.length,
      partial: transport.partial === true,
      context,
    };

    NWMAdapters.validateSnapshot(snapshot);
    return snapshot;
  }

  function getResolverCountries(currentCountry) {
    const seen = new Set([currentCountry]);
    const countries = [];
    for (const country of RESOLVER_COUNTRY_ORDER) {
      if (seen.has(country)) continue;
      seen.add(country);
      countries.push(country);
    }
    return countries;
  }

  function providerCategory(rawItem) {
    const sourceItem = isObject(rawItem) && isObject(rawItem.item) ? rawItem.item : null;
    return sourceItem ? mapContentType(sourceItem.type) : 'unknown';
  }

  function providerIdentity(rawItem) {
    const id = requireNumericId(rawItem && rawItem.id);
    const category = providerCategory(rawItem);
    if (category === 'unknown') throw new Error('Unsupported Europe provider category');
    return { id, category, key: `${category}:${id}` };
  }

  function mergeForeignCandidate(original, rawItem, context) {
    const mapped = mapTransportItem(rawItem, context);
    return {
      ...original,
      name: mapped.name,
      productUrl: null,
      imageUrl: mapped.imageUrl,
      platformCode: mapped.platformCode,
      platformLabel: mapped.platformLabel,
      contentType: mapped.contentType,
      pricing: { regular: null, sale: null, saleEndAt: null },
      releaseDate: mapped.releaseDate,
      salesStatus: null,
      availability: 'unavailable',
      canDelete: false,
      catalogRegion: context.country,
      catalogRelation: 'foreign',
      resolutionStatus: 'resolved',
    };
  }

  function applyResolverResponse(snapshot, countries, response) {
    const completedCountries = snapshot.context.completedCountries.slice();
    const failedCountries = snapshot.context.failedCountries.slice();
    const items = snapshot.items.slice();
    const unresolvedIndexes = new Map();
    for (let index = 0; index < items.length; index++) {
      if (items[index].catalogRelation === 'unresolved') unresolvedIndexes.set(items[index].id, index);
    }

    const results = isObject(response) && response.version === 1 && Array.isArray(response.results)
      ? response.results
      : [];
    const resultsByCountry = new Map();
    for (const result of results) {
      if (!isObject(result) || !countries.includes(result.country) || resultsByCountry.has(result.country)) continue;
      resultsByCountry.set(result.country, result);
    }

    for (const country of countries) {
      const result = resultsByCountry.get(country);
      const transport = result && result.ok === true ? result.data : null;
      const context = isObject(transport) && isObject(transport.context) ? transport.context : null;
      const validTransport = isObject(transport) && transport.version === 2 &&
        Array.isArray(transport.items) && context && context.country === country &&
        typeof context.language === 'string' && context.language;
      if (!validTransport) {
        failedCountries.push(country);
        continue;
      }

      let countryFailed = transport.partial === true;
      const targetIds = new Set(unresolvedIndexes.keys());
      const memberships = new Map();
      for (const rawItem of transport.items) {
        if (!isObject(rawItem)) {
          countryFailed = true;
          continue;
        }
        let id;
        try {
          id = requireNumericId(rawItem.id);
        } catch (_err) {
          countryFailed = true;
          continue;
        }
        if (!targetIds.has(id)) continue;
        let membership = memberships.get(id);
        if (!membership) {
          membership = { candidates: new Map(), invalid: false };
          memberships.set(id, membership);
        }
        if (rawItem.item === null) continue;
        if (!isObject(rawItem.item)) {
          membership.invalid = true;
          countryFailed = true;
          continue;
        }
        try {
          const innerId = requireNumericId(rawItem.item.nsUid);
          const identity = providerIdentity(rawItem);
          if (innerId !== id) throw new Error('Europe provider identity mismatch');
          if (!membership.candidates.has(identity.key)) {
            membership.candidates.set(identity.key, rawItem);
          }
        } catch (_err) {
          membership.invalid = true;
          countryFailed = true;
        }
      }

      for (const id of targetIds) {
        const membership = memberships.get(id);
        if (!membership) {
          countryFailed = true;
          continue;
        }
        if (membership.invalid || membership.candidates.size > 1) {
          countryFailed = true;
          continue;
        }
        if (membership.candidates.size === 0) continue;
        const index = unresolvedIndexes.get(id);
        const rawItem = membership.candidates.values().next().value;
        try {
          // Savanna omits category when itemV2 is null. Bind that unresolved
          // nsUid only when this country supplies one unambiguous, matching
          // category candidate. Deleting the index gives earlier countries
          // deterministic priority without blessing same-country ambiguity.
          items[index] = mergeForeignCandidate(items[index], rawItem, context);
          unresolvedIndexes.delete(id);
        } catch (_err) {
          countryFailed = true;
        }
      }
      if (countryFailed) failedCountries.push(country);
      else completedCountries.push(country);
    }

    const resolutionStatus = failedCountries.length > 0 ? 'partial' : 'complete-unresolved';
    for (const index of unresolvedIndexes.values()) {
      items[index] = {
        ...items[index],
        canDelete: resolutionStatus === 'complete-unresolved' && items[index].canDelete,
        resolutionStatus,
      };
    }

    const resolvedSnapshot = {
      ...snapshot,
      items,
      context: {
        ...snapshot.context,
        completedCountries,
        failedCountries,
      },
    };
    NWMAdapters.validateSnapshot(resolvedSnapshot);
    return resolvedSnapshot;
  }

  function getCapabilities(snapshot) {
    const platforms = [];
    const seen = new Set();
    if (snapshot && Array.isArray(snapshot.items)) {
      for (const item of snapshot.items) {
        if (!item.platformCode || !item.platformLabel || seen.has(item.platformCode)) continue;
        seen.add(item.platformCode);
        platforms.push({ code: item.platformCode, label: item.platformLabel });
      }
      platforms.sort((left, right) => left.code.localeCompare(right.code));
    }
    return {
      filters: { search: true, onSale: true, platform: true, contentType: true },
      sorts: [
        'name-az', 'name-za', 'price-asc', 'price-desc', 'discount',
        'release-date', 'sale-end', 'date-added-newest', 'date-added-oldest',
      ],
      actions: { select: true, delete: true, bulkDelete: true, reviews: true },
      crossRegionResolution: true,
      platforms,
    };
  }

  const adapter = {
    id: 'eu',
    matches: matchesEurope,
    getCapabilities,
    getNativePolicy: () => nativePolicy,
    bootstrap: () => pollBridgePing(),
    async loadItems(options) {
      const snapshot = mapEuropeTransportEnvelope(await requestBridgeWithRetry('getWishlistData'));
      let resolvedSnapshot = snapshot;
      if (options && options.includeCrossRegion === true) {
        const countries = getResolverCountries(snapshot.context.country);
        let response;
        try {
          response = await requestBridgeWithRetry('resolveWishlistCountries', { countries });
        } catch (_err) {
          response = null;
        }
        resolvedSnapshot = applyResolverResponse(snapshot, countries, response);
      }
      for (const item of resolvedSnapshot.items) {
        if (item.canDelete) deleteReferences.set(item, item.id);
      }
      return resolvedSnapshot;
    },
    async deleteItem(item) {
      if (!item || typeof item !== 'object' || item.canDelete !== true || !deleteReferences.has(item)) {
        throw new Error('Cannot delete an item that was not loaded by the Europe adapter');
      }
      return requestDeleteWithRetry(deleteReferences.get(item));
    },
  };

  NWMAdapters.register(adapter);

  if (globalThis.__NWM_TEST__) {
    globalThis.NWMEuAdapterTest = Object.freeze({
      mapTransportItem,
      mapEuropeTransportEnvelope,
      mapSalesStatus,
      getCapabilities,
      getNativePolicy: () => nativePolicy,
      requestBridge,
      getResolverCountries,
      providerIdentity,
      mergeForeignCandidate,
      applyResolverResponse,
    });
  }
})();
