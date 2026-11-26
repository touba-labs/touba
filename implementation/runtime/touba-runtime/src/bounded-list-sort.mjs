// Stable merge sort: no locale, user comparator or mutation of the input.
export function boundedListSort(values, checkRun) {
  let source = values.slice(), target = new Array(values.length);
  for (let width = 1; width < values.length; width *= 2) {
    for (let start = 0; start < values.length; start += width * 2) {
      const middle = Math.min(start + width, values.length), end = Math.min(start + width * 2, values.length);
      let left = start, right = middle;
      for (let at = start; at < end; at++) {
        checkRun();
        if (left < middle && (right >= end || source[left] <= source[right])) target[at] = source[left++];
        else target[at] = source[right++];
      }
    }
    [source, target] = [target, source];
  }
  return source;
}
