// Public metadata: keep ordinary RTL text, combining marks, ZWJ/ZWNJ and emoji.
// Reject terminal controls, direction overrides and hidden separators. This is
// a display-content contract, not HTML sanitization or identifier normalization.
// Tag characters can encode whole instructions without visible glyphs. Fillers,
// interlinear/musical controls and nonstandard line separators are also refused.
// Ordinary LF/CR/tab remain available in multiline descriptions and Markdown.
export const UNSAFE_PUBLIC_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}]/u;
