<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { Plus, Pencil, Trash2, Check } from 'lucide-vue-next';
import { showConfirmDialog, showToast } from 'vant';
import { useProfileStore } from '@/stores/profile';
import { ACCENT_SWATCHES } from '@/stores/prefs';
import { haptics } from '@/lib/haptics';

const profile = useProfileStore();

// Show the gate when:
//   - No profile is active, OR
//   - User explicitly tapped "Changer de profil" in settings.
const visible = computed(() => profile.needsPicker || profile.pickerVisible);

// "Édition" mode toggles between "tap to pick" and "tap to delete / rename".
const editMode = ref(false);

// In-form state for creating a new profile.
const creating = ref(false);
const newName = ref('');
const newColor = ref(ACCENT_SWATCHES[0].hex);

watch(visible, (v) => { if (!v) { creating.value = false; editMode.value = false; } });

function initial(name) {
  return (name || '?').trim()[0]?.toUpperCase() || '?';
}

async function submitNew() {
  const name = newName.value.trim();
  if (!name) return;
  haptics.success();
  await profile.create({ name, color: newColor.value });
  creating.value = false;
  newName.value = '';
}

async function onLongPress(p) {
  // long-press lets the user rename — same affordance as Netflix's
  // "Manage profiles" screen on mobile.
  editMode.value = true;
}

async function renameProfile(p) {
  const { showDialog } = await import('vant');
  // Vant has no input dialog out of the box — fall back to a native
  // prompt for now. Replace with a custom sheet later if it grates.
  const next = window.prompt('Nouveau nom', p.name);
  if (!next || !next.trim()) return;
  await profile.rename(p.id, next.trim());
}

async function deleteProfile(p) {
  try {
    await showConfirmDialog({
      title: 'Supprimer le profil',
      message: `Supprimer "${p.name}" et toutes ses données ?`,
      confirmButtonText: 'Supprimer',
      cancelButtonText: 'Annuler',
      confirmButtonColor: 'var(--danger)',
    });
    await profile.remove(p.id);
    showToast({ message: 'Profil supprimé', position: 'bottom' });
  } catch {}
}
</script>

<template>
  <transition name="gate-fade">
    <div v-if="visible" class="gate" :class="{ 'no-bg': profile.profiles.length === 0 }">
      <div class="gate-inner">
        <h1 class="gate-title">Qui écoute ?</h1>

        <div v-if="creating" class="gate-form">
          <div
            class="gate-avatar big"
            :style="{ background: newColor }"
          >
            {{ initial(newName || '?') }}
          </div>
          <input
            v-model="newName"
            type="text"
            class="gate-input"
            placeholder="Nom du profil"
            maxlength="32"
            @keyup.enter="submitNew"
          />
          <div class="gate-colors">
            <button
              v-for="s in ACCENT_SWATCHES"
              :key="s.id"
              class="color-dot"
              :class="{ active: newColor === s.hex }"
              :style="{ background: s.hex }"
              :aria-label="s.label"
              @click="newColor = s.hex"
            />
          </div>
          <div class="gate-form-actions">
            <button class="ghost-btn" @click="creating = false">Annuler</button>
            <button class="primary-btn" :disabled="!newName.trim()" @click="submitNew">Créer</button>
          </div>
        </div>

        <template v-else>
          <div class="gate-grid">
            <div
              v-for="p in profile.profiles"
              :key="p.id"
              class="gate-card"
              @click="editMode ? null : (haptics.light(), profile.pick(p.id))"
            >
              <div class="gate-avatar" :style="{ background: p.color }">
                {{ initial(p.name) }}
                <div v-if="editMode && p.id !== 'default'" class="gate-overlay">
                  <button class="overlay-btn" @click.stop="renameProfile(p)" aria-label="Renommer">
                    <Pencil :size="18" color="#fff" :stroke-width="2" />
                  </button>
                  <button class="overlay-btn" @click.stop="deleteProfile(p)" aria-label="Supprimer">
                    <Trash2 :size="18" color="#fff" :stroke-width="2" />
                  </button>
                </div>
              </div>
              <div class="gate-name">{{ p.name }}</div>
            </div>

            <button v-if="!editMode" class="gate-card add" @click="creating = true">
              <div class="gate-avatar add">
                <Plus :size="28" color="var(--text-muted)" :stroke-width="2" />
              </div>
              <div class="gate-name">Nouveau</div>
            </button>
          </div>

          <button class="manage-btn" @click="editMode = !editMode">
            {{ editMode ? 'Terminé' : 'Gérer les profils' }}
          </button>

          <button
            v-if="profile.activeId && profile.pickerVisible && !profile.needsPicker"
            class="cancel-btn"
            @click="profile.closePicker"
          >
            Annuler
          </button>
        </template>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.gate {
  position: fixed;
  inset: 0;
  /* Solid near-black regardless of the user's theme — same canvas as
   * the login gate, Spotify's profile/artist-picker look. */
  background: #0b0b0b;
  color: #ffffff;
  z-index: 100;
  display: grid;
  place-items: center;
  padding: calc(var(--safe-top) + 24px) 20px calc(var(--safe-bottom) + 24px);
  overflow-y: auto;
}

