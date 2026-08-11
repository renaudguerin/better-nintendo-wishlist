/** Better Wishlist for Nintendo eShop — Options */
(function () {
  'use strict';

  const settings = globalThis.NWMSettings;
  if (!settings) return;

  const crossRegion = document.getElementById('show-cross-region');
  const saleUrgency = document.getElementById('sale-urgency-days');
  const theme = document.getElementById('theme');
  const status = document.getElementById('save-status');
  const version = document.getElementById('extension-version');
  let committedSettings = null;

  function render(value) {
    const repaired = settings.repair(value);
    committedSettings = repaired;
    crossRegion.checked = repaired.showCrossRegion;
    saleUrgency.value = String(repaired.saleUrgencyDays);
    theme.value = repaired.theme;
    document.documentElement.dataset.theme = repaired.theme;
  }

  async function save(patch) {
    status.textContent = '';
    try {
      const committed = settings.repair(await settings.update(patch));
      render(committed);
      const saved = Object.entries(patch).every(([field, requested]) =>
        committed[field] === requested);
      status.textContent = saved
        ? 'Saved'
        : 'Could not save. Your previous setting is still in use.';
    } catch (_err) {
      if (committedSettings) render(committedSettings);
      status.textContent = 'Could not save. Your previous setting is still in use.';
    }
  }

  for (let days = 1; days <= 30; days++) {
    const option = document.createElement('option');
    option.value = String(days);
    option.textContent = `${days} ${days === 1 ? 'day' : 'days'}`;
    saleUrgency.appendChild(option);
  }

  crossRegion.addEventListener('change', () => {
    save({ showCrossRegion: crossRegion.checked });
  });
  saleUrgency.addEventListener('change', () => {
    save({ saleUrgencyDays: Number(saleUrgency.value) });
  });
  theme.addEventListener('change', () => {
    save({ theme: theme.value });
  });

  settings.subscribe(render);
  settings.load().then(render);

  try {
    const manifest = globalThis.chrome && globalThis.chrome.runtime &&
      globalThis.chrome.runtime.getManifest();
    if (manifest && typeof manifest.version === 'string') version.textContent = manifest.version;
  } catch (_err) { /* unavailable extension context */ }
})();
