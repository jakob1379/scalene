// Typed event bus for transient events (hover, jumps, theme). DESIGN.md §8.3.
import type { HotspotItem, Model } from "../model/model";
import type { AppState, Target } from "./store";

export type Source =
  | "headline"
  | "readout"
  | "hotspot"
  | "scope"
  | "finding"
  | "code"
  | "minimap"
  | "flame"
  | "timeline"
  | "memory"
  | "palette"
  | "global"
  | "detail";

export interface JumpOptions {
  focus?: boolean;
  open?: boolean;
  flash?: boolean;
  source?: Source;
}

export interface Events {
  "profile:loaded": { model: Model };
  "hover:line": { target: Target | null; source: Source };
  "hover:peak": { on: boolean };
  "range:set": { range: [number, number] | null; source: Source; reveal?: boolean };
  "stacks:show": { target: Target };
  "timeline:show": { target: Target };
  "theme:changed": { theme: "light" | "dark" };
  "motion:changed": { reduced: boolean };
  "layout:changed": AppState["layout"];
  "hotspots:changed": { items: HotspotItem[] }; // drives scope TOP LINES + minimap pins
  "ai:open-settings": { focusField?: string };
}

export interface Bus<E> {
  on<K extends keyof E>(k: K, cb: (p: E[K]) => void): () => void;
  emit<K extends keyof E>(k: K, p: E[K]): void;
}

export function createBus<E>(): Bus<E> {
  const handlers = new Map<keyof E, Set<(p: never) => void>>();
  return {
    on(k, cb) {
      let set = handlers.get(k);
      if (!set) handlers.set(k, (set = new Set()));
      set.add(cb as (p: never) => void);
      return () => {
        set?.delete(cb as (p: never) => void);
      };
    },
    emit(k, p) {
      const set = handlers.get(k);
      if (!set) return;
      for (const cb of Array.from(set)) {
        try {
          (cb as (p: E[typeof k]) => void)(p);
        } catch (e) {
          // One failing listener must not starve the others; the error still surfaces.
          setTimeout(() => {
            throw e;
          });
        }
      }
    },
  };
}
