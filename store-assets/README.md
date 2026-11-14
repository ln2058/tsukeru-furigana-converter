# Store images

The screenshots and promo tiles for the Chrome Web Store, Edge Add-ons and Firefox Add-ons. Each image is an HTML page rendered to PNG, so it can be updated after a release or translated by editing text, without an image editor.

Audience: Japanese learners. The five screenshots tell one story: **read real Japanese → look words up → save them → review them later.**

## Layout

```
store-assets/
  slides/       one HTML page per image (01-hero … 05-save-review, promo-small, promo-marquee)
  theme.css     the shared look: colour fields, headline, logo lockup, browser frame, crops, cursor, callouts, chips
  i18n.js       fills text and swaps in per-language captures, then marks the page ready for rendering
  locales/      slide text per language (en, ja, ko, zh_CN, zh_TW)
  captures/     real screenshots: English at the top level, other languages in captures/<lang>/
  output/       rendered PNGs, output/<lang>/<slide>.png
  render.mjs    the renderer
```

`captures/` and `output/` are not in git: the captures contain third-party pages and account details, and the renders are rebuilt each release. Keep both locally and back them up privately. Without the captures, the slides render with missing images.

## Rendering

```
node store-assets/render.mjs                      every slide in every language
node store-assets/render.mjs --lang=en,ja         some languages
node store-assets/render.mjs --slide=02           slides whose file name contains "02"
node store-assets/render.mjs --scale=2            2× copies named …@2x.png (for checking detail; stores want 1×)
node store-assets/render.mjs --serve              print preview URLs to open in a browser
```

- It needs Node 24 or later and Chrome or Edge, with no npm packages. Set `CHROME_PATH` to use a specific browser.
- Preview through `--serve`. Opening a slide with `file://` blocks its fonts and text.
- Each page sets its size with `<meta name="store-size" content="440x280">`; the default is 1280×800.
- The render always uses the light colour scheme.
- `✓` means the image is fine. `!` (exit code 1) means a text key is missing, an image didn't load, or a `[data-fit]` element wrapped onto more lines than `data-lines` allows (default 1).
- The fit check doesn't notice a headline running into the logo. Check headlines by eye, especially after changing text.

## Editing text

All text is in `locales/<lang>.json`, keyed by the `data-i18n` attribute in the slides. A key missing from the slide's locale falls back to the extension's own `chrome/_locales/<lang>/messages.json`. Every locale file must have the same keys as `en.json`. An empty string is valid where a slide hides empty elements, like `s4_explain_lang` in English and Japanese.

Translation principles:

- **Write native store copy, not literal translations.** For example, "Hear it. Understand it." is 聞いて、わかる。 in Japanese, 듣고, 이해하고. in Korean, and 听得到，看得懂。 in Simplified Chinese.
- **Use the extension's own terms** from its `_locales`, so the images match what users will see: マイ単語, 復習, サポーター, 解説; 서포터, 복습, 설명; 支持者, 复习, 解析 (zh_CN); 支持者, 複習, 解說 (zh_TW).
- **Keep headlines short enough for one line beside the logo.** At 62px that's about 11 CJK characters.
- **Traditional Chinese centres its punctuation (。，)** in the character space. That's the Taiwan convention, not a bug.
- **Have a native speaker check new copy** before it goes live.

## Fonts

IBM Plex Sans (from `chrome/fonts/`) for Latin text. Each other script gets its own Windows font, set in `theme.css` by page language: BIZ UDPGothic for Japanese, Malgun Gothic for Korean, Microsoft YaHei for Simplified Chinese and Microsoft JhengHei for Traditional Chinese. This stops Chinese from borrowing Japanese glyph shapes. Japanese passages inside any slide, marked `lang="ja"`, always use the Japanese font. Headlines in Japanese, Korean and Chinese are 62px with no negative letter spacing. Rendering on a machine without these fonts changes the result.

## Design principles

The look takes its principles from the strongest extension store images, like 10ten Reader's, without copying them:

