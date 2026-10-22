'use strict';
// Surface-role mapping adapted from zcode-beautify-for-wallpaper-engine.
// Copyright (c) 2026 Logocceai, MIT. See THIRD-PARTY-NOTICES.md.
// This styles Chromium content only; it does not blur the native WE window.
const APPEARANCE_PRESETS = Object.freeze({
  clear: Object.freeze({opacity:0.38,dim:0.06}),
  balanced: Object.freeze({opacity:0.64,dim:0.12}),
  focus: Object.freeze({opacity:0.88,dim:0.25})
});
const number = (value, fallback, max=1) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max,Math.max(0,value)) : fallback;
const rounded = value => Number(value.toFixed(4));
function surfaceRows(rgb, opacity) {
  const alpha = {
    panel:opacity * (0.72 + 0.28 * opacity),
    surface:opacity,
    hover:opacity + (1-opacity)*0.08,
    selected:opacity + (1-opacity)*0.2,
    input:opacity + (1-opacity)*0.18,
    focused:opacity + (1-opacity)*0.65,
    popover:opacity + (1-opacity)*0.92
  };
  const roles = {
    'background-alt':'panel','background-win-alt':'panel',panel:'panel',sidebar:'panel',
    surface:'surface','surface-hover':'hover',card:'surface','card-selected':'selected',
    input:'input','input-focused':'focused',popover:'popover'
  };
  return '--color-background:transparent!important;' + Object.entries(roles).map(([role,level]) =>
    `--color-${role}:rgba(${rgb},${rounded(alpha[level])})!important;`).join('');
}
function buildAppearanceCss(config = {}) {
  const opacity=number(config?.opacity,APPEARANCE_PRESETS.balanced.opacity);
  const dim=number(config?.dim,APPEARANCE_PRESETS.balanced.dim,0.6);
  // Theme remains owned by ZCode. Never change foreground, accent, borders,
  // warning/error tokens, or the root .dark class. Retained config.theme is
  // intentionally ignored so older dark defaults do not recolor light mode.
  return `html,body,#root{background:transparent!important;}
:root,:host{${surfaceRows('255,255,255',opacity)}}
.dark{${surfaceRows('18,18,22',opacity)}}
body{isolation:isolate!important;}
body::before{content:""!important;position:fixed!important;inset:0!important;z-index:-1!important;background:rgba(0,0,0,${rounded(dim)})!important;pointer-events:none!important;}`;
}
module.exports={buildAppearanceCss,APPEARANCE_PRESETS};
