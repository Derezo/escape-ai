/**
 * Tiny DOM helpers shared across the client overlays.
 *
 * Renderer-agnostic, no dependencies — just thin wrappers over the standard DOM so
 * the same logic isn't re-derived (and drifted) in every overlay module.
 */

/**
 * Is `el` a focusable text-entry target — i.e. is the user TYPING into it?
 *
 * True for `<input>` (text-like types only — not buttons/checkboxes/etc.),
 * `<textarea>`, and any `contentEditable` element. Used by the keyboard-shortcut
 * overlays (help/inventory/leaderboard) to BAIL on their single-letter toggle keys
 * while a text field is focused, so typing "this" into chat doesn't fire H (help)
 * and I (inventory). A shortcut must never act on a keystroke meant for a text box.
 *
 * @param el typically `document.activeElement` or a KeyboardEvent's target
 */
export function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    // Non-text input types (button, checkbox, radio, range, …) don't capture
    // typed characters, so a shortcut firing while one is focused is fine; only
    // the text-entry types must swallow letter keys.
    const type = (el as HTMLInputElement).type;
    const NON_TEXT = new Set([
      'button',
      'checkbox',
      'radio',
      'range',
      'color',
      'file',
      'image',
      'reset',
      'submit',
    ]);
    return !NON_TEXT.has(type);
  }
  return false;
}

/**
 * Is the user currently typing into ANY text field on the page? Convenience wrapper
 * over {@link isEditableTarget} against the live focus. Lets a shortcut handler ask
 * "should I stay out of the way right now?" without threading per-widget focus state.
 */
export function isTypingInTextField(): boolean {
  return isEditableTarget(document.activeElement);
}
