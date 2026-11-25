// One set of level names on every tab (framework section 6: plain words, no
// contradiction between tabs). The option map and the level board keep their
// own stored labels, which tests and records are keyed on; this turns a label
// (or a line that joins several) into the words the reader sees.

const NAMES: Array<[RegExp, string]> = [
  [/\bwall above\b/gi, "ceiling above"],
  [/\bmagnet below\b/gi, "floor below"],
  [/\bgamma flip\b/gi, "turning point"],
  [/\bzero[- ]gamma\b/gi, "turning point"],
  [/\bstraddle high\b/gi, "top of the priced move"],
  [/\bstraddle low\b/gi, "bottom of the priced move"],
  [/\bstraddle range top\b/gi, "top of the priced move"],
  [/\bstraddle range bottom\b/gi, "bottom of the priced move"],
  [/([+-])1 sigma to the close\b/gi, "$1one typical move to the close"],
  [/\bcall wall\b/gi, "ceiling"],
  [/\bput wall\b/gi, "floor"],
  [/\bpocket above\b/gi, "thin spot above"],
  [/\bpocket below\b/gi, "thin spot below"],
  [/\bpivot R1\b/g, "resistance from yesterday's range (R1)"],
  [/\bpivot S1\b/g, "support from yesterday's range (S1)"],
  [/\bpivot\b(?! (?:R|S)\d)/g, "middle of yesterday's range"],
  [/\bpin\b(?! level)/g, "pin level"],
];

/** "pivot S1 7,152 + pin 7,150 + wall above 7,150" reads with the shared names. Works on a whole sentence too. */
export function plainLevelName(label: string | null | undefined): string {
  if (label == null) return "";
  let out = String(label);
  for (const [re, to] of NAMES) out = out.replace(re, to);
  return out;
}
