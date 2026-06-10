// Singleton action-sheet bus. All views call `open([actions…], header?)`
// and await a `{ index, name }` result. A single <ActionSheet> (custom
// Spotify-style fullscreen sheet) lives in App.vue and binds against this
// store — which avoids the "two views stack two sheets in the body
// teleport, clicks land in the wrong one" bug we hit when each view
// declared its own.
//
// Action shape: { name, icon?, color?, disabled? }. `icon` is a Lucide
// component — markRaw'd here so callers don't have to bother.
// Header shape: { cover?, title?, subtitle? } — when present the sheet
// renders the cover + meta block on a gradient pulled from the artwork
// (Spotify's track / album context menu look).
import { defineStore } from 'pinia';
import { markRaw } from 'vue';

export const useActionSheetStore = defineStore('actionSheet', {
  state: () => ({
    visible: false,
    actions: [],
    header: null,
    _pending: null, // { resolve, reject }
  }),
  actions: {
    open(actions, header = null) {
      // Reject any pending one — a new sheet supersedes the old.
      if (this._pending) {
        this._pending.reject('superseded');
        this._pending = null;
      }
      this.actions = actions.map((a) =>
        a.icon ? { ...a, icon: markRaw(a.icon) } : a,
      );
      this.header = header;
      this.visible = true;
      return new Promise((resolve, reject) => {
        this._pending = { resolve, reject };
      });
    },
    onSelect(action, index) {
      if (action?.disabled) return;
      this.visible = false;
      this._pending?.resolve({ index, name: action.name });
      this._pending = null;
    },
    onCancel() {
      this.visible = false;
      this._pending?.reject('cancel');
      this._pending = null;
    },
  },
});
