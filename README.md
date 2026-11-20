# Better Wishlist for Nintendo eShop

The wishlist tools you wish the eShop had! Search, filter, and sort your wishlisted games, catch
sales before they end, and unclutter in a couple of clicks, right on Nintendo's own
wishlist page.

**[Install free from the Chrome Web Store](https://chrome.google.com/webstore/detail/jlibjocfcijoaflpjmaibdehimjadpeg)**

[![Get the add-on for Firefox](firefox-add-on-badge.png)](https://addons.mozilla.org/en-US/firefox/addon/better-wishlist-nintendo-eshop/)

Also available free on [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/better-wishlist-nintendo-eshop/) for desktop Firefox **140 or later**.

[☕️ Buy me a coffee.](https://ko-fi.com/renaudguerin)

## What it does

Nintendo gives you one long list and no way through it. Once you've saved a few dozen
games, finding anything means scrolling and squinting, and no way to prioritize sales ending soon. This extension tidies that same page into something much more convenient :

- **Search** game titles as you type
- **Filter** by current sale, free demo availability, platform (Switch / Switch 2), or
  content type (games, DLC, and bundles like Deluxe editions)
- **Spot free demos** on games that the current storefront lists with a demo. Combine
  Free Demo and On Sale to find discounted games you can try first
- **Sort** by price, discount, release date, date added, or sales ending soonest. Sale
  Ending Soon is the default, remembered separately for each store
- **Spot sales about to end**, within a window you choose
- **Unclutter in two clicks**: remove one game or several at once, always with a
  confirmation first
- **Read comfortably** with light, dark, or system theme, on a layout that adapts to your
  screen
- **Check reviews first** with a one-click search for any game, plus a safe link to its
  store page

Changed your Nintendo account region at some point? On the European wishlist page there's also an
optional view for items unavailable in your region. Foreign items are clearly labelled and
never show a price or a store link that wouldn't apply to you.

## Where it works

| Store | Address | Support |
|---|---|---|
| Europe / UK | `ec.nintendo.com/my/wishlist` | Full, including removal |
| United States | `nintendo.com/us/wish-list` | Full, including removal |
| Other Americas storefronts | `nintendo.com/ll-cc/wish-list`, such as `es-mx`, `fr-ca`, or `pt-br` | Same features where Nintendo uses the supported storefront |

Mexico, French Canada, and Brazil were checked with a US account; local-account pricing and
live removal have not been verified for every storefront. Other language/country routes
are best effort and may need changes if Nintendo uses a different page or API.

## Privacy

**[Read the full privacy policy](https://renaudguerin.github.io/better-nintendo-wishlist/privacy.html)**

The extension reads your wishlist through the Nintendo sign-in already open in the page.
Wishlist requests go to Nintendo, not the developer. Your settings stay in your browser;
the `storage` permission remembers extension settings. Google Search opens with the game
title and, when known, platform only when you click "Search reviews".

## Running it from source in Chrome

The `extension/` directory is the complete, loadable extension.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` directory
4. Open your Nintendo wishlist

## Support, bug reports and suggestions

Please [open an issue](https://github.com/renaudguerin/better-nintendo-wishlist/issues).
It is the fastest way to reach me, and other people with the same problem can find the
answer too.

When reporting a bug, include your storefront and country, roughly how many items are on
your wishlist, and what you expected to happen.

## About this repository

This generated repository holds the extension distribution files and the public site.

If you'd like to support development, [☕️ Buy me a coffee.](https://ko-fi.com/renaudguerin)

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by, or sponsored by
Nintendo. Nintendo, Nintendo Switch, and Nintendo eShop are trademarks of Nintendo.

The extension does not modify your wishlist unless you ask it to, and every removal
requires confirmation. It works with your real Nintendo account, so use it with the same
care you would use on the Nintendo site itself.
