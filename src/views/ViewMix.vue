<script setup>
import { computed } from 'vue';
import { Bookmark, Sparkles } from 'lucide-vue-next';
import { useLibraryStore } from '@/stores/library';
import { useMixStore } from '@/stores/mix';
import { useViewStore } from '@/stores/view';
import { useStreamsStore } from '@/stores/streams';
import { usePlayerStore } from '@/stores/player';
import { usePlaylistsStore } from '@/stores/playlists';
import { useActionSheetStore } from '@/stores/actionSheet';
import { gradientFromString, parseTrackTitle } from '@/lib/format';
import { showToast } from 'vant';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';

const mix = useMixStore();
const view = useViewStore();
const streams = useStreamsStore();
const player = usePlayerStore();
const lib = useLibraryStore();
const playlists = usePlaylistsStore();
const sheet = useActionSheetStore();

// Mix tracks are stream-* objects (isStream:true). `lib.toggleFav(t)`
// detects isStream and does the optimistic-add-favorite flow.
// `isLiked` cross-checks against the library by ytId since the stream
// id doesn't exist in lib.tracks.
function isLiked(t) {
  return !!t.ytId && lib.tracks.some((lt) => lt.ytId === t.ytId && lt.liked !== false);
}

const tracks = computed(() => {
  if (!mix.current) return [];
  return mix.current.queueIds
    .map((id) => streams.get(id))
    .filter(Boolean);
});

const queueIds = computed(() => mix.current?.queueIds || []);
const sourceTitle = computed(() => mix.current?.sourceTitle || 'Mix');
const cover = computed(() => tracks.value[0]?.thumbnail || '');
const bgGradient = computed(() => gradientFromString(sourceTitle.value));

const subtitle = computed(() => {
  const n = queueIds.value.length;
  if (!n) return '';
  return `${n} titres · Mix temporaire`;
});

function playAll() {
  if (queueIds.value.length === 0) return;
  player.queue = [...queueIds.value];
  player.index = 0;
  player.loadAndPlay();
}

function playTrack(t) {
  player.playFromList(t.id, queueIds.value);
}

function save() {
  mix.save((newPlaylistId) => view.switchTo('playlist', newPlaylistId));
}

// Resolve a mix stream-track to its library counterpart (matched by
// ytId). Returns null if the track hasn't been added to the library
// yet — the action sheet then offers stream-flavored actions instead
// of library ones.
function libTwin(t) {
  return t.ytId ? lib.tracks.find((lt) => lt.ytId === t.ytId) || null : null;
}

// Iso with the library more-menu (ViewLibrary.onMore) so behavior is
// predictable across views. For stream tracks not yet in the library
// we silently add them as un-liked metadata entries (same pattern as
// the sidebar drop target on desktop) before triggering "add to
// playlist" or "download" — the playlist/job APIs need a real
// library id to hang the reference on.
async function ensureLibraryEntry(t) {
  const existing = libTwin(t);
  if (existing) return existing;
  // lib.add returns the canonical track from the server (with the
  // server-minted id), which is what we need for downloadTrack /
  // playlist add. liked:false → won't pollute Favoris.
  return lib.add(
    {
      id: t.ytId,
      title: t.title,
      uploader: t.uploader,
      duration: t.duration,
      thumbnail: t.thumbnail,
      url: `https://www.youtube.com/watch?v=${t.ytId}`,
    },
    { liked: false, silent: true },
  );
}

async function addToPlaylistFlow(t) {
  const actions = [
    { name: '＋ Nouvelle playlist', color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id })),
  ];
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try { pick = await sheet.open(actions); } catch { return; }
  const target = await ensureLibraryEntry(t);
  if (!target) return;
  if (pick.index === 0) {
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, target.id);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, target.id);
  }
}

async function onTrackMore(t) {
  const twin = libTwin(t);
  const isDownloaded = !!twin?.file;
  try {
    const { index } = await sheet.open([
      { name: isDownloaded ? 'Disponible hors-ligne ✓' : 'Télécharger', disabled: isDownloaded },
      { name: 'Ajouter à une playlist' },
      { name: 'Ajouter à la file' },
      { name: 'Ouvrir l’artiste' },
    ]);
    if (index === 0 && !isDownloaded) {
      // Need a library row to download against — server's job API keys
      // off the library track id, not the YouTube id.
      const target = await ensureLibraryEntry(t);
      if (target) lib.downloadTrack(target.id);
    } else if (index === 1) addToPlaylistFlow(t);
    else if (index === 2) player.addToQueue(t.id);
    else if (index === 3) {
      const parsed = parseTrackTitle(t);
      const name = parsed.artist || t.uploader;
      if (name) view.switchTo('artist', name);
    }
  } catch { /* dismissed */ }
}
</script>

<template>
  <div v-if="mix.current" class="mix-view">
    <MobileHero
      :cover="cover"
      :bg-gradient="bgGradient"
      eyebrow="Mix"
      :title="`Mix : ${sourceTitle}`"
      :subtitle="subtitle"
      @play="playAll"
    >
      <template #actions>
        <button class="hero-icon-btn save" aria-label="Sauvegarder" @click="save">
          <Bookmark :size="16" :stroke-width="2.2" color="var(--bg)" />
          <span>Sauvegarder</span>
        </button>
      </template>
    </MobileHero>

    <div class="track-list">
      <MobileTrackCell
        v-for="(t, i) in tracks"
        :key="t.id"
        :track="t"
        :index="i"
        variant="thumb"
        :is-playing="player.currentTrack && player.currentTrack.id === t.id"
        :is-liked="isLiked(t)"
        :download-progress="lib.libraryDownloads.get(libTwin(t)?.id)?.progress ?? null"
        :is-offline="!!libTwin(t)?.file"
        @play="playTrack(t)"
        @like="lib.toggleFav(t)"
        @more="onTrackMore(t)"
      />
    </div>
  </div>
  <div v-else class="empty-state">
    <Sparkles class="icon" :size="48" :stroke-width="1.5" />
    <div class="label">Aucun mix en cours</div>
    <div class="hint">Lance un mix depuis le menu « … » d'un titre.</div>
  </div>
</template>

<style scoped>
.mix-view { min-height: 100%; padding-bottom: 16px; }
.hero-icon-btn.save {
  background: var(--accent);
  color: var(--bg);
  border-radius: 999px;
  padding: 8px 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  border: 0;
  width: auto;
  height: auto;
}
</style>
