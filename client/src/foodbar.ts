/**
 * The food bar — a persistent, always-visible top-right HUD strip showing the
 * food the player is currently carrying as an icon grid with a count (e.g. 🍌 ×10).
 * Icon-only and compact by design; the full named readout ("feeds Ape", per-food
 * blurbs) stays in the toggle-I inventory overlay (inventory.ts). This is the
 * at-a-glance "what's in my bag right now" version.
 *
 * The data is the LOCAL player's server-authoritative `inventory` map
 * (foodKey → count), read from its snapshot entity each frame by main.ts and handed
 * to `render()`. A per-key cache means a chip's DOM is touched only when THAT food's
 * count changes; when it does, the chip plays a one-shot expand/contract bounce so
 * the count visibly reacts as the player collects (E) or feeds (F). Calling render()
 * every frame is cheap — an unchanged bag is a no-op.
 */

import { FOODS, foodByKey } from '@shared/food';

export interface FoodBarHandle {
  /** Update the strip from the latest inventory map (no-op if unchanged). */
  render(inventory: Record<string, number> | undefined): void;
}

/** One mounted chip: its elements + the last count we rendered for it. */
interface Chip {
  root: HTMLElement;
  count: HTMLElement;
  last: number;
}

/**
 * Build the food bar (top-right, hidden until the player holds something) and
 * return a handle. Chips are created lazily per food key and kept in roster order.
 */
export function createFoodBar(): FoodBarHandle {
  const bar = document.createElement('div');
  bar.id = 'foodbar';
  document.body.appendChild(bar);

  // One chip per food key, mounted lazily and kept in stable roster order so a
  // newly-collected food slots into the same place every time.
  const chips = new Map<string, Chip>();

  /** Lazily build (once) the chip for a food key, inserted in roster order. */
  const chipFor = (key: string): Chip => {
    const existing = chips.get(key);
    if (existing) return existing;

    const def = foodByKey(key);
    const root = document.createElement('div');
    root.className = 'foodbar-chip';
    root.title = def?.label ?? key; // hover tooltip; the strip itself is icon-only
    root.innerHTML = `
      <span class="foodbar-icon">${def?.icon ?? '🍖'}</span>
      <span class="foodbar-count">×0</span>
    `;
    const chip: Chip = {
      root,
      count: root.querySelector<HTMLElement>('.foodbar-count')!,
      last: 0,
    };
    chips.set(key, chip);

    // Insert in roster order: find the first already-mounted chip whose food comes
    // AFTER this one and insert before it, else append.
    const order = FOODS.map((f) => f.key);
    const myIdx = order.indexOf(key);
    let inserted = false;
    for (const child of Array.from(bar.children)) {
      const childKey = (child as HTMLElement).dataset.key;
      if (childKey && order.indexOf(childKey) > myIdx) {
        bar.insertBefore(root, child);
        inserted = true;
        break;
      }
    }
    if (!inserted) bar.appendChild(root);
    root.dataset.key = key;
    return chip;
  };

  /** Replay the bounce: remove the class, force reflow, re-add so it restarts. */
  const bounce = (el: HTMLElement): void => {
    el.classList.remove('bump');
    void el.offsetWidth; // reflow — lets the animation re-trigger on every change
    el.classList.add('bump');
  };

  return {
    render(inventory) {
      let anyHeld = false;
      for (const f of FOODS) {
        const n = inventory?.[f.key] || 0;
        const mounted = chips.get(f.key);

        if (n <= 0) {
          // Dropped to zero — remove the chip so the strip only shows held food.
          if (mounted) {
            mounted.root.remove();
            chips.delete(f.key);
          }
          continue;
        }

        anyHeld = true;
        const chip = chipFor(f.key);
        if (n !== chip.last) {
          chip.count.textContent = `×${n}`;
          chip.last = n;
          bounce(chip.root); // expand/contract pulse on collect OR feed
        }
      }
      bar.classList.toggle('active', anyHeld);
    },
  };
}
