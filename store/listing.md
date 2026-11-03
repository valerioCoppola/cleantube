# Store listing — copy and paste

## Name
CleanTube — YourHome

## Short description (Chrome: max 132 characters; also used as the Firefox summary)
A calm YouTube home with only the channels you follow. No algorithm, no Shorts, no tracking.

## Category
Chrome: Productivity (or "Social & Communication")
Firefox: Social & Communication / Photos, Music & Videos
Edge: Productivity

## Detailed description

YourHome is a quiet home page for YouTube that shows only the videos from the channels you chose. Nothing else.

No algorithm. No recommendations. No Shorts. No infinite scroll.

• Your channels, newest first, grouped as Today, Yesterday, This week…
• A clear end: "You're all caught up."
• Busy channels don't flood the page. Extra uploads fold into one "+N more" tile that you can open in place.
• Groups you define (News, Music, Learning…) as tabs.
• Hide a channel from Home without unfollowing it.
• "New since your last visit" markers, watched videos fade or hide.
• Search across your channels with the "/" key.
• Optional: open YourHome instead of the YouTube home page, and hide the recommendations next to videos.
• Light and dark themes.

Setting up takes one click: import your subscriptions from YouTube using the sign-in you already have. You can also import a Google Takeout, OPML, NewPipe or FreeTube file, or paste a channel link.

Private by design: no account, no server, no analytics. Everything stays in your browser. Videos come from YouTube's public feeds.

Free and open source (MIT): https://github.com/valerioCoppola/cleantube

Not affiliated with YouTube or Google.

## Chrome Web Store — Privacy practices tab

**Single purpose:**
Show the latest videos from the YouTube channels the user follows, in a chronological, algorithm-free page.

**Permission justifications:**
- `storage`: saves the user's channel list, groups, settings and watched videos locally.
- `unlimitedStorage`: users with hundreds of channels cache thousands of video entries; this avoids hitting the default quota.
- Host permission `https://www.youtube.com/*`: reads the public RSS feeds of followed channels, resolves channel links the user pastes, and (only when the user clicks "Import from YouTube") reads their subscription list. The content script on youtube.com also applies two optional settings: redirecting the home page to YourHome and hiding recommendations.

**Remote code:** No, I am not using remote code. All JavaScript is packaged in the extension.

**Data usage:** tick none of the data types. The extension does not collect or transmit user data.
Certify all three statements (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** https://github.com/valerioCoppola/cleantube/blob/main/PRIVACY.md

## Firefox (AMO) notes
- Source code: not required (no build step, no minification). Answer "No" to "Do you need to submit source code?".
- License: MIT.

## Images (in this folder)
- `screenshot-1-feed.png`, `screenshot-2-dark.png`, `screenshot-3-groups.png`, `screenshot-4-welcome.png`: 1280×800
- `promo-small-440x280.png`: Chrome small promo tile
- Store icon: `extension/icons/icon128.png`
