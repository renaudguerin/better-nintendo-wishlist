/**
 * Better Wishlist for Nintendo eShop — Americas Adapter
 * The stable `us` adapter ID serves Nintendo's shared Americas storefront.
 */
(function () {
  'use strict';

  const NWMAdapters = globalThis.NWMAdapters;
  const GRAPHQL_URL = 'https://graph.nintendo.com/';
  const OAUTH_STORAGE_KEY = 'nintendo.oauth.session';
  const CUSTOMER_STORAGE_KEY = 'nintendo.customer.session';
  const REQUEST_TIMEOUT_MS = 15000;
  const MAX_ATTEMPTS = 3;
  const RETRY_BASE_MS = 200;
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 100;
  const ROOT_SELECTOR = 'main#main';
  const OPTIONS_SELECTOR = '[class*="LoggedInWishlist3_optionsContainer__"]';
  const LIST_SELECTOR = `${OPTIONS_SELECTOR} + ul`;
  const LOADER_SELECTOR = `${OPTIONS_SELECTOR} + ul + span`;
  const ITEM_SELECTOR = `${OPTIONS_SELECTOR} + ul > li`;
  const HIDDEN_SELECTORS = Object.freeze([OPTIONS_SELECTOR, LIST_SELECTOR, LOADER_SELECTOR]);
  const SORTS = Object.freeze([
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
  const WISHLIST_QUERY = `query Wishlist($categories: [WishListCategory!]!, $page: Int!, $pageSize: Int!,
               $includeProductInfo: Boolean!, $personalized: Boolean) {
  customer {
    wishList(categories: $categories, page: $page, pageSize: $pageSize) {
      items {
        id category createdAt
        product @include(if: $includeProductInfo) {
          name nsuid sku urlKey availability demoNsuid
          platform { code label }
          topLevelCategory { code label }
          dlcType { code label }
          prices(personalized: $personalized) {
            currency discounted regularPrice finalPrice pricePerUnit
          }
          eshopDetails(personalized: $personalized) {
            isPurchased isPurchasable isPreordered isPreorderable
            purchaseUrl discountPriceEnd
          }
          releaseDate releaseDateDisplay exclusive isSalableQty isUpgrade
          productImage { publicId resourceType type }
        }
      }
      hasNextPage
    }
  }
}`;
  const REMOVE_WISHLIST_ITEM_MUTATION = `mutation RemoveWishListItem($item: WishListItemInput!, $locale: Locale) {
  item: removeWishListItem(item: $item, locale: $locale) {
    id category
  }
}`;

  // Verified URL-to-GraphQL mappings take precedence over the conventional
  // ll-cc -> ll_CC inference used for storefronts Nintendo may migrate later.
  const STOREFRONT_LOCALES = Object.freeze({
    us: 'en_US',
    'en-ca': 'en_CA',
    'fr-ca': 'fr_CA',
    'es-mx': 'es_MX',
    'pt-br': 'pt_BR',
    'es-ar': 'es_AR',
    'es-cl': 'es_CL',
    'es-co': 'es_CO',
    'es-pe': 'es_PE',
  });

  function storefrontFor(locationLike) {
    if (!locationLike || locationLike.origin !== 'https://www.nintendo.com') return null;
    const match = /^\/(us|[a-z]{2}-[a-z]{2})\/wish-list\/?$/.exec(locationLike.pathname);
    if (!match) return null;
    const pathLocale = match[1];
    const [urlLanguage, urlCountry] = pathLocale.split('-');
    const graphLocale = STOREFRONT_LOCALES[pathLocale] ||
      `${urlLanguage}_${urlCountry.toUpperCase()}`;
    const [language, country] = graphLocale.split('_');
    return { pathLocale, graphLocale, language, country, locale: `${language}-${country}` };
  }

  function matchesUs(locationLike) {
    return storefrontFor(locationLike) !== null;
  }

  if (!NWMAdapters || !matchesUs(window.location)) return;
  const storefront = storefrontFor(window.location);
  // Empty lists lack the native controls, so retain a precise heading guard in
  // each language shipped by the Americas app instead of accepting any h1.
  const wishlistHeading = {
    en: 'Wish List', es: 'Lista de deseos', fr: 'Liste des souhaits', pt: 'Lista de desejos',
  }[storefront.language];
  const comingSoonLabel = {
    en: 'Coming soon', es: 'Próximos lanzamientos', fr: 'Bientôt offert', pt: 'Em breve',
  }[storefront.language];

  class UsAdapterError extends Error {
    constructor(code, message, retryable) {
      super(message);
      this.name = 'UsAdapterError';
      this.code = code;
      this.retryable = retryable === true;
    }
  }

  function adapterError(code, message, retryable) {
    return new UsAdapterError(code, message, retryable);
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  function tokenString(value) {
    const token = nonEmptyString(value);
    return token && !/\s/.test(token) ? token : null;
  }

  function nullableDate(value) {
    const date = nonEmptyString(value);
    return date && Number.isFinite(new Date(date).getTime()) ? date : null;
  }

  function isMillisecondExpiry(value) {
    return typeof value === 'number' && Number.isInteger(value) &&
      value >= 1000000000000 && value <= 9999999999999;
  }

  function parseStorageRecord(raw, requiredTokenNames, nowMs) {
    let record;
    try {
      record = JSON.parse(raw);
    } catch (_err) {
      throw adapterError(
        'US_AUTH_INVALID',
        'Nintendo sign-in data is invalid. Reload the page or sign in again.',
      );
    }
    if (!isObject(record) || !isObject(record.value) || !isMillisecondExpiry(record.expiresAt)) {
      throw adapterError(
        'US_AUTH_INVALID',
        'Nintendo sign-in data is invalid. Reload the page or sign in again.',
      );
    }
    if (record.expiresAt <= nowMs) {
      throw adapterError(
        'US_AUTH_EXPIRED',
        'Nintendo sign-in has expired. Reload the page or sign in again.',
      );
    }
    const tokens = {};
    for (const name of requiredTokenNames) {
      const token = tokenString(record.value[name]);
      if (!token) {
        throw adapterError(
          'US_AUTH_INVALID',
          'Nintendo sign-in data is invalid. Reload the page or sign in again.',
        );
      }
      tokens[name] = token;
    }
    return tokens;
  }

  function readAuth(storageLike, nowMs) {
    let oauthRaw;
    let customerRaw;
    try {
      oauthRaw = storageLike.getItem(OAUTH_STORAGE_KEY);
      customerRaw = storageLike.getItem(CUSTOMER_STORAGE_KEY);
    } catch (_err) {
      throw adapterError(
        'US_AUTH_UNAVAILABLE',
        'Nintendo sign-in data is unavailable. Reload the page or sign in again.',
      );
    }
    if (oauthRaw === null || customerRaw === null) {
      throw adapterError(
        'US_AUTH_MISSING',
        'Nintendo sign-in is required. Reload the page or sign in again.',
      );
    }
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const oauth = parseStorageRecord(oauthRaw, ['idToken'], now);
    const customer = parseStorageRecord(customerRaw, ['accessToken', 'customerToken'], now);
    return {
      idToken: oauth.idToken,
      accessToken: customer.accessToken,
      customerToken: customer.customerToken,
    };
  }

  function readPageAuth() {
    let storage;
    try {
      storage = window.localStorage;
    } catch (_err) {
      throw adapterError(
        'US_AUTH_UNAVAILABLE',
        'Nintendo sign-in data is unavailable. Reload the page or sign in again.',
      );
    }
    return readAuth(storage);
  }

  function findSection(documentLike) {
    const root = documentLike.querySelector(ROOT_SELECTOR);
    if (!root) return null;
    const options = root.querySelector(OPTIONS_SELECTOR);
    if (options) return options.parentElement;
    const heading = findWishListHeading(root);
    return heading ? root : null;
  }

  function findWishListHeading(root) {
    return root && Array.from(root.querySelectorAll('h1')).find((node) =>
      node.textContent.trim() === wishlistHeading);
  }

  function wishListHeadings(root) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('h1')).filter((heading) =>
      heading.textContent.trim() === wishlistHeading && heading.closest(ROOT_SELECTOR) === root);
  }

  function containsNativeWishlist(node) {
    return Boolean(node.querySelector(`${OPTIONS_SELECTOR}, ${LIST_SELECTOR}`));
  }

  function topLevelHeadingContainers(root) {
    if (!root) return [];
    const containers = new Set();
    for (const heading of wishListHeadings(root)) {
      let container = heading;
      while (container.parentElement && container.parentElement !== root) {
        container = container.parentElement;
      }
      if (container.parentElement === root) containers.add(container);
    }
    return [...containers];
  }

  function topLevelHeadingContainer(root) {
    return topLevelHeadingContainers(root)[0] || null;
  }

  // Hiding the native heading must never take the item list with it. Nintendo
  // has shipped a layout where the heading and the list are separate children
  // of the root, and one where a single wrapper holds both, so stop climbing as
  // soon as the next ancestor would also cover the native controls or list.
  function managedHeadingContainers(root) {
    if (!root) return [];
    const containers = new Set();
    for (const heading of wishListHeadings(root)) {
      let container = heading;
      while (container.parentElement && container.parentElement !== root &&
             !containsNativeWishlist(container.parentElement)) {
        container = container.parentElement;
      }
      if (!containsNativeWishlist(container)) containers.add(container);
    }
    return [...containers];
  }

  function getMountPoint(section) {
    const options = section && section.querySelector(OPTIONS_SELECTOR);
    if (options && options.parentElement) {
      return { parent: options.parentElement, before: options, hr: null };
    }
    const headingContainer = topLevelHeadingContainer(section);
    if (!headingContainer) {
      throw adapterError(
        'US_NATIVE_SECTION_INVALID',
        'Nintendo wishlist controls could not be found. Reload and try again.',
      );
    }
    return { parent: section, before: headingContainer.nextSibling, hr: null };
  }

  function getManagedNativeNodes(section) {
    const root = section && (section.matches(ROOT_SELECTOR)
      ? section
      : section.closest(ROOT_SELECTOR));
    return managedHeadingContainers(root);
  }

  const nativePolicy = Object.freeze({
    rootSelector: ROOT_SELECTOR,
    nativeItemSelector: ITEM_SELECTOR,
    hiddenSelectors: HIDDEN_SELECTORS,
    findSection,
    getMountPoint,
    getManagedNativeNodes,
  });

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function requestVariables(page) {
    return {
      categories: ['ESHOP_PRODUCT', 'NOA_PRODUCT'],
      page,
      pageSize: PAGE_SIZE,
      includeProductInfo: true,
      personalized: true,
    };
  }

  function requestHeaders(auth) {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${auth.idToken}`,
      'x-access-token': auth.accessToken,
      'x-customer-token': auth.customerToken,
      'x-nintendo-graph': 'true',
      locale: storefront.locale,
      'apollographql-client-name': 'ncom',
      'apollographql-client-version': '1.0.0',
    };
  }

  function validatePageBody(body) {
    if (isObject(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      throw adapterError(
        'US_GRAPHQL_ERROR',
        'Nintendo wishlist service returned an error. Reload and try again.',
      );
    }
    const customer = isObject(body) && isObject(body.data) ? body.data.customer : null;
    const wishlist = isObject(customer) ? customer.wishList : null;
    if (!isObject(wishlist) || !Array.isArray(wishlist.items) ||
        typeof wishlist.hasNextPage !== 'boolean') {
      throw adapterError(
        'US_RESPONSE_INVALID',
        'Nintendo wishlist response was not understood. Reload and try again.',
      );
    }
    return { items: wishlist.items, hasNextPage: wishlist.hasNextPage };
  }

  function requestFailureMessage(isMutation, fallback) {
    return isMutation
      ? 'Nintendo may have processed the removal. Reload and check your wishlist before retrying.'
      : fallback;
  }

  async function fetchGraphqlAttempt(auth, payload, validateBody, isMutation = false) {
    const controller = new AbortController();
    let timeoutId;
    const deadline = new Promise((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(adapterError(
          'US_REQUEST_TIMEOUT',
          requestFailureMessage(isMutation, 'Nintendo wishlist request timed out. Try again.'),
          true,
        ));
      }, REQUEST_TIMEOUT_MS);
    });
    let response;
    try {
      try {
        response = await Promise.race([
          fetch(GRAPHQL_URL, {
            method: 'POST',
            credentials: 'omit',
            headers: requestHeaders(auth),
            body: JSON.stringify(payload),
            signal: controller.signal,
          }),
          deadline,
        ]);
      } catch (err) {
        if (err instanceof UsAdapterError) throw err;
        if (err && err.name === 'AbortError') {
          throw adapterError(
            'US_REQUEST_TIMEOUT',
            requestFailureMessage(isMutation, 'Nintendo wishlist request timed out. Try again.'),
            true,
          );
        }
        throw adapterError(
          'US_NETWORK_ERROR',
          requestFailureMessage(
            isMutation,
            'Nintendo wishlist request failed. Check your connection and try again.',
          ),
          true,
        );
      }

      if (!response || response.ok !== true) {
        const status = response && Number.isInteger(response.status) ? response.status : 0;
        if (status === 429) {
          throw adapterError(
            'US_RATE_LIMITED',
            requestFailureMessage(
              isMutation,
              'Nintendo wishlist service is temporarily busy. Try again.',
            ),
            true,
          );
        }
        if (status >= 500 && status <= 599) {
          throw adapterError(
            'US_SERVICE_UNAVAILABLE',
            requestFailureMessage(
              isMutation,
              'Nintendo wishlist service is temporarily unavailable. Try again.',
            ),
            true,
          );
        }
        if (status === 401 || status === 403) {
          throw adapterError(
            'US_AUTH_REJECTED',
            'Nintendo sign-in was rejected. Reload the page or sign in again.',
          );
        }
        throw adapterError(
          'US_REQUEST_REJECTED',
          'Nintendo wishlist request was rejected. Reload and try again.',
        );
      }

      let body;
      try {
        body = await Promise.race([response.json(), deadline]);
      } catch (err) {
        if (err instanceof UsAdapterError) throw err;
        if (err && err.name === 'AbortError') {
          throw adapterError(
            'US_REQUEST_TIMEOUT',
            requestFailureMessage(isMutation, 'Nintendo wishlist request timed out. Try again.'),
            true,
          );
        }
        throw adapterError(
          'US_RESPONSE_INVALID',
          'Nintendo wishlist response was not understood. Reload and try again.',
        );
      }
      return validateBody(body);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function fetchPageAttempt(auth, page) {
    return fetchGraphqlAttempt(auth, {
      operationName: 'Wishlist',
      query: WISHLIST_QUERY,
      variables: requestVariables(page),
    }, validatePageBody);
  }

  async function fetchWishlistPage(auth, page) {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        return await fetchPageAttempt(auth, page);
      } catch (err) {
        if (!(err instanceof UsAdapterError) || !err.retryable || attempt === MAX_ATTEMPTS - 1) {
          throw err;
        }
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
    throw adapterError('US_REQUEST_FAILED', 'Nintendo wishlist request failed. Try again.');
  }

  function providerIdentity(rawItem) {
    if (!isObject(rawItem)) {
      throw adapterError(
        'US_RESPONSE_INVALID',
        'Nintendo wishlist response was not understood. Reload and try again.',
      );
    }
    const id = nonEmptyString(rawItem.id);
    const category = nonEmptyString(rawItem.category);
    if (!id || !category || (rawItem.product !== null && !isObject(rawItem.product))) {
      throw adapterError(
        'US_RESPONSE_INVALID',
        'Nintendo wishlist response was not understood. Reload and try again.',
      );
    }
    return { id, category, key: `${category}:${id}` };
  }

  function canonicalProviderIdentity(item) {
    if (!isObject(item) || item.canDelete !== true) {
      throw adapterError('US_DELETE_INVALID', 'This wishlist item cannot be removed.');
    }
    const key = nonEmptyString(item.id);
    const separator = key ? key.indexOf(':') : -1;
    const category = separator > 0 ? key.slice(0, separator) : null;
    const id = separator > 0 ? nonEmptyString(key.slice(separator + 1)) : null;
    if (!id || !['ESHOP_PRODUCT', 'NOA_PRODUCT'].includes(category)) {
      throw adapterError('US_DELETE_INVALID', 'This wishlist item cannot be removed.');
    }
    return { id, category, key: `${category}:${id}` };
  }

  function validateRemovalBody(body, expected) {
    if (isObject(body) && Array.isArray(body.errors) && body.errors.length > 0) {
      throw adapterError(
        'US_GRAPHQL_ERROR',
        'Nintendo wishlist service returned an error. Reload and try again.',
      );
    }
    const removed = isObject(body) && isObject(body.data) ? body.data.item : null;
    if (!isObject(removed) || nonEmptyString(removed.id) !== expected.id ||
        nonEmptyString(removed.category) !== expected.category) {
      throw adapterError(
        'US_DELETE_RESPONSE_INVALID',
        'Nintendo did not confirm the wishlist removal. Reload and check your wishlist.',
      );
    }
    return { ok: true };
  }

  function removeWishlistItem(item) {
    const identity = canonicalProviderIdentity(item);
    const auth = readPageAuth();
    return fetchGraphqlAttempt(auth, {
      operationName: 'RemoveWishListItem',
      query: REMOVE_WISHLIST_ITEM_MUTATION,
      variables: {
        item: { id: identity.id, category: identity.category },
        locale: storefront.graphLocale,
      },
    }, (body) => validateRemovalBody(body, identity), true);
  }

  function validUrlKey(value) {
    const key = nonEmptyString(value);
    return key && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(key) ? key : null;
  }

  function validPublicId(value) {
    const publicId = nonEmptyString(value);
    return publicId && /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/i.test(publicId) ? publicId : null;
  }

  function mapPlatform(value) {
    if (!isObject(value)) return { code: null, label: null };
    const code = nonEmptyString(value.code);
    if (!code) return { code: null, label: null };
    if (code === 'NINTENDO_SWITCH') return { code, label: 'Nintendo Switch' };
    if (code === 'NINTENDO_SWITCH_2') return { code, label: 'Nintendo Switch 2' };
    return { code, label: nonEmptyString(value.label) };
  }

  function formatMoney(value, currency) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const code = nonEmptyString(currency);
    if (!code) return null;
    try {
      return {
        value,
        formatted: new Intl.NumberFormat(storefront.locale, { style: 'currency', currency: code }).format(value),
        currency: code,
      };
    } catch (_err) {
      return null;
    }
  }

  function mapPricing(product) {
    const prices = isObject(product.prices) ? product.prices : null;
    const details = isObject(product.eshopDetails) ? product.eshopDetails : null;
    if (!prices) return { regular: null, sale: null, saleEndAt: null };
    const regular = formatMoney(prices.regularPrice, prices.currency);
    const sale = prices.discounted === true && regular
      ? formatMoney(prices.finalPrice, prices.currency)
      : null;
    return {
      regular,
      sale,
      saleEndAt: sale && details ? nullableDate(details.discountPriceEnd) : null,
    };
  }

  function mapContentType(category, product) {
    if (category !== 'ESHOP_PRODUCT') return 'unknown';
    if (product.isUpgrade === true) return 'aoc';
    if (isObject(product.dlcType)) {
      if (product.dlcType.code === 'ROM_BUNDLE') return 'bundle';
      if (nonEmptyString(product.dlcType.code)) return 'unknown';
    }
    if (product.isUpgrade !== false) return 'unknown';
    return 'title';
  }

  // `releaseDate` is padded to a full timestamp even when Nintendo only knows
  // the year: a title announced for 2027 comes back as 2027-12-31T00:00:00.000Z
  // with releaseDateDisplay "2027". The display string is the honest value and
  // is null whenever the exact date is known, so it wins when it carries a
  // shape `NWM.formatReleaseDate` understands. Anything else falls back rather
  // than pushing an unknown vocabulary into the canonical date field.
  function displayPrecisionDate(value) {
    const display = nonEmptyString(value);
    return display && /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(display) ? display : null;
  }

  function mapReleaseDate(product) {
    return displayPrecisionDate(product.releaseDateDisplay) || nullableDate(product.releaseDate);
  }

  // Pre-orders carry both "Pre-order" and "Coming soon" in `availability`, so
  // the pre-order signal is checked first. "Coming soon" gates the unreleased
  // branch on purpose: a delisted title also reports isPurchasable false with
  // no prices, and must not be advertised as upcoming.
  function mapSalesStatus(product, details) {
    if (details && details.isPreorderable === true) return 'preorder';
    const availability = Array.isArray(product.availability) ? product.availability : [];
    if (availability.includes('Coming soon') ||
        (comingSoonLabel && availability.includes(comingSoonLabel))) return 'unreleased';
    return null;
  }

  function mapWishlistItem(rawItem) {
    const identity = providerIdentity(rawItem);
    const product = rawItem.product;
    // The Americas graph returns other-region wishlist identities with product:null.
    // They carry no safe title/image metadata and must not become anonymous
    // deletion candidates on the current regional wishlist surface.
    if (product === null) return null;

    const platform = mapPlatform(product.platform);
    const urlKey = identity.category === 'ESHOP_PRODUCT' ? validUrlKey(product.urlKey) : null;
    const image = isObject(product.productImage) ? product.productImage : null;
    const publicId = image && image.resourceType === 'image' && image.type === 'upload'
      ? validPublicId(image.publicId)
      : null;
    const details = isObject(product.eshopDetails) ? product.eshopDetails : null;
    return {
      id: identity.key,
      name: typeof product.name === 'string' ? product.name : '',
      productUrl: urlKey ? `/${storefront.pathLocale}/store/products/${urlKey}/` : null,
      imageUrl: publicId
        ? `https://assets.nintendo.com/image/upload/q_auto/f_auto/${publicId}`
        : null,
      platformCode: platform.code,
      platformLabel: platform.label,
      contentType: mapContentType(identity.category, product),
      pricing: mapPricing(product),
      releaseDate: mapReleaseDate(product),
      addedAt: nullableDate(rawItem.createdAt),
      salesStatus: mapSalesStatus(product, details),
      owned: Boolean(details && details.isPurchased === true),
      isNew: false,
      isSpecialTrial: false,
      availability: 'available',
      canDelete: true,
    };
  }

  async function loadAllPages(requestPage) {
    const uniqueItems = new Map();
    const pageSignatures = new Set();

    for (let page = 1; page <= MAX_PAGES; page++) {
      const result = await requestPage(page);
      if (!isObject(result) || !Array.isArray(result.items) || typeof result.hasNextPage !== 'boolean') {
        throw adapterError(
          'US_RESPONSE_INVALID',
          'Nintendo wishlist response was not understood. Reload and try again.',
        );
      }
      const identities = result.items.map(providerIdentity);
      if (result.items.length === 0 && (page > 1 || result.hasNextPage)) {
        throw adapterError(
          'US_PAGINATION_INVALID',
          'Nintendo wishlist pagination was incomplete. Reload and try again.',
        );
      }
      const signature = identities.map((identity) => identity.key).join('\u0000');
      if (pageSignatures.has(signature)) {
        throw adapterError(
          'US_PAGINATION_INVALID',
          'Nintendo wishlist pagination was incomplete. Reload and try again.',
        );
      }
      pageSignatures.add(signature);
      let newItemCount = 0;
      for (let index = 0; index < result.items.length; index++) {
        const identity = identities[index];
        if (uniqueItems.has(identity.key)) continue;
        uniqueItems.set(identity.key, mapWishlistItem(result.items[index]));
        newItemCount++;
      }
      if (page > 1 && newItemCount === 0) {
        throw adapterError(
          'US_PAGINATION_INVALID',
          'Nintendo wishlist pagination was incomplete. Reload and try again.',
        );
      }
      if (!result.hasNextPage) {
        const regionalItems = Array.from(uniqueItems.values()).filter(Boolean);
        const snapshot = {
          adapterId: 'us',
          items: regionalItems,
          total: regionalItems.length,
          partial: false,
          context: { country: storefront.country, language: storefront.language },
        };
        NWMAdapters.validateSnapshot(snapshot);
        return snapshot;
      }
      if (page === MAX_PAGES) {
        throw adapterError(
          'US_PAGINATION_LIMIT',
          'Nintendo wishlist pagination exceeded its safe limit. Reload and try again.',
        );
      }
    }
    throw adapterError(
      'US_PAGINATION_LIMIT',
      'Nintendo wishlist pagination exceeded its safe limit. Reload and try again.',
    );
  }

  function getCapabilities(snapshot) {
    const byCode = new Map();
    if (snapshot && Array.isArray(snapshot.items)) {
      for (const item of snapshot.items) {
        if (!item || !item.platformCode || !item.platformLabel || byCode.has(item.platformCode)) continue;
        byCode.set(item.platformCode, { code: item.platformCode, label: item.platformLabel });
      }
    }
    return {
      filters: { search: true, onSale: true, platform: true, contentType: true },
      sorts: Array.from(SORTS),
      actions: { select: true, delete: true, bulkDelete: true, reviews: true },
      crossRegionResolution: false,
      platforms: Array.from(byCode.values()).sort((left, right) => left.code.localeCompare(right.code)),
    };
  }

  const adapter = {
    id: 'us',
    matches: matchesUs,
    getCapabilities,
    getNativePolicy: () => nativePolicy,
    async bootstrap() {
      if (typeof fetch !== 'function' || typeof AbortController !== 'function') {
        throw adapterError(
          'US_FETCH_UNAVAILABLE',
          'Nintendo wishlist access is unavailable in this browser. Reload and try again.',
        );
      }
      readPageAuth();
      return { ok: true };
    },
    async loadItems() {
      const auth = readPageAuth();
      return loadAllPages((page) => fetchWishlistPage(auth, page));
    },
    async deleteItem(item) {
      return removeWishlistItem(item);
    },
  };

  NWMAdapters.register(adapter);

  if (globalThis.__NWM_TEST__) {
    globalThis.NWMUsAdapterTest = Object.freeze({
      matchesUs,
      readAuth,
      fetchWishlistPage,
      loadAllPages,
      mapWishlistItem,
      removeWishlistItem,
      canonicalProviderIdentity,
      getCapabilities,
      getNativePolicy: () => nativePolicy,
    });
  }
})();
