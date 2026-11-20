// Unicode 17.0 Default_Ignorable_Code_Point, with contextual exceptions.
// https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt
// Display controls are also refused. This is not HTML sanitization.
const ignorable = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufff8\u{1bca0}-\u{1bca3}\u{1d173}-\u{1d17a}\u{e0000}-\u{e0fff}]/u;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufff9-\ufffb]/u;
const ideograph = c => /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{33479}]/u.test(c);
const visible = c => Boolean(c && !ignorable.test(c) && !controls.test(c) && !/\s/u.test(c));
const joining = c => visible(c) && /[\p{L}\p{M}\p{So}\u{1f3fb}-\u{1f3ff}]/u.test(c);
export const DEFAULT_IGNORABLE = ignorable;

function permitted(chars, index) {
  const point = chars[index].codePointAt(0), before = chars[index - 1] ?? '', after = chars[index + 1] ?? '';
  if (point === 0x200c || point === 0x200d) {
    const base = /[\ufe0e\ufe0f]/u.test(before) ? chars[index - 2] ?? '' : before;
    return joining(base) && joining(after);
  }
  if (point === 0xfe0e || point === 0xfe0f) return visible(before) && /[\p{So}#*0-9]/u.test(before);
  if ((point >= 0xfe00 && point <= 0xfe0d) || (point >= 0xe0100 && point <= 0xe01ef)) return ideograph(before);
  if ([0x180b, 0x180c, 0x180d, 0x180f].includes(point)) return /[\u1820-\u18aa]/u.test(before);
  return false;
}

export function publicTextIssues(value) {
  const chars = [...String(value)], issues = [];
  const blank = chars.length > 0 && chars.every(c => /[\s\u2800]/u.test(c));
  for (let position = 0; position < chars.length; position++) {
    const c = chars[position];
    if (controls.test(c) || (blank && c === '\u2800') || (ignorable.test(c) && !permitted(chars, position))) {
      issues.push({ position: position + 1, codepoint: 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') });
    }
  }
  return issues;
}
export const UNSAFE_PUBLIC_TEXT = Object.freeze({ test: value => publicTextIssues(value).length > 0 });
