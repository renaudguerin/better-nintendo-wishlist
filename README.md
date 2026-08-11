# Better Wishlist for Nintendo eShop

A Chrome extension that makes your Nintendo eShop wishlist usable — search, filters,
sorting, sale timing, and easier removal, added directly to Nintendo's own wishlist page.

> **Status:** preparing for the Chrome Web Store. This page will link to the listing once it
> is published.

## What it does

Nintendo's wishlist page gives you one long list and no way through it. Once you've saved a
few dozen games, finding anything — or noticing that something you wanted is on sale and
about to go back up — means scrolling and squinting.

This extension adds a management view to that page:

- **Search** by game title
- **Filter** by sale, platform (Switch / Switch 2), or content type (games, DLC, bundles)
- **Sort** by name, price, discount, release date, date added, or sale ending soonest —
  Sale Ending Soon is the default, and your choice is remembered per store
- **Spot sales about to end**, with a window you configure
- **Remove** one game or several at once, always after an explicit confirmation
- **Light, dark, or system theme**
- **Quick links** to each game's store page and to a review search

On European wishlists there is also an optional view for items unavailable in your region.
Foreign items are clearly labelled and never show a price or a store link that wouldn't
apply to you.

## Supported stores

| Store | Address | Support |
|---|---|---|
| Europe | `ec.nintendo.com/my/wishlist` | Full, including removal |
| United States | `nintendo.com/us/wish-list` | Full, including removal |

Other regions are not supported yet.

## Privacy

**[Read the full privacy policy](https://renaudguerin.github.io/better-nintendo-wishlist/privacy.html)**

The short version: no analytics, no telemetry, no advertising, no background process, no
remote code, and no server operated by the developer. Your settings stay in your browser.
The extension talks to Nintendo to show and manage your wishlist, and to nothing else
unless you click a link.

It requests a single permission, `storage`, and runs only on the two Nintendo wishlist
addresses above.

## Running it from source

The `extension/` directory is the complete, loadable extension.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` directory
4. Open your Nintendo wishlist

## Support and bug reports

Please [open an issue](https://github.com/renaudguerin/better-nintendo-wishlist/issues) —
it's the fastest way to reach me, and it means other people with the same problem can find
the answer.

When reporting a bug, include your region (Europe or US), roughly how many items are on
your wishlist, and what you expected to happen.

## About this repository

This repository holds the released extension source and the privacy policy. Development
history, design documents, and tests live in a separate private repository for now.

Every feature is free. There is no paid tier, no donation link, and no payment destination
of any kind in this release.

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by, or sponsored by
Nintendo. Nintendo, Nintendo Switch, and Nintendo eShop are trademarks of Nintendo.

The extension does not modify your wishlist unless you ask it to, and every removal
requires a confirmation. That said, it works with your real Nintendo account — use it with
the same care you'd use on the Nintendo site itself.