- **Bold colour fields that alternate between slides:** blue `.blue` (#126edc) and ink `.ink` (#1f3e52). `.paper` is also available.
- **A big, short headline** in IBM Plex Sans 700, 60–76px, on one line, with no highlighted words.
- **The logo lockup at the top right of every slide:** the icon, "Tsukeru" and the tagline.
- **Real UI only.** Popups, word boxes and pages are real captures. HTML draws only the background, the browser frame, the text, the callouts, the cursor and decorations such as the flashcard deck. HTML rebuilds of the UI looked fake and were rejected. The one exception is the sentence bubble on slide 4, a quote of the full sentence, which the capture truncates. It's styled as a quote, not as Tsukeru's UI.
- **A drawn Chrome-on-Windows frame,** so it's obviously a browser extension: a tab with curved feet, the real favicon, a truncated title and ×; the + button; the window controls; back, a greyed forward and reload; an address bar with the lock and ☆; then the pinned Tsukeru icon, the puzzle piece, the profile avatar and ⋮. Copy the frame markup from an existing slide.
- **Large captures** that run off the slide edges.
- **The hand (hover) cursor, never the arrow.** Its fingertip is at about 37% / 9% of the 34px SVG. Place it so it doesn't cover the label it's clicking.
- **Precise callouts:** near-black lines and dots with a white edge, routed through gaps in the UI, ending on the exact feature, with a branch for each target. See slide 2's `svg.leaders`.
- **Supporter features get the yellow ★ Supporter chip** and no footnotes.
- **Two features per slide on later slides,** because Chrome allows only five screenshots.
- **Keep it uncluttered:** no sublines that repeat the callouts, and no flags. Flags stand for countries, not languages, so slide 4 uses a 🌐 globe chip to say explanations also come in Korean or Chinese.
- **Promo tiles are minimal:** the icon and the wordmark, with one kana of furigana over each syllable (Tsu/つ, ke/け, ru/る), plus one tagline line.

## The slides

| Slide | Field | Content |
|---|---|---|
| 01-hero | blue | "Read real Japanese." Wikipedia with furigana in the browser frame, and the popup dropping from the pressed toolbar icon |
| 02-dictionary | ink | "Click any word." The word box open on 地方, with four precise callouts: JLPT and frequency, pitch accent and audio, hear or explain the sentence ★, meanings |
| 03-youtube-x | blue | "YouTube and X, too." Two zoomed-out browser windows, so each site is recognisable |
| 04-hear-understand | ink | "Hear it. Understand it." Feature cards cut from captures: hear any word (it leads), hear the sentence ★, explain the sentence ★ |
| 05-save-review | blue | "Save words. Review later." Step 1, the My Words popup with the cursor on Review now; an arrow; step 2, the EZFurigana review dialog on a fanned flashcard deck |
| promo-small-440x280, promo-marquee-1400x560 | blue | The minimal wordmark tiles |

What changes per language:

- **Slides 1, 2 and 5** show the popup, word box, My Words and review dialog in each language.
- **Slide 4** shows the Japanese word box and the easy-Japanese explanation for every language except English. Korean and Chinese add the globe chip.
- **Slide 3** uses the same captures everywhere, since the pages are Japanese anyway.

## Taking screenshots

- **Pages and word boxes:** use a clean profile and the light theme, with browser zoom at 100%. Either use DevTools device mode at about 1280×800 with DPR 2 (F12, Ctrl+Shift+M, then Ctrl+Shift+P and "Capture screenshot"), or set Windows scaling to 150–200% and take a full-screen capture.
- **The toolbar popup:** set Windows scaling to 150–175% with the window maximised, then press Win+Shift+S. At 200%, the popup gets cut off at the bottom.
- Save as PNG. Avoid personal details in the frame.
- Pick pages with a plain background behind the text, and keep the word box fully on screen.
- **Trim before saving into `captures/`:** keep only the popup, dialog or page area the slide uses, so taskbars and desktops never reach the repo. Cut off popup scrollbars. The existing trims use Python with Pillow, for example `Image.open(src).crop((x0, y0, x1, y1)).save(dst)`.

## Adding or replacing a capture

1. **Trim it and save it** as `captures/<file>.png` for English, or `captures/<lang>/<file>.png` for another language.
2. **For another language,** add an attribute to the slide's `<img>`: `data-src-ja`, `data-src-ko`, `data-src-zh-cn` or `data-src-zh-tw`. i18n.js swaps the source in and waits for it to load.
3. **Set the crop.** `.crop` takes CSS variables in source-image pixels: `--iw` (source width), `--x --y --w --h` (the crop box) and `--s` (scale). The element is `w × s` by `h × s` slide pixels. Per-language crops go in rules such as `html:is(:lang(ja), :lang(ko), :lang(zh)) .popup-crop { … }`; Chinese is `:lang(zh-CN)` or `:lang(zh-TW)` when they differ.
4. **Recompute everything positioned from the capture:** cursors, callout tops, leader lines and the deck size. Inside a browser frame:

   ```
   slide x = frame left + (source x − --x) × --s
   slide y = frame top + 84 + (source y − --y) × --s      (84 = 40px tab strip + 44px toolbar)
   ```

5. **To find targets,** render the slide, crop the area with Pillow, draw tick marks every 20 slide pixels, and read the coordinates off it. Then render again and check at 2× (`--scale=2`) that each dot lands on its target. Captures in other languages move things: label widths change, and so do meaning lengths. Slide 2 has a separate leader set for non-English captures (`.leaders.cjk`), with a per-language last line (`.m-ja`, `.m-ko`, `.m-zh-cn`, `.m-zh-tw`).
6. **Scale:** match the UI's on-screen size to the other languages where you can. For example, a 175% capture at ×0.5714 is the same size as a 200% capture at ×0.5.

## Adding a slide

1. Copy the slide closest to what you need, and keep its `theme.css` link, `i18n.js` script, headline and lockup.
2. Name it with its order number (`06-study-mode.html`). Render order follows file names.
3. Add its text keys to **every** locale file.
4. Render all languages, then check every image by eye: headline clearance, cursor placement and callout targets.

Chrome allows 5 screenshots; Edge allows up to 10 and accepts per-language images; Firefox uses one set, so upload the English images there.

## Before uploading

- Run `node store-assets/render.mjs` and check that every line shows `✓`.
- Look through every image at full size, then at a small size like the store thumbnails.
- Run `node --check` on `store-assets/render.mjs` and `store-assets/i18n.js` if they changed, then `git diff --check`.

## Gotchas

- **Windows can briefly lock a PNG** that a viewer or a sync client has open. render.mjs retries the write; if it still fails, close the viewer and rerun.
- **`.lang-chip:has(span:empty)` hides the globe chip** when its text is empty. Keep the empty key in en.json and ja.json.
- **Showing third-party pages** (Wikipedia, YouTube, X, NHK) has been approved.
