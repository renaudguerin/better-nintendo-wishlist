/**
 * Better Wishlist for Nintendo eShop — Adapter Registry and Canonical Contracts
 */
(function () {
  'use strict';

  const VALID_CONTENT_TYPES = new Set(['title', 'aoc', 'bundle', 'unknown']);
  const VALID_SALES_STATUSES = new Set(['preorder', 'unreleased']);
  const VALID_AVAILABILITY = new Set(['available', 'unavailable']);
  const VALID_CATALOG_RELATIONS = new Set(['current', 'foreign', 'unresolved']);
  const VALID_RESOLUTION_STATUSES = new Set([
    'not-requested',
    'resolved',
    'complete-unresolved',
    'partial',
  ]);
  const VALID_SORTS = new Set([
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
  const registry = new Map();

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function assertObject(value, name) {
    if (!isObject(value)) throw new TypeError(`${name} must be an object`);
  }

  function assertString(value, name, nullable) {
    if (nullable && value === null) return;
    if (typeof value !== 'string') throw new TypeError(`${name} must be ${nullable ? 'a string or null' : 'a string'}`);
  }

  function assertBoolean(value, name) {
    if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  }

  function assertFunction(value, name) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }

  function assertDate(value, name) {
    assertString(value, name, true);
    if (value !== null && !Number.isFinite(new Date(value).getTime())) {
      throw new TypeError(`${name} must be an ISO date string or null`);
    }
  }

  function assertCountryCode(value, name, nullable) {
    assertString(value, name, nullable);
    if (value !== null && !/^[A-Z]{2}$/.test(value)) {
      throw new TypeError(`${name} must be a two-letter uppercase country code${nullable ? ' or null' : ''}`);
    }
  }

  function validateMoney(value, name) {
    assertObject(value, name);
    if (value.value !== null && !Number.isFinite(value.value)) {
      throw new TypeError(`${name}.value must be a finite number or null`);
    }
    assertString(value.formatted, `${name}.formatted`, true);
    assertString(value.currency, `${name}.currency`, true);
  }

  function validateItem(item, index) {
    const name = `Snapshot item at index ${index}`;
    assertObject(item, name);
    assertString(item.id, `${name}.id`);
    if (!item.id) throw new TypeError(`${name}.id must not be empty`);
    assertString(item.name, `${name}.name`);
    assertString(item.productUrl, `${name}.productUrl`, true);
    assertString(item.imageUrl, `${name}.imageUrl`, true);
    assertString(item.platformCode, `${name}.platformCode`, true);
    assertString(item.platformLabel, `${name}.platformLabel`, true);
    if (!VALID_CONTENT_TYPES.has(item.contentType)) {
      throw new TypeError(`${name}.contentType must be one of: ${Array.from(VALID_CONTENT_TYPES).join(', ')}`);
    }
    assertObject(item.pricing, `${name}.pricing`);
    if (item.pricing.regular !== null) validateMoney(item.pricing.regular, `${name}.pricing.regular`);
    if (item.pricing.sale !== null) validateMoney(item.pricing.sale, `${name}.pricing.sale`);
    assertDate(item.pricing.saleEndAt, `${name}.pricing.saleEndAt`);
    assertDate(item.releaseDate, `${name}.releaseDate`);
    assertDate(item.addedAt, `${name}.addedAt`);
    if (item.salesStatus !== null && !VALID_SALES_STATUSES.has(item.salesStatus)) {
      throw new TypeError(`${name}.salesStatus must be preorder, unreleased, or null`);
    }
    assertBoolean(item.owned, `${name}.owned`);
    assertBoolean(item.isNew, `${name}.isNew`);
    assertBoolean(item.isSpecialTrial, `${name}.isSpecialTrial`);
    if (!VALID_AVAILABILITY.has(item.availability)) {
      throw new TypeError(`${name}.availability must be available or unavailable`);
    }
    assertBoolean(item.canDelete, `${name}.canDelete`);

    const hasResolutionMetadata = item.catalogRegion !== undefined ||
      item.catalogRelation !== undefined || item.resolutionStatus !== undefined;
    if (hasResolutionMetadata) {
      assertCountryCode(item.catalogRegion, `${name}.catalogRegion`, true);
      if (!VALID_CATALOG_RELATIONS.has(item.catalogRelation)) {
        throw new TypeError(`${name}.catalogRelation must be current, foreign, or unresolved`);
      }
      if (!VALID_RESOLUTION_STATUSES.has(item.resolutionStatus)) {
        throw new TypeError(`${name}.resolutionStatus must be not-requested, resolved, complete-unresolved, or partial`);
      }
      if (item.catalogRelation === 'unresolved' && item.catalogRegion !== null) {
        throw new TypeError(`${name}.catalogRegion must be null for an unresolved catalog relation`);
      }
      if (item.catalogRelation !== 'unresolved' && item.catalogRegion === null) {
        throw new TypeError(`${name}.catalogRegion must identify a resolved catalog relation`);
      }
      if ((item.catalogRelation === 'current' || item.catalogRelation === 'foreign') &&
          item.resolutionStatus !== 'resolved') {
        throw new TypeError(`${name}.resolutionStatus must be resolved for a resolved catalog relation`);
      }
      if (item.catalogRelation === 'unresolved' && item.resolutionStatus === 'resolved') {
        throw new TypeError(`${name}.resolutionStatus must not be resolved for an unresolved catalog relation`);
      }
      if (item.catalogRelation === 'current' && item.availability !== 'available') {
        throw new TypeError(`${name}.availability must be available for a current catalog item`);
      }
      if (item.catalogRelation !== 'current' && item.availability !== 'unavailable') {
        throw new TypeError(`${name}.availability must be unavailable for a foreign or unresolved catalog item`);
      }
      if ((item.catalogRelation === 'foreign' || item.resolutionStatus === 'partial') && item.canDelete) {
        throw new TypeError(`${name}.canDelete must be false for foreign or partial-resolution items`);
      }
      if (item.catalogRelation === 'foreign' && item.productUrl !== null) {
        throw new TypeError(`${name}.productUrl must be null for a foreign catalog item`);
      }
      if (item.catalogRelation === 'foreign' &&
          (item.pricing.regular !== null || item.pricing.sale !== null || item.pricing.saleEndAt !== null)) {
        throw new TypeError(`${name}.pricing must not expose foreign catalog pricing`);
      }
    }
  }

  function validateCountryList(value, name) {
    if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
    const seen = new Set();
    for (const [index, country] of value.entries()) {
      assertCountryCode(country, `${name}[${index}]`);
      if (seen.has(country)) throw new TypeError(`${name} contains duplicate country: ${country}`);
      seen.add(country);
    }
    return seen;
  }

  function normalizeCapabilities(value) {
    assertObject(value, 'Capabilities');
    assertObject(value.filters, 'Capabilities.filters');
    for (const key of ['search', 'onSale', 'platform', 'contentType']) {
      assertBoolean(value.filters[key], `Capabilities.filters.${key}`);
    }

    if (!Array.isArray(value.sorts)) throw new TypeError('Capabilities.sorts must be an array');
    const sorts = [];
    const seenSorts = new Set();
    for (const sort of value.sorts) {
      if (!VALID_SORTS.has(sort)) throw new TypeError(`Capabilities.sorts contains unknown value: ${String(sort)}`);
      if (seenSorts.has(sort)) throw new TypeError(`Capabilities.sorts contains duplicate value: ${sort}`);
      seenSorts.add(sort);
      sorts.push(sort);
    }

    assertObject(value.actions, 'Capabilities.actions');
    for (const key of ['select', 'delete', 'bulkDelete', 'reviews']) {
      assertBoolean(value.actions[key], `Capabilities.actions.${key}`);
    }
    if (value.actions.bulkDelete && (!value.actions.delete || !value.actions.select)) {
      throw new TypeError('Capabilities.actions.bulkDelete requires delete and select actions');
    }

    const crossRegionResolution = value.crossRegionResolution === undefined
      ? false
      : value.crossRegionResolution;
    assertBoolean(crossRegionResolution, 'Capabilities.crossRegionResolution');

    if (!Array.isArray(value.platforms)) throw new TypeError('Capabilities.platforms must be an array');
    const platforms = [];
    const platformCodes = new Set();
    for (const [index, platform] of value.platforms.entries()) {
      const name = `Capabilities.platforms[${index}]`;
      assertObject(platform, name);
      assertString(platform.code, `${name}.code`);
      assertString(platform.label, `${name}.label`);
      if (!platform.code) throw new TypeError(`${name}.code must not be empty`);
      if (!platform.label) throw new TypeError(`${name}.label must not be empty`);
      if (platformCodes.has(platform.code)) throw new TypeError(`Capabilities.platforms contains duplicate code: ${platform.code}`);
      platformCodes.add(platform.code);
      platforms.push({ code: platform.code, label: platform.label });
    }
    if (platforms.length > 0 && !value.filters.platform) {
      throw new TypeError('Capabilities.platforms requires the platform filter');
    }

    return {
      filters: {
        search: value.filters.search,
        onSale: value.filters.onSale,
        platform: value.filters.platform,
        contentType: value.filters.contentType,
      },
      sorts,
      actions: {
        select: value.actions.select,
        delete: value.actions.delete,
        bulkDelete: value.actions.bulkDelete,
        reviews: value.actions.reviews,
      },
      crossRegionResolution,
      platforms,
    };
  }

  function validateSnapshot(value) {
    assertObject(value, 'Adapter snapshot');
    assertString(value.adapterId, 'Adapter snapshot.adapterId');
    if (!value.adapterId) throw new TypeError('Adapter snapshot.adapterId must not be empty');
    if (!Array.isArray(value.items)) throw new TypeError('Adapter snapshot.items must be an array');
    if (!Number.isFinite(value.total) || value.total < 0) {
      throw new TypeError('Adapter snapshot.total must be a non-negative finite number');
    }
    assertBoolean(value.partial, 'Adapter snapshot.partial');
    assertObject(value.context, 'Adapter snapshot.context');
    if (value.context.country !== undefined) assertCountryCode(value.context.country, 'Adapter snapshot.context.country');
    if (value.context.language !== undefined) assertString(value.context.language, 'Adapter snapshot.context.language');
    const hasCountryResolutionContext = value.context.completedCountries !== undefined ||
      value.context.failedCountries !== undefined;
    let completedCountries = null;
    let failedCountries = null;
    if (hasCountryResolutionContext) {
      completedCountries = validateCountryList(
        value.context.completedCountries,
        'Adapter snapshot.context.completedCountries',
      );
      failedCountries = validateCountryList(
        value.context.failedCountries,
        'Adapter snapshot.context.failedCountries',
      );
      for (const country of failedCountries) {
        if (completedCountries.has(country)) {
          throw new TypeError(`Adapter snapshot.context country cannot be both completed and failed: ${country}`);
        }
      }
    }

    const ids = new Set();
    for (const [index, item] of value.items.entries()) {
      validateItem(item, index);
      if (ids.has(item.id)) throw new TypeError(`Adapter snapshot.items contains duplicate id: ${item.id}`);
      const hasResolutionMetadata = item.catalogRegion !== undefined ||
        item.catalogRelation !== undefined || item.resolutionStatus !== undefined;
      if (hasResolutionMetadata && !hasCountryResolutionContext) {
        throw new TypeError('Adapter snapshot region metadata requires completedCountries and failedCountries context');
      }
      if (item.catalogRelation === 'current' && value.context.country !== undefined &&
          item.catalogRegion !== value.context.country) {
        throw new TypeError(`Snapshot item at index ${index}.catalogRegion must match the current snapshot country`);
      }
      if (item.catalogRelation === 'foreign' && value.context.country !== undefined &&
          item.catalogRegion === value.context.country) {
        throw new TypeError(`Snapshot item at index ${index}.catalogRegion must differ from the current snapshot country`);
      }
      if (item.catalogRelation === 'foreign' &&
          !completedCountries.has(item.catalogRegion) && !failedCountries.has(item.catalogRegion)) {
        throw new TypeError(`Snapshot item at index ${index}.catalogRegion must be recorded as checked`);
      }
      if (item.resolutionStatus === 'complete-unresolved' && failedCountries.size > 0) {
        throw new TypeError(`Snapshot item at index ${index}.resolutionStatus cannot be complete-unresolved when a country failed`);
      }
      if (item.resolutionStatus === 'partial' && failedCountries.size === 0) {
        throw new TypeError(`Snapshot item at index ${index}.resolutionStatus requires a failed country`);
      }
      if (item.resolutionStatus === 'not-requested') {
        const foreignChecked = [...completedCountries, ...failedCountries]
          .some((country) => country !== value.context.country);
        if (foreignChecked) {
          throw new TypeError(`Snapshot item at index ${index}.resolutionStatus not-requested cannot include foreign checks`);
        }
      }
      ids.add(item.id);
    }
    return value;
  }

  function validateAdapter(adapter) {
    assertObject(adapter, 'Adapter');
    assertString(adapter.id, 'Adapter.id');
    if (!adapter.id) throw new TypeError('Adapter.id must not be empty');
    assertFunction(adapter.matches, `Adapter "${adapter.id}".matches`);
    assertFunction(adapter.getCapabilities, `Adapter "${adapter.id}".getCapabilities`);
    assertFunction(adapter.getNativePolicy, `Adapter "${adapter.id}".getNativePolicy`);
    assertFunction(adapter.bootstrap, `Adapter "${adapter.id}".bootstrap`);
    assertFunction(adapter.loadItems, `Adapter "${adapter.id}".loadItems`);
    assertFunction(adapter.deleteItem, `Adapter "${adapter.id}".deleteItem`);
    normalizeCapabilities(adapter.getCapabilities());
  }

  function register(adapter) {
    validateAdapter(adapter);
    if (registry.has(adapter.id)) throw new Error(`Adapter ID is already registered: ${adapter.id}`);
    registry.set(adapter.id, adapter);
    return adapter;
  }

  function find(locationLike) {
    for (const adapter of registry.values()) {
      if (adapter.matches(locationLike)) return adapter;
    }
    return null;
  }

  function get(id) {
    return registry.get(id) || null;
  }

  globalThis.NWMAdapters = Object.freeze({
    register,
    find,
    get,
    normalizeCapabilities,
    validateSnapshot,
  });
})();
