/**
 * Better Wishlist for Nintendo eShop — Page Context Bridge
 * Keeps page-authenticated fetches in the page world while the main extension
 * logic stays in the browser's isolated content-script world.
 */
(function () {
  'use strict';

  if (!/^\/my\/wishlist\/?$/.test(window.location.pathname)) return;

  const REQUEST_EVENT = 'nwm:request';
  const RESPONSE_EVENT = 'nwm:response';
  const SHOP_ID_CACHE_KEY = 'nwm_shop_id';
  const ID_TOKEN_REFRESH_WINDOW_MS = 60000;
  const MAX_PAGINATION_PAGES = 50;
  const MAX_PAGINATION_LIMIT = 100;
  const MAX_RESOLVER_COUNTRIES = 3;
  const RESOLVER_COUNTRIES = new Set(['US', 'GB', 'JP']);
  let graphqlConfig = null;
  let graphqlConfigPromise = null;
  let idTokenCache = null;

  const WISHLIST_QUERY = `
    query InfiniteScrollWishlist(
      $shopId: Int!
      $country: CountryCode!
      $language: LanguageCode!
      $idToken: String!
      $offset: Int!
      $limit: Int!
    ) @inContext(shopId: $shopId, country: $country, language: $language) {
      account {
        wishlist {
          wishlistItems(idToken: $idToken, offset: $offset, limit: $limit) {
            items {
              nsUid
              createdDatetime
              itemV2 {
                __typename
                ... on ApplicationItem {
                  nsUid
                  formalName
                  labelPlatform
                  heroBannerUrl
                  releaseDateOnEshop
                  isSpecialTrial
                }
                ... on DlcItem {
                  nsUid
                  formalName
                  labelPlatform
                  heroBannerUrl
                  releaseDateOnEshop
                }
                ... on BundleItem {
                  nsUid
                  formalName
                  labelPlatform
                  heroBannerUrl
                  releaseDateOnEshop
                }
              }
              price(idToken: $idToken) {
                nsUid
                right {
                  isSelfOwned
                  ownedItems {
                    isSelfOwned
                    isScheduledOrdered
                  }
                }
                regularPrice {
                  formattedValue
                  rawValue
                  currency
                }
                discountPrice {
                  formattedValue
                  rawValue
                  endDatetime
                  currency
                }
                itemStatuses {
                  offdevice { salesStatus }
                  hac { salesStatus }
                  bee { salesStatus }
                }
              }
            }
            offsetInfo {
              offset
              total
            }
          }
        }
      }
    }
  `;

  const DELETE_WISHLIST_MUTATION = `
    mutation UseRemoveWishlistWithSession(
      $shopId: Int!
      $country: CountryCode!
      $language: LanguageCode!
      $idToken: String!
      $nsUid: NsUid!
    ) @inContext(shopId: $shopId, country: $country, language: $language) {
      wishlistDeleteV2(idToken: $idToken, nsUid: $nsUid)
    }
  `;

  if (window.__nwmBridgeInstalled) return;
  window.__nwmBridgeInstalled = true;

  const pageFetch = window.fetch.bind(window);

  function parseDetail(detail) {
    if (typeof detail !== 'string') return null;
    try {
      return JSON.parse(detail);
    } catch (err) {
      return null;
    }
  }

  function emitResponse(requestId, ok, payload) {
    document.dispatchEvent(new CustomEvent(RESPONSE_EVENT, {
      detail: JSON.stringify({
        requestId,
        ok,
        data: ok ? payload : undefined,
        error: ok ? undefined : payload,
      }),
    }));
  }

  function requireItemId(value) {
    const id = String(value == null ? '' : value).trim();
    if (!/^\d+$/.test(id)) {
      throw new Error('Invalid wishlist item ID');
    }
    return id;
  }

  function requireBoundedInteger(value, name, maximum, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new Error(`${name} must be an integer from 1 to ${maximum}`);
    }
    return value;
  }

  function validateResolverRequest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Resolver payload must be an object');
    }
    if (!Array.isArray(payload.countries) || payload.countries.length < 1 ||
        payload.countries.length > MAX_RESOLVER_COUNTRIES) {
      throw new Error(`Resolver countries must contain 1 to ${MAX_RESOLVER_COUNTRIES} entries`);
    }
    const countries = [];
    const seen = new Set();
    for (const country of payload.countries) {
      if (typeof country !== 'string' || !RESOLVER_COUNTRIES.has(country)) {
        throw new Error('Resolver country must be one of: US, GB, JP');
      }
      if (seen.has(country)) throw new Error(`Resolver countries contains duplicate country: ${country}`);
      seen.add(country);
      countries.push(country);
    }
    const pagination = payload.pagination === undefined ? {} : payload.pagination;
    if (!pagination || typeof pagination !== 'object' || Array.isArray(pagination)) {
      throw new Error('Resolver pagination must be an object');
    }
    return {
      countries,
      limit: requireBoundedInteger(
        pagination.limit,
        'Resolver pagination.limit',
        MAX_PAGINATION_LIMIT,
        MAX_PAGINATION_LIMIT,
      ),
      maxPages: requireBoundedInteger(
        pagination.maxPages,
        'Resolver pagination.maxPages',
        MAX_PAGINATION_PAGES,
        MAX_PAGINATION_PAGES,
      ),
    };
  }

  function toNsUidInput(id) {
    const nsUid = Number(id);
    if (!Number.isSafeInteger(nsUid)) {
      throw new Error('Invalid wishlist item ID');
    }
    return nsUid;
  }

  async function fetchJson(path, options) {
    const response = await pageFetch(path, {
      credentials: 'include',
      ...options,
    });

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (err) {
        // The status code is still useful if the browser refuses the body.
      }
      const details = body ? `: ${body.slice(0, 500)}` : '';
      throw new Error(`HTTP ${response.status}${details}`);
    }

    return response.json();
  }

  function getDecodedPageHtml() {
    const html = document.documentElement && document.documentElement.innerHTML;
    return String(html || '')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\//g, '/')
      .replace(/\\u0026/g, '&');
  }

  function firstMatch(text, patterns) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match;
    }
    return null;
  }

  function isValidGraphqlUrl(value) {
    if (typeof value !== 'string') return false;

    const authorityMatch = value.match(/^https:\/\/([^/?#]+)/i);
    if (!authorityMatch || authorityMatch[1].includes('@') || /:\d*$/.test(authorityMatch[1])) {
      return false;
    }

    try {
      const url = new URL(value);
      const hostname = url.hostname.toLowerCase();
      const isNintendoHost = hostname.endsWith('.nintendo.net') || hostname.endsWith('.nintendo.com');
      return url.protocol === 'https:' &&
        url.port === '' &&
        isNintendoHost &&
        url.pathname === '/graphql';
    } catch (err) {
      return false;
    }
  }

  function detectLocaleFromPage(text) {
    const localeMatch = firstMatch(text, [
      /"locale"\s*:\s*\{[^}]*"country"\s*:\s*"([A-Z]{2})"[^}]*"language"\s*:\s*"([a-z]{2})"/,
      /"country"\s*:\s*"([A-Z]{2})"[^}]{0,160}"language"\s*:\s*"([a-z]{2})"/,
    ]);
    if (localeMatch) return { country: localeMatch[1], language: localeMatch[2] };

    const link = document.querySelector('a[href*="/titles/"], a[href*="/aocs/"], a[href*="/bundles/"]');
    if (link) {
      const match = link.href.match(/\/([A-Z]{2})\/([a-z]{2})\/(?:titles|aocs|bundles)\//);
      if (match) return { country: match[1], language: match[2] };
    }

    return null;
  }

  function getCachedShopId() {
    try {
      const value = sessionStorage.getItem(SHOP_ID_CACHE_KEY);
      const shopId = value && /^\d+$/.test(value) ? Number(value) : null;
      if (Number.isSafeInteger(shopId) && shopId > 0) return shopId;
    } catch (err) {
      // Storage can be unavailable under restrictive browser settings.
    }
    return null;
  }

  function cacheShopId(shopId) {
    try {
      // sessionStorage is page-partitioned; this is a non-secret discovery
      // cache only. Tokens must never be stored here.
      sessionStorage.setItem(SHOP_ID_CACHE_KEY, String(shopId));
    } catch (err) {
      // Config discovery still works when storage is unavailable.
    }
  }

  async function detectShopIdFromScripts() {
    const cachedShopId = getCachedShopId();
    if (cachedShopId) return cachedShopId;

    const chunkScripts = [...document.scripts]
      .map((script) => script.src)
      .filter((src) => src && src.includes('/_next/static/chunks/'));

    for (const src of chunkScripts) {
      try {
        const response = await pageFetch(src, { credentials: 'include' });
        if (!response.ok) continue;
        const source = await response.text();
        const match = source.match(/["']SHOP_ID["']\s*,\s*0\s*,\s*(\d+)/);
        if (match) {
          const shopId = Number(match[1]);
          cacheShopId(shopId);
          return shopId;
        }
      } catch (err) {
        // Keep scanning other chunks; one blocked or evicted script should not
        // prevent finding the shared Nintendo config module.
      }
    }

    return null;
  }

  async function resolveGraphqlConfig() {
    if (graphqlConfig) return graphqlConfig;

    const text = getDecodedPageHtml();
    const urlMatch = firstMatch(text, [
      /"url"\s*:\s*"(https?:\/\/[^"]+\/graphql)"/,
      /\burl\s*:\s*"(https?:\/\/[^"]+\/graphql)"/,
    ]);
    const clientMatch = firstMatch(text, [
      /"X-Nintendo-Savanna-Client-Id"\s*:\s*"([^"]+)"/i,
      /"x-nintendo-savanna-client-id"\s*:\s*"([^"]+)"/i,
    ]);
    const shopMatch = firstMatch(text, [
      /"shopId"\s*:\s*(\d+)/,
      /\bshopId\s*:\s*(\d+)/,
    ]);
    const shopId = shopMatch ? Number(shopMatch[1]) : await detectShopIdFromScripts();
    const locale = detectLocaleFromPage(text);
    const missing = [];

    if (!urlMatch || !isValidGraphqlUrl(urlMatch[1])) missing.push('GraphQL URL');
    if (!clientMatch) missing.push('Savanna client id');
    if (!shopId) missing.push('shopId');
    if (!locale) missing.push('locale');
    if (missing.length > 0) {
      throw new Error(`Nintendo GraphQL config not found in page data: ${missing.join(', ')}`);
    }

    cacheShopId(shopId);

    graphqlConfig = {
      url: urlMatch[1],
      clientId: clientMatch[1],
      shopId,
      locale,
    };
    return graphqlConfig;
  }

  function getGraphqlConfig() {
    if (!graphqlConfigPromise) {
      graphqlConfigPromise = resolveGraphqlConfig().catch((err) => {
        graphqlConfigPromise = null;
        throw err;
      });
    }
    return graphqlConfigPromise;
  }

  async function fetchGraphql(query, variables) {
    const config = await getGraphqlConfig();
    let response;
    try {
      response = await pageFetch(config.url, {
        method: 'POST',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'x-nintendo-savanna-client-id': config.clientId,
        },
        body: JSON.stringify({
          operationName: getOperationName(query),
          query,
          variables,
        }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`GraphQL fetch failed: ${message}`);
    }

    if (!response.ok) {
      let body = '';
      try {
        body = await response.text();
      } catch (err) {
        // The status code is still useful if the browser refuses the body.
      }
      const details = body ? `: ${body.slice(0, 500)}` : '';
      throw new Error(`HTTP ${response.status}${details}`);
    }

    const data = await response.json();
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      throw createGraphqlResponseError(data.errors);
    }
    return data.data;
  }

  function extensionIndicatesInvalidIdToken(value, key) {
    if (value == null) return false;

    const normalizedKey = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (typeof value === 'string') {
      const normalizedValue = value.toUpperCase();
      if (normalizedValue === '9001-1620' ||
          normalizedValue === 'INVALID_ID_TOKEN' ||
          normalizedValue === 'ID_TOKEN_EXPIRED' ||
          normalizedValue === 'EXPIRED_ID_TOKEN') {
        return true;
      }
      if (/id[\s_-]*token/i.test(value) && /invalid|expired/i.test(value)) return true;
      if (normalizedKey.includes('idtoken') && /invalid|expired/i.test(value)) return true;
    }

    if (value === true && normalizedKey.includes('idtoken') &&
        (normalizedKey.includes('invalid') || normalizedKey.includes('expired'))) {
      return true;
    }

    if (typeof value === 'object') {
      return Object.entries(value).some(([childKey, childValue]) =>
        extensionIndicatesInvalidIdToken(childValue, childKey));
    }

    return false;
  }

  function isAuthRejectedGraphqlErrors(errors) {
    return Array.isArray(errors) && errors.some((error) => error && (
      /(^|\D)9001-1620(\D|$)/.test(String(error.message || '')) ||
      extensionIndicatesInvalidIdToken(error.extensions, 'extensions')
    ));
  }

  function createGraphqlResponseError(errors) {
    const error = new Error(formatGraphqlErrors(errors));
    error.name = 'GraphqlResponseError';
    error.authRejected = isAuthRejectedGraphqlErrors(errors);
    return error;
  }

  function formatGraphqlErrors(errors) {
    const first = errors[0] || {};
    const message = first.message || 'GraphQL request failed';
    if (!first.extensions) return message;

    let details = '';
    try {
      details = JSON.stringify(first.extensions).slice(0, 500);
    } catch (err) {
      details = String(first.extensions).slice(0, 500);
    }

    return details ? `${message}: ${details}` : message;
  }

  function getOperationName(query) {
    const match = query.match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
    return match ? match[2] : undefined;
  }

  function parseJwtExp(idToken) {
    if (typeof idToken !== 'string') return null;
    const parts = idToken.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+={0,2}$/.test(parts[1])) return null;

    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    if (payload.length % 4 === 1) return null;
    const padded = payload + '='.repeat((4 - payload.length % 4) % 4);

    try {
      const parsed = JSON.parse(atob(padded));
      return parsed && typeof parsed.exp === 'number' && Number.isFinite(parsed.exp)
        ? parsed.exp
        : null;
    } catch (err) {
      return null;
    }
  }

  function shouldRefreshIdToken(idToken, nowMs) {
    const expiresAtSeconds = parseJwtExp(idToken);
    const currentTimeMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    return expiresAtSeconds == null ||
      expiresAtSeconds * 1000 <= currentTimeMs + ID_TOKEN_REFRESH_WINDOW_MS;
  }

  function invalidateIdTokenCache() {
    idTokenCache = null;
  }

  async function getIdToken() {
    if (idTokenCache && !shouldRefreshIdToken(idTokenCache)) {
      return idTokenCache;
    }

    invalidateIdTokenCache();
    const session = await fetchJson('/api/auth/session');
    if (!session || !session.idToken) {
      throw new Error('Missing Nintendo session idToken');
    }
    idTokenCache = session.idToken;
    return idTokenCache;
  }

  async function withIdTokenRetry(operation) {
    const idToken = await getIdToken();
    try {
      return await operation(idToken);
    } catch (err) {
      if (!err || err.authRejected !== true) throw err;
      invalidateIdTokenCache();
      const freshIdToken = await getIdToken();
      try {
        return await operation(freshIdToken);
      } catch (retryErr) {
        if (retryErr && retryErr.authRejected === true) invalidateIdTokenCache();
        throw retryErr;
      }
    }
  }

  function fetchAuthenticatedGraphql(query, variables) {
    return withIdTokenRetry((idToken) => fetchGraphql(query, {
      ...variables,
      idToken,
    }));
  }

  // This deliberately remains close to the Savanna response. The isolated
  // adapter, rather than the page-world bridge, owns the canonical model.
  function mapTransportMoney(value) {
    if (!value) return null;
    return {
      rawValue: value.rawValue,
      formattedValue: value.formattedValue,
      currency: value.currency,
    };
  }

  function mapTransportStatuses(itemStatuses) {
    const statuses = {};
    for (const key of ['offdevice', 'hac', 'bee']) {
      const value = getSalesStatusValue(itemStatuses, key);
      if (value !== null) statuses[key] = value;
    }
    return statuses;
  }

  function toEuropeTransportItem(item) {
    const id = String(item && item.nsUid ? item.nsUid : '');
    const fragment = item && item.itemV2;
    const price = item && item.price;
    if (!id) return null;

    return {
      id,
      createdAt: item.createdDatetime || '',
      item: fragment ? {
        nsUid: String(fragment.nsUid == null ? '' : fragment.nsUid),
        type: fragment.__typename,
        name: fragment.formalName || '',
        platformCode: fragment.labelPlatform || '',
        imageUrl: fragment.heroBannerUrl || '',
        releaseDate: fragment.releaseDateOnEshop || '',
        isSpecialTrial: Boolean(fragment.isSpecialTrial),
      } : null,
      price: price ? {
        regular: mapTransportMoney(price.regularPrice),
        sale: mapTransportMoney(price.discountPrice),
        saleEndAt: price.discountPrice && price.discountPrice.endDatetime || null,
        statuses: mapTransportStatuses(price.itemStatuses),
        owned: Boolean(price.right && price.right.isSelfOwned),
      } : null,
    };
  }

  function getSalesStatusValue(itemStatuses, key) {
    const value = itemStatuses && itemStatuses[key] && itemStatuses[key].salesStatus;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function getPaginationProgress(options) {
    const rawItemCount = options.rawItemCount;
    const newItemCount = options.newItemCount;
    const loadedCount = options.loadedCount;
    const reportedTotal = options.reportedTotal;
    const pageCount = options.pageCount;
    const limit = options.limit;
    const softPageCap = Math.ceil(Math.max(0, reportedTotal) / limit) + 2;
    const maxPages = Number.isInteger(options.maxPages) ? options.maxPages : MAX_PAGINATION_PAGES;
    const pageCap = Math.min(MAX_PAGINATION_PAGES, maxPages, softPageCap);

    if (rawItemCount === 0) {
      return { stop: true, partial: loadedCount < reportedTotal, reason: 'empty-page' };
    }
    if (newItemCount === 0) {
      return { stop: true, partial: true, reason: 'no-new-items' };
    }
    if (!options.hasForwardProgress) {
      return { stop: true, partial: true, reason: 'no-forward-progress' };
    }
    if (loadedCount >= reportedTotal) {
      return { stop: true, partial: false, reason: 'complete' };
    }
    if (pageCount >= pageCap) {
      return { stop: true, partial: true, reason: 'page-cap' };
    }
    return { stop: false, partial: false, reason: null };
  }

  function appendNewTransportItems(rawItems, seenIds, transportItems) {
    let newItemCount = 0;
    for (const item of rawItems) {
      const transportItem = toEuropeTransportItem(item);
      if (!transportItem || seenIds.has(transportItem.id)) continue;
      seenIds.add(transportItem.id);
      transportItems.push(transportItem);
      newItemCount++;
    }
    return newItemCount;
  }

  async function fetchWishlistData(options) {
    const config = await getGraphqlConfig();
    const requestOptions = options || {};
    const transportItems = [];
    const seenIds = new Set();
    const limit = Number.isInteger(requestOptions.limit) ? requestOptions.limit : MAX_PAGINATION_LIMIT;
    const maxPages = Number.isInteger(requestOptions.maxPages)
      ? requestOptions.maxPages
      : MAX_PAGINATION_PAGES;
    const country = typeof requestOptions.country === 'string'
      ? requestOptions.country
      : config.locale.country;
    let offset = 0;
    let reportedTotal = 0;
    let pageCount = 0;
    let partial = false;
    let previousPageOffset = null;

    while (pageCount < maxPages) {
      const data = await fetchAuthenticatedGraphql(WISHLIST_QUERY, {
        shopId: config.shopId,
        country,
        language: config.locale.language,
        offset,
        limit,
      });
      const page = data && data.account && data.account.wishlist && data.account.wishlist.wishlistItems;
      if (!page) throw new Error('Unexpected wishlist GraphQL response');

      const rawItems = Array.isArray(page.items) ? page.items : [];
      const pageOffset = page.offsetInfo && Number.isFinite(page.offsetInfo.offset)
        ? page.offsetInfo.offset
        : offset;
      const hasForwardProgress = previousPageOffset == null || pageOffset > previousPageOffset;
      previousPageOffset = pageOffset;
      pageCount++;

      const newItemCount = appendNewTransportItems(rawItems, seenIds, transportItems);

      reportedTotal = page.offsetInfo && Number.isFinite(page.offsetInfo.total)
        ? page.offsetInfo.total
        : transportItems.length;
      const nextOffset = offset + limit;
      const progress = getPaginationProgress({
        rawItemCount: rawItems.length,
        newItemCount,
        hasForwardProgress,
        loadedCount: transportItems.length,
        reportedTotal,
        pageCount,
        limit,
        maxPages,
      });
      if (progress.stop) {
        partial = progress.partial;
        break;
      }

      offset = nextOffset;
    }

    if (transportItems.length === 0 && reportedTotal > 0) {
      throw new Error(`Wishlist load returned 0 of ${reportedTotal} reported items`);
    }

    return {
      version: 2,
      items: transportItems,
      total: reportedTotal,
      partial,
      context: {
        country,
        language: config.locale.language,
      },
    };
  }

  async function fetchResolverCountries(payload) {
    const request = validateResolverRequest(payload);
    const results = [];
    for (const country of request.countries) {
      try {
        results.push({
          country,
          ok: true,
          data: await fetchWishlistData({
            country,
            limit: request.limit,
            maxPages: request.maxPages,
          }),
        });
      } catch (_err) {
        results.push({ country, ok: false });
      }
    }
    return { version: 1, results };
  }

  const handlers = {
    getWishlistData: async function () {
      return fetchWishlistData();
    },

    resolveWishlistCountries: async function (payload) {
      return fetchResolverCountries(payload);
    },

    deleteWishlistItem: async function (payload) {
      const id = requireItemId(payload && payload.id);
      const config = await getGraphqlConfig();
      await fetchAuthenticatedGraphql(DELETE_WISHLIST_MUTATION, {
        shopId: config.shopId,
        country: config.locale.country,
        language: config.locale.language,
        nsUid: toNsUidInput(id),
      });
      return { ok: true };
    },

    ping: async function () {
      return { ok: true };
    },
  };

  if (globalThis.__NWM_TEST__) {
    globalThis.NWMBridgeTest = Object.freeze({
      isValidGraphqlUrl,
      parseJwtExp,
      shouldRefreshIdToken,
      getPaginationProgress,
      toEuropeTransportItem,
      appendNewTransportItems,
      isAuthRejectedGraphqlErrors,
      createGraphqlResponseError,
      getIdToken,
      invalidateIdTokenCache,
      withIdTokenRetry,
      validateResolverRequest,
      fetchResolverCountries,
    });
  }

  // Accepted risk: this DOM event channel is observable and forgeable by page
  // scripts. The residual risk is integrity (for example, a forged success
  // response desynchronizing extension state). GraphQL URL validation bounds
  // the destinations that can receive the page's idToken.
  document.addEventListener(REQUEST_EVENT, async function (event) {
    const request = parseDetail(event.detail);
    if (!request || typeof request.requestId !== 'string' || typeof request.action !== 'string') {
      return;
    }

    const handler = handlers[request.action];
    if (!handler) {
      emitResponse(request.requestId, false, `Unsupported bridge action: ${request.action}`);
      return;
    }

    try {
      const data = await handler(request.payload || {});
      emitResponse(request.requestId, true, data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emitResponse(request.requestId, false, message);
    }
  });
})();
