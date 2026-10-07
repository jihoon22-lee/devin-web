/** Pure scroll-pin decision, shared by the chat and transcript views.
 *
 *  Two kinds of scrollTop changes must never un-pin:
 *  - the scroll event that follows a programmatic `scrollTop = scrollHeight`
 *    fires asynchronously — by the time it runs, more content may have grown
 *    scrollHeight, making the same position look "unstuck";
 *  - scroll anchoring / content-visibility resolution can move scrollTop
 *    WITHOUT any user input (the browser shifts the viewport to keep it
 *    visually stable as off-screen items resolve to real heights).
 *
 *  So an upward move only counts as "user scrolled away" when real input
 *  (wheel / touch / key) was seen just before the event. */
export function scrollDecision(
  scrollTop: number,
  lastTop: number,
  scrollHeight: number,
  clientHeight: number,
  inputRecent: boolean,
  gestureTop: number = lastTop,
  upIntentPx = 0,
): { at: boolean; unstick: boolean } {
  // an upward move alongside real input wins over the at-bottom check —
  // otherwise small scroll-ups inside the threshold get swallowed: the pin
  // snaps the view back down, the user scrolls up again, and the two fight.
  // Streaming growth can also eat the gained distance and re-enter the
  // threshold, re-sticking mid-gesture.
  //
  // Two signals: the per-event delta (lastTop) for ordinary moves, and the
  // cumulative delta from the gesture start (gestureTop) for touch drags on
  // content-visibility lists — scroll anchoring pushes scrollTop back down
  // as offscreen items resolve taller, masking each event's user delta, but
  // the compensation is bounded while the drag is continuous, so net
  // progress past a few px still means "the user is scrolling up".
  // upIntentPx is input-side accumulation (finger travel / wheel delta) —
  // the last resort when anchoring compensation exceeds the user's real
  // progress entirely and scrollTop never moves up
  const movedUp =
    scrollTop < lastTop - 1 || scrollTop < gestureTop - 8 || upIntentPx > 30;
  if (inputRecent && movedUp) {
    return { at: false, unstick: true };
  }
  const at = scrollHeight - scrollTop - clientHeight < 60;
  return { at, unstick: false };
}
