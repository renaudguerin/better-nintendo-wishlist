# Better Wishlist for Nintendo eShop

The wishlist tools you wish the eShop had! Search, filter, and sort your games, catch
sales before they end, and unclutter in a couple of clicks, right on Nintendo's own
wishlist pages.

**[Install free from the Chrome Web Store](https://chrome.google.com/webstore/detail/jlibjocfcijoaflpjmaibdehimjadpeg)**

## What it does

Nintendo gives you one long list and no way through it. Once you've saved a few dozen
games, finding anything means scrolling and squinting, and good luck spotting a sale
before the price goes back up. This extension tidies that same page into something you
can actually use:

- **Search** game titles as you type
- **Filter** by current sale, platform (Switch / Switch 2), or content type (games, DLC,
  bundles like Deluxe editions)
- **Sort** by price, discount, release date, date added, or sales ending soonest. Sale
  Ending Soon is the default, remembered separately for each store
- **Spot sales about to end**, within a window you choose
- **Unclutter in two clicks**: remove one game or several at once, always with a
  confirmation first
- **Read comfortably** with light, dark, or system theme, on a layout that adapts to your
  screen
- **Check reviews first** with a one-click search for any game, plus a safe link to its
  store page

Changed your Nintendo account region at some point? On European wishlists there's also an
optional view for items unavailable in your region. Foreign items are clearly labelled and
never show a price or a store link that wouldn't apply to you.

## Where it works

| Store | Address | Support |
|---|---|---|
| Europe / UK | `ec.nintendo.com/my/wishlist` | Full, including removal |
| United States | `nintendo.com/us/wish-list` | Full, including removal |

Other regions aren't supported yet — they might work, but they're untested.

## Privacy

**[Read the full privacy policy](https://renaudguerin.github.io/better-nintendo-wishlist/privacy.html)**

The extension reads your wishlist through the Nintendo sign-in already open in the page,
exactly like the eShop's original wishlist. None of your data goes to the developer or any
third party. Your settings stay in your browser — the `storage` permission remembers them —
and site access is limited to the two addresses above. Google Search opens only when you
click "Search reviews".

## Running it from source

The `extension/` directory is the complete, loadable extension.

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `extension/` directory
4. Open your Nintendo wishlist

## Support and bug reports

Please [open an issue](https://github.com/renaudguerin/better-nintendo-wishlist/issues).
It is the fastest way to reach me, and other people with the same problem can find the
answer too.

When reporting a bug, include your region (Europe or US), roughly how many items are on
your wishlist, and what you expected to happen.

## About this repository

This repository holds the released extension source and the privacy policy. Development
history, design documents, and tests live in a separate private repository for now.

All features are free. If you'd like to support development,
[☕️ Buy me a coffee.](https://ko-fi.com/renaudguerin)

## Disclaimer

This is an independent project. It is not affiliated with, endorsed by, or sponsored by
Nintendo. Nintendo, Nintendo Switch, and Nintendo eShop are trademarks of Nintendo.

The extension does not modify your wishlist unless you ask it to, and every removal
requires confirmation. It works with your real Nintendo account, so use it with the same
care you would use on the Nintendo site itself.
