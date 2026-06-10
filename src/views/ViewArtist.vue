<script setup>
import { computed, ref, watch, onMounted } from 'vue';
import { ArrowDownCircle, ListPlus, ListEnd, Sparkles, ListMusic, Plus } from 'lucide-vue-next';
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useStreamsStore } from '@/stores/streams';
import { useMixStore } from '@/stores/mix';
import { usePlaylistsStore } from '@/stores/playlists';
import { api, apiUrl } from '@/lib/api';
import { fmtDuration, gradientFromString, parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { showToast } from '@/lib/toast';
import { useActionSheetStore } from '@/stores/actionSheet';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';

const view = useViewStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const streams = useStreamsStore();
const mix = useMixStore();
const playlists = usePlaylistsStore();
const sheet = useActionSheetStore();

const artistName = computed(() => view.selectedArtist || '');
const photoOk = ref(true);
const photoUrl = computed(() =>
  artistName.value
    ? apiUrl(`/api/artist-photo/${encodeURIComponent(artistName.value)}`)
    : '',
);
watch(() => view.selectedArtist, () => {
  photoOk.value = true;
  loadRecs(artistName.value);
});

const libraryTracks = computed(() => lib.tracksByArtist(artistName.value));
const libQueueIds = computed(() => libraryTracks.value.map((t) => t.id));
const totalDuration = computed(() => libraryTracks.value.reduce((s, t) => s + (t.duration || 0), 0));
const bgGradient = computed(() => artistName.value ? gradientFromString(artistName.value) : '');

const meta = computed(() => {
  const n = libraryTracks.value.length;
  if (!n) return 'Artiste · Aucun titre dans ta bibliothèque';
  return `Artiste · ${n} titre${n > 1 ? 's' : ''} · ${fmtDuration(totalDuration.value)}`;
});

const recs = ref([]);
const loadingRecs = ref(false);
async function loadRecs(name) {
  if (!name) { recs.value = []; return; }
  loadingRecs.value = true;
  recs.value = [];
  try {
    const { results } = await api(`/api/search?q=${encodeURIComponent(name)}`);
    const artistKey = normalizeArtistKey(name);
    const libYtIds = new Set(lib.tracks.map((tr) => tr.ytId));
    const filtered = (results || [])
      .filter((r) => {
        const parsed = parseTrackTitle({ title: r.title, uploader: r.uploader });
        return normalizeArtistKey(parsed.artist) === artistKey;
      })
      .filter((r) => !libYtIds.has(r.id))
      .slice(0, 10);
    recs.value = filtered.map((r) => {
      const streamId = `stream-${r.id}`;
      let entry = streams.get(streamId);
      if (!entry) {
        entry = {
          id: streamId, title: r.title, uploader: r.uploader || '',
          duration: r.duration, thumbnail: r.thumbnail,
          file: `/api/stream/${r.id}`, ytId: r.id, isStream: true,
        };
        streams.set(streamId, entry);
      }
      return entry;
    });
  } catch {} finally { loadingRecs.value = false; }
}

const recQueueIds = computed(() => recs.value.map((t) => t.id));

const isCurrentContext = computed(() =>
  !!player.currentTrack && libQueueIds.value.includes(player.currentTrack.id),
);
const heroPlaying = computed(() => player.playing && isCurrentContext.value);
function onHeroPlay() {
  if (libQueueIds.value.length === 0) return;
  if (isCurrentContext.value) player.togglePlay();
  else player.playFromList(libQueueIds.value[0], libQueueIds.value);
}

function playLib(t) {
  player.playFromList(t.id, libQueueIds.value);
}
function playRec(t) {
  player.playFromList(t.id, recQueueIds.value);
}

function isFav(t) { return lib.isFavorite(t); }

async function onTrackMore(t) {
  try {
    const { index } = await sheet.open(
      [
        { name: t.file ? 'Disponible hors-ligne' : 'Télécharger', icon: ArrowDownCircle, disabled: !!t.file },
        { name: 'Ajouter à une playlist', icon: ListPlus },
        { name: 'Lancer un mix basé sur ce titre', icon: Sparkles },
        { name: 'Ajouter à la file', icon: ListEnd },
      ],
      { cover: t.thumbnail, title: t.title, subtitle: t.uploader },
    );
    if (index === 0 && !t.file) lib.downloadTrack(t.id);
    else if (index === 1) addTrackToPlaylistFlow(t);
    else if (index === 2) mix.streamFrom(t, () => view.switchTo('mix'));
    else if (index === 3) player.addToQueue(t.id);
  } catch {}
}

async function addTrackToPlaylistFlow(t) {
  const actions = [
    { name: 'Nouvelle playlist', icon: Plus, color: 'var(--accent)' },
    ...playlists.items.map((pl) => ({ name: pl.name, _id: pl.id, icon: ListMusic })),
  ];
  await new Promise((res) => setTimeout(res, 220));
  let pick;
  try {
    pick = await sheet.open(actions, { title: 'Ajouter à une playlist', subtitle: t.title });
  } catch { return; }
  if (pick.index === 0) {
    const pl = await playlists.create();
    if (pl) await playlists.addTrack(pl.id, t.id);
  } else {
    const pl = actions[pick.index];
    await playlists.addTrack(pl._id, t.id);
  }
}

async function addAllRecs() {
  for (const r of recs.value) {
    await lib.add(
      {
        id: r.ytId, ytId: r.ytId, title: r.title, uploader: r.uploader,
        duration: r.duration, thumbnail: r.thumbnail,
        url: `https://www.youtube.com/watch?v=${r.ytId}`,
      },
      { liked: true, silent: true },
    );
  }
  recs.value = [];
  showToast('Ajoutés à tes favoris');
}

onMounted(() => loadRecs(artistName.value));
</script>

<template>
  <div class="artist-view">
    <!-- Full-bleed photo banner with the name overlaid — Spotify's
         artist page header. -->
    <MobileHero
      :cover="photoOk ? photoUrl : ''"
      :bg-gradient="bgGradient"
      shape="banner"
      :title="artistName"
      :meta="meta"
      :show-play="libraryTracks.length > 0"
      :playing="heroPlaying"
      @play="onHeroPlay"
    />
    <!-- Hidden probe — `@error` on the hero img isn't exposed; trigger the
         fallback by loading the photo into a hidden <img> first. -->
    <img v-show="false" :src="photoUrl" @error="photoOk = false" />

    <section v-if="libraryTracks.length > 0" class="section">
      <div class="section-head">
        <h2>Dans ta bibliothèque</h2>
      </div>
      <div class="track-list">
        <MobileTrackCell
          v-for="t in libraryTracks"
          :key="t.id"
          :track="t"
          variant="thumb"
          :is-playing="player.currentTrack && player.currentTrack.id === t.id"
          :is-liked="isFav(t)"
          :download-progress="lib.libraryDownloads.get(t.id)?.progress ?? null"
          @play="playLib(t)"
          @like="lib.toggleFav(t)"
          @more="onTrackMore(t)"
        />
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Recommandé</h2>
        <button v-if="recs.length > 0" class="link-btn" @click="addAllRecs">Tout aimer</button>
      </div>
      <div v-if="loadingRecs" class="loading">
        <van-loading size="22" color="var(--accent)" />
      </div>
      <div v-else-if="recs.length === 0" class="empty-state small">
        <div class="hint">Pas d'autres titres trouvés pour cet artiste.</div>
      </div>
      <div v-else class="track-list">
        <MobileTrackCell
          v-for="t in recs"
          :key="t.id"
          :track="t"
          variant="thumb"
          :is-playing="player.currentTrack && player.currentTrack.id === t.id"
          :is-liked="false"
          :show-more="false"
          @play="playRec(t)"
          @like="lib.add({
            id: t.ytId, ytId: t.ytId, title: t.title, uploader: t.uploader,
            duration: t.duration, thumbnail: t.thumbnail,
            url: 'https://www.youtube.com/watch?v=' + t.ytId,
          }, { liked: true, silent: true })"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.artist-view { min-height: 100%; padding-bottom: 16px; }

.section { padding: 16px 0 8px; }
.section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0 16px 8px;
}
.section-head h2 {
  font: 700 20px/1.2 var(--font-display);
  letter-spacing: -0.3px;
  margin: 0;
  color: var(--text);
}
.link-btn {
  background: transparent;
  border: 0;
  color: var(--text-muted);
  font: 700 13px/1.2 var(--font-body);
  cursor: pointer;
}
.link-btn:active { color: var(--text); }
.empty-state.small { padding: 20px; }
.loading { display: flex; justify-content: center; padding: 16px; }
</style>
