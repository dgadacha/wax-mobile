<script setup>
import { computed, ref, watch, onMounted } from 'vue';
import { useViewStore } from '@/stores/view';
import { useLibraryStore } from '@/stores/library';
import { usePlayerStore } from '@/stores/player';
import { useStreamsStore } from '@/stores/streams';
import { api, apiUrl } from '@/lib/api';
import { fmtDuration, gradientFromString, parseTrackTitle, normalizeArtistKey } from '@/lib/format';
import { showToast } from '@/lib/toast';
import MobileHero from '@/components/MobileHero.vue';
import MobileTrackCell from '@/components/MobileTrackCell.vue';

const view = useViewStore();
const lib = useLibraryStore();
const player = usePlayerStore();
const streams = useStreamsStore();

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

const subtitle = computed(() => {
  const n = libraryTracks.value.length;
  if (!n) return 'Aucun titre dans ta bibliothèque';
  return `${n} titre${n > 1 ? 's' : ''} · ${fmtDuration(totalDuration.value)}`;
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

function playAll() {
  if (libQueueIds.value.length === 0) return;
  player.playFromList(libQueueIds.value[0], libQueueIds.value);
}

function playLib(t) {
  player.playFromList(t.id, libQueueIds.value);
}
function playRec(t) {
  player.playFromList(t.id, recQueueIds.value);
}

function isFav(t) { return lib.isFavorite(t); }

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
    <MobileHero
      :cover="photoOk ? photoUrl : ''"
      :bg-gradient="bgGradient"
      shape="circle"
      eyebrow="Artiste"
      :title="artistName"
      :subtitle="subtitle"
      :show-play="libraryTracks.length > 0"
      @play="playAll"
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
          v-for="(t, i) in libraryTracks"
          :key="t.id"
          :track="t"
          :index="i"
          variant="index"
          :is-playing="player.currentTrack && player.currentTrack.id === t.id"
          :is-liked="isFav(t)"
          :download-progress="lib.libraryDownloads.get(t.id)?.progress ?? null"
          @play="playLib(t)"
          @like="lib.toggleFav(t.id)"
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
          v-for="(t, i) in recs"
          :key="t.id"
          :track="t"
          :index="i"
          variant="thumb"
          :is-playing="player.currentTrack && player.currentTrack.id === t.id"
          :is-liked="false"
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
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  margin: 0;
  color: var(--text);
}
.link-btn {
  background: transparent;
  border: 0;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.empty-state.small { padding: 20px; }
.loading { display: flex; justify-content: center; padding: 16px; }
</style>
