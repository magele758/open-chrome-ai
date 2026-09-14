// Strip closed-caption directions, not arbitrary parenthetical dialogue.
const direction = /^(?:(?:soft(?:ly)?|loud(?:ly)?|audience|everyone|all|man|woman|轻轻|轻声|观众)\s*)?(?:laugh(?:s|ing|ter)?|chuckl(?:e|es|ing)|giggl(?:e|es|ing)|smil(?:e|es|ing)|sigh(?:s|ing)?|gasp(?:s|ing)?|cough(?:s|ing)?|clears? throat|breath(?:ing|s)?|applause|clapping|music|silence|laughter and applause|微笑|叹气|叹息|笑声|笑|轻笑|大笑|苦笑|掌声|鼓掌|音乐|背景音乐|喘气|呼吸|咳嗽|清嗓|沉默|静音)[.!。！…]*$/i;
export function stripSubtitleDirections(value) {
  return String(value || '')
    .replace(/\[([^\[\]]*)\]|\(([^()]*)\)|（([^（）]*)）|【([^【】]*)】/g, (whole, ...parts) => direction.test(parts.slice(0, 4).find(p => p !== undefined).trim()) ? ' ' : whole)
    .replace(/^[\s>♪♫]+|[\s>♪♫]+$/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}
