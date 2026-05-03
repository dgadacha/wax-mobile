// View state — what page is showing, and any per-page args. Maintains a
// navigation history stack so deep views (artist, playlist, mix) can offer
// a back-arrow affordance without a full router.
import { defineStore } from 'pinia';

export const useViewStore = defineStore('view', {
  state: () => ({
    name: 'download', // 'download' | 'library' | 'playlist' | 'mix' | 'artist'
    selectedPlaylistId: null,
    selectedArtist: null, // string (display name) when name === 'artist'
    // Stack of { name, arg } describing where we came from. Pushed by
    // `switchTo`, popped by `back`. Capped soft at 50 entries to avoid
    // unbounded growth on heavy navigation sessions.
    history: [],
  }),
  getters: {
    canGoBack: (state) => state.history.length > 0,
  },
  actions: {
    switchTo(name, arg) {
      this._goto(name, arg, /* pushHistory */ true);
    },
    back() {
      if (this.history.length === 0) {
        // Default landing — favorites is the most useful "home".
        this._goto('library', null, false);
        return;
      }
      const prev = this.history.pop();
      this._goto(prev.name, prev.arg, false);
    },
    _goto(name, arg, pushHistory) {
      if (pushHistory && this.name) {
        // Don't push duplicate consecutive entries.
        const currentArg = this.selectedPlaylistId || this.selectedArtist || null;
        const last = this.history[this.history.length - 1];
        if (!last || last.name !== this.name || last.arg !== currentArg) {
          this.history.push({ name: this.name, arg: currentArg });
          if (this.history.length > 50) this.history.shift();
        }
      }
      this.name = name;
      this.selectedPlaylistId = name === 'playlist' ? arg : null;
      this.selectedArtist = name === 'artist' ? arg : null;
      const main = document.querySelector('.main');
      if (main) main.scrollTop = 0;
    },
  },
});