.gate-inner {
  width: 100%;
  max-width: 420px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 32px;
}

.gate-title {
  font: 800 24px/1.2 var(--font-display);
  color: #ffffff;
  margin: 0;
  letter-spacing: -0.4px;
}

.gate-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 26px 20px;
  width: 100%;
  justify-items: center;
}

.gate-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
}

/* Circular avatars — the "Choose artists" grid from Spotify's
 * onboarding, repurposed for profiles. */
.gate-avatar {
  width: 108px;
  height: 108px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 42px;
  font-weight: 800;
  color: #fff;
  font-family: var(--font-display);
  position: relative;
  overflow: hidden;
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}
.gate-card:active .gate-avatar { transform: scale(0.95); }
.gate-avatar.big {
  width: 124px;
  height: 124px;
  border-radius: 50%;
}
.gate-avatar.add {
  background: transparent;
  border: 2px dashed rgba(255, 255, 255, 0.25);
}

.gate-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.overlay-btn {
  background: rgba(255, 255, 255, 0.12);
  border: 0;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: grid;
  place-items: center;
}

.gate-name {
  font: 700 14px/1.3 var(--font-body);
  color: #ffffff;
}

.manage-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.3);
  color: #ffffff;
  padding: 11px 26px;
  border-radius: 999px;
  font: 700 13px/1.2 var(--font-display);
  cursor: pointer;
}
.manage-btn:active { border-color: #fff; transform: scale(0.97); }
.cancel-btn {
  background: transparent;
  border: 0;
  color: #7d8595;
  font-size: 13px;
  margin-top: -16px;
  padding: 8px 12px;
}

/* Create-profile form */
.gate-form {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 20px;
  width: 100%;
}

.gate-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.22);
  border: 0;
  color: #fff;
  padding: 14px 16px;
  border-radius: 6px;
  font: 600 16px/1.3 var(--font-body);
  text-align: center;
  outline: none;
}
.gate-input:focus { background: rgba(255, 255, 255, 0.3); }

.gate-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
}
.color-dot {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.08);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.color-dot.active {
  transform: scale(1.18);
  border-color: #fff;
}

.gate-form-actions {
  display: flex;
  gap: 12px;
}
.ghost-btn, .primary-btn {
  padding: 12px 26px;
  border-radius: 999px;
  font: 700 14px/1.2 var(--font-display);
  cursor: pointer;
  border: 0;
}
.ghost-btn { background: transparent; color: #fff; border: 1px solid rgba(255,255,255,0.3); }
.primary-btn { background: var(--accent); color: #0b0b0b; }
.primary-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.gate-fade-enter-active, .gate-fade-leave-active {
  transition: opacity 220ms ease;
}
.gate-fade-enter-from, .gate-fade-leave-to { opacity: 0; }
</style>
