# Research: typography in modern chat interfaces

**Recommendation for OpenBot:** use a native system sans stack for product UI and message text. Do not bundle Inter, Open Sans, Universal Sans, or OpenAI Sans for v1. This matches the installed GrokBot and OpenAI desktop defaults, renders as SF Pro on Apple devices, Segoe UI on Windows, and the platform sans on Android and Linux, while avoiding a font download, licensing questions, and a less-native result.

```css
--font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
  Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji",
  "Segoe UI Emoji";

--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco,
  Consolas, "Liberation Mono", "Courier New", monospace;
```

The products do not all use one fashionable web font. Native chat apps generally use either the platform font or a long-established product font. The closest references for OpenBot are GrokBot and the OpenAI desktop UI, and both use a system stack.

## Findings

| Product | Confirmed product UI typography | Confidence and boundary |
| --- | --- | --- |
| Apple Messages / iMessage | SF Pro through Apple's system font APIs on iOS and macOS | High for Latin-script UI. Apple confirms SF Pro is the system font on both platforms. Messages is closed source, so there is no product-specific public declaration to cite. Localized scripts can resolve to Apple's appropriate system fallback. |
| Telegram Desktop | Open Sans by default; users can select the system font or another installed family | High. The official client registers and loads Open Sans, while current settings expose Default, System, and custom font choices. |
| Telegram iOS | UIKit system fonts, therefore SF Pro for Latin UI | High. Telegram's `Font.regular`, `medium`, `semibold`, and `bold` helpers call `UIFont` system-font APIs. |
| Telegram Web K | Roboto first, followed by a platform fallback stack | High. It bundles Roboto and sets it first in `--font-regular`. |
| Telegram Android | Android/Roboto-based typography; Telegram bundles explicit Roboto Medium, Extra Bold, Medium Italic, and Mono faces for roles that need them | High for the named roles. The source can optionally use the system weight instead of bundled Roboto Medium. This is not evidence that every Android string is assigned an embedded font. |
| Installed GrokBot 0.27.0 | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` | High. The root renderer uses this stack. On the installed Mac it resolves to SF Pro. |
| OpenAI | OpenAI Sans is the corporate typeface. The installed OpenAI Codex desktop UI defaults to `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`, while also bundling OpenAI Sans as an opt-in utility | High for the brand and installed desktop bundle. This does not prove the exact current ChatGPT consumer web stack. |
| xAI Grok web | Universal Sans Text for ordinary UI, with Inter as the first bundled fallback; Universal Sans Display for display roles; IBM Plex Mono for code | High. These are declared in the current first-party Grok CSS and wired into the page's default sans and mono variables. |

## Evidence and exact stacks

### Apple Messages / iMessage

Apple's typography guidance states that SF Pro is the system font in both iOS/iPadOS and macOS, and recommends using the system APIs rather than embedding it. It also documents script-specific members of the San Francisco family and dynamic system fallbacks. See [Apple Human Interface Guidelines: Typography](https://developer.apple.com/design/human-interface-guidelines/typography) and [Fonts for Apple platforms](https://developer.apple.com/fonts/).

Messages itself is proprietary. The defensible statement is therefore "Messages renders its native system typography as SF Pro for Latin text," not "Messages declares this CSS stack." There is no CSS stack in a native UIKit/AppKit application.

### Telegram varies by client

Telegram Desktop is not a system-font app by default. Its official repository lists Open Sans among the client dependencies ([README at the inspected revision](https://github.com/telegramdesktop/tdesktop/blob/23dff657fc857c3223fa20472aa8614b9ab2c7eb/README.md)). The official `lib_ui` submodule registers Open Sans, loads it from the application resources, and resolves the default non-monospace face to Open Sans. It leaves the `QFont` system family in place only when the user explicitly selects the system option ([font resolver](https://github.com/desktop-app/lib_ui/blob/c58798ca79a83fae7340d2d554abfe931c64d81a/ui/style/style_core_font.cpp)). Telegram Desktop's current Chat Settings UI exposes Default, System, and a chosen custom family ([settings source](https://github.com/telegramdesktop/tdesktop/blob/23dff657fc857c3223fa20472aa8614b9ab2c7eb/Telegram/SourceFiles/settings/sections/settings_chat.cpp)).

Telegram iOS uses its `Font` wrapper around `UIFont.systemFont`, `boldSystemFont`, and related system APIs ([Telegram iOS Font.swift](https://github.com/TelegramMessenger/Telegram-iOS/blob/6ad963e5b62d354da79040f388ae2b9132fb17b8/submodules/Display/Source/Font.swift)). Combined with Apple's platform documentation, that means SF Pro for ordinary Latin UI text.

Telegram Web K explicitly declares:

```css
"Roboto", -apple-system, Apple Color Emoji, BlinkMacSystemFont, "Segoe UI",
Roboto, Oxygen-Sans, Ubuntu, Cantarell, "Helvetica Neue", sans-serif
```

Roboto is bundled through `@font-face` and is first, so this is a Roboto product UI rather than a system-first UI. See its [font configuration](https://github.com/morethanwords/tweb/blob/e5ad6616fb6df04362d535171cbda02fa31fc794/src/config/font.ts), [`--font-regular` definition](https://github.com/morethanwords/tweb/blob/e5ad6616fb6df04362d535171cbda02fa31fc794/src/scss/base.scss), and [Roboto font faces](https://github.com/morethanwords/tweb/blob/e5ad6616fb6df04362d535171cbda02fa31fc794/src/scss/fonts/_roboto.scss).

Telegram Android defines bundled Roboto roles such as `fonts/rmedium.ttf`, `rextrabold.ttf`, `rmediumitalic.ttf`, and `rmono.ttf`; its bold helper can instead ask Android for system weight 500 when that preference is enabled. See [AndroidUtilities.java](https://github.com/DrKLO/Telegram/blob/62b56a07ca7e30e39f7fd00a6728d6bbd716ca1c/TMessagesProj/src/main/java/org/telegram/messenger/AndroidUtilities.java).

### Installed GrokBot

The inspected `/Applications/Grok Bot.app` is version 0.27.0. Its renderer CSS in `Contents/Resources/app.asar`, asset `dist/renderer/assets/index-BhL2J-Bw.css`, defines:

```css
--cursor-font-family-sans: var(
  --cursor-font-family,
  var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif)
);

