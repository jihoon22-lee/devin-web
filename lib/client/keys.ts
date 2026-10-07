export interface KeyLike {
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  keyCode?: number;
}

/** True while an IME (Korean/Japanese/Chinese) composition is active: Enter
 *  then commits the syllable and must not submit or pick. keyCode 229 covers
 *  Safari, which reports isComposing=false on the committing keydown. */
export function isImeComposing(e: KeyLike): boolean {
  return e.nativeEvent?.isComposing === true || e.isComposing === true || e.keyCode === 229;
}
