/*
 * Material Symbols (Outlined), inlined as SVG paths.
 *
 * Not loaded as a webfont from fonts.googleapis.com, for two reasons that are
 * both hard requirements here:
 *
 *   - web/tools/build-single.mjs produces a dist/updater.html with *no*
 *     external requests; a <link> to Google Fonts would break that promise
 *     for the release artifact.
 *   - the service worker precaches every asset so the client works offline
 *     next to a device with no internet. A CDN font cannot be precached from
 *     a different origin without opaque-response caching.
 *
 * The variable font is also ~250 KB for the handful of glyphs used here; these
 * paths are a couple of KB and need no font loading, so there is no icon FOUT.
 *
 * Path data copied verbatim from github.com/google/material-design-icons,
 * symbols/web/<name>/materialsymbolsoutlined/<name>_24px.svg (Apache-2.0).
 * The 0 -960 960 960 viewBox is the Material Symbols convention.
 */

export const ICON_PATHS = {
  upload:
    "M440-320v-326L336-542l-56-58 200-200 200 200-56 58-104-104v326h-80ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z",
  settings:
    "m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z",
  refresh:
    "M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z",
  memory:
    "M360-360v-240h240v240H360Zm80-80h80v-80h-80v80Zm-80 320v-80h-80q-33 0-56.5-23.5T200-280v-80h-80v-80h80v-80h-80v-80h80v-80q0-33 23.5-56.5T280-760h80v-80h80v80h80v-80h80v80h80q33 0 56.5 23.5T760-680v80h80v80h-80v80h80v80h-80v80q0 33-23.5 56.5T680-200h-80v80h-80v-80h-80v80h-80Zm320-160v-400H280v400h400ZM480-480Z",
  restart_alt:
    "M440-122q-121-15-200.5-105.5T160-440q0-66 26-126.5T260-672l57 57q-38 34-57.5 79T240-440q0 88 56 155.5T440-202v80Zm80 0v-80q87-16 143.5-83T720-440q0-100-70-170t-170-70h-3l44 44-56 56-140-140 140-140 56 56-44 44h3q134 0 227 93t93 227q0 121-79.5 211.5T520-122Z",
};

export default {
  name: "Icon",
  props: {
    name: { type: String, required: true },
    size: { type: Number, default: 20 },
  },
  setup(props) {
    /* Unknown name renders nothing rather than an empty <path>, so a typo is
     * visible as a missing icon instead of a mystery blank box. */
    return { d: () => ICON_PATHS[props.name] || "" };
  },
  template: /* html */ `
    <svg class="icon" viewBox="0 -960 960 960" :width="size" :height="size"
         aria-hidden="true" focusable="false"><path :d="d()" fill="currentColor"/></svg>
  `,
};