:root {
  font-family: var(--cursor-font-family-sans);
}
```

The same bundle defines 400, 500, and 600 UI weights, with regular adjusted to 420 on Darwin. It does not bundle a general-purpose sans font. The only non-math font file in the renderer is the icon font. Archive SHA-256 at inspection time: `8517a4ca7e7c986f1321de6165720645e4889df23687a4231a529b6b2a252162`.

This is primary local evidence for GrokBot, not evidence about xAI Grok's web product. They use different typography.

### OpenAI brand versus product UI

OpenAI's official design guidelines identify OpenAI Sans as the corporate typeface and describe its five core weights. That establishes the brand font, but does not state that every ChatGPT control or message uses it. See [OpenAI Design Guidelines](https://openai.com/brand/).

The locally installed first-party `/Applications/ChatGPT.app` is the OpenAI Codex desktop bundle, version 26.820.60940 and bundle identifier `com.openai.codex`. Its main webview CSS, `webview/assets/app-njMhN8tr.css` inside `Contents/Resources/app.asar`, defines the default as:

```css
--font-sans-default: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-sans: var(--vscode-font-family, var(--font-sans-default));
```

It also bundles OpenAI Sans Regular and Medium and exposes `font-openai-sans` for selected elements. In other words, OpenAI Sans is available, while the default UI token remains system-first. Archive SHA-256 at inspection time: `c964aebbf9a6a0f70799d01215c611d8ef6ee63f816b3d57beccddd47a811fd9`.

The exact current ChatGPT consumer web font could not be established from a directly accessible first-party stylesheet because `chatgpt.com` returned a browser-verification page to automated asset inspection. It would be inaccurate to turn the OpenAI brand guideline or the Codex bundle into a claim about all of ChatGPT web.

### xAI Grok web

The current first-party Grok page loads a hashed stylesheet that embeds Universal Sans Text at weights 400 and 550, plus italics. It declares:

```css
--font-universal-sans: "universalSans", var(--font-inter);
--font-inter: "Inter", Roboto, "Open Sans", Arial, sans-serif;
```

The main application stylesheet then sets:

```css
--font-sans: var(--font-universal-sans), ui-sans-serif, system-ui, sans-serif,
  "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
```

Universal Sans Display is used for display-specific roles, and IBM Plex Mono is the code face. See xAI's live first-party [font declarations](https://cdn.grok.com/_next/static/chunks/2akz55gv8ftvk.css) and [application typography variables](https://cdn.grok.com/_next/static/chunks/348113mg_xofv.css), fetched on 2026-08-26.

## Decision for OpenBot

Use the system stack. It preserves the familiarity the user wants and matches GrokBot more closely than copying Telegram Desktop's Open Sans or xAI Grok's licensed Universal Sans. It also behaves like iMessage and Telegram iOS on Apple devices without pretending a web application can name SF Pro directly.

Keep typography ownership small:

- one sans token for all interface and message text;
- one mono token for code, paths, commands, and logs;
- regular, medium, semibold, and bold as the only default UI weights;
- no product-specific font selector in v1;
- no custom webfont download unless later visual testing demonstrates a concrete problem the system stack cannot solve.
