// Singleton action-sheet bus. All views call `open([actions…])` and await
// a `{ index, name }` result. A single `<van-action-sheet>` lives in
// App.vue and binds against this store — which avoids the "two views
// stack two sheets in the body teleport, clicks land in the wrong one"
// bug we hit when each view declared its own.
import { defineStore } from 'pinia';

export const useActionSheetStore = defineStore('actionSheet', {
  state: () => ({
    visible: false,
    actions: [],
    _pending: null, // { resolve, reject }
  }),
  actions: {
    open(actions) {
      // Reject any pending one — a new sheet supersedes the old.
      if (this._pending) {
        this._pending.reject('superseded');
        this._pending = null;
      }
      this.actions = actions;
      this.visible = true;
      return new Promise((resolve, reject) => {
        this._pending = { resolve, reject };
      });
    },
    onSelect(action, index) {
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
