// Tiny Promise-based wrapper around <van-action-sheet>. Vant 4 only ships
// ActionSheet as a component (no imperative helper), so we keep the state
// local to the calling component but expose an `open(actions)` Promise that
// resolves to { index, name } when the user picks an action, or rejects
// when they cancel.
import { ref } from 'vue';

export function useActionSheet() {
  const visible = ref(false);
  const actions = ref([]);
  let pending = null;

  function open(items) {
    actions.value = items;
    visible.value = true;
    return new Promise((resolve, reject) => { pending = { resolve, reject }; });
  }

  function onSelect(action, index) {
    visible.value = false;
    pending?.resolve({ index, name: action.name });
    pending = null;
  }

  function onCancel() {
    visible.value = false;
    pending?.reject('cancel');
    pending = null;
  }

  return { visible, actions, open, onSelect, onCancel };
}
