let player = null;
let activeYoutubeVideoId = null; // Retain the same embedded player across segments of one video.
let libraryData = null;
let currentGroup = null;
let youtubeReady = false;
let currentMode = null; // youtube / html / null
const SKIP_VALUES = [-30, -15, -10, -5, -1, 1, 5, 10, 15, 30];
let skipButtonsTimer = null;
let currentSegment = null;
let advancingAfterEnded = false;
let segmentEndHandled = false;
let libraryLoadSequence = 0;
let activeWorkName = null;
let audioVisualizerAnimationId = null;
let audioWaveformData = null;
let audioVisualizerMedia = null;
const DEFAULT_PLAYBACK_RATE = 1.0;
let currentPlaybackRate = DEFAULT_PLAYBACK_RATE;


function normalizeWorkName(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim();
  if (name.toLowerCase().endsWith('.json')) name = name.slice(0, -5);
  // Keep Unicode names (including Hebrew); reject directories and traversal.
  if (!name || name === '.' || name === '..' || name.includes('/') ||
      name.includes('\\') || /[\x00-\x1f\x7f]/.test(name)) return null;
  return name;
}

function getInitialWorkName() {
  const name = new URLSearchParams(window.location.search).get('data');
  return normalizeWorkName(name) || 'choir-example';
}

function workFileUrl(name) {
  const validName = normalizeWorkName(name);
  return validName ? `data/${encodeURIComponent(validName)}.json?v=${Date.now()}` : null;
}

async function setupWorkSelector() {
  const select = document.getElementById('workSelector');
  const initial = getInitialWorkName();
  let works = [];
  try {
    const response = await fetch(`data/works.json?v=${Date.now()}`);
    if (response.ok) {
      const manifest = await response.json();
      const entries = Array.isArray(manifest) ? manifest : manifest.works;
      if (Array.isArray(entries)) {
        works = entries.map(item => typeof item === 'string'
          ? {id: item, title: item} : {id: item.id, title: item.title || item.id})
          .map(item => ({id: normalizeWorkName(item.id), title: item.title}))
          .filter(item => item.id !== null);
      }
    }
  } catch (err) {
    console.info('Works index unavailable; single-work fallback.', err);
  }
  if (!works.some(work => work.id === initial)) {
    works.unshift({id: initial, title: initial});
  }
  select.replaceChildren();
  for (const work of works) {
    const option = document.createElement('option');
    option.value = work.id;
    option.textContent = work.title;
    select.appendChild(option);
  }
  select.value = initial;
  select.addEventListener('change', async () => {
    const previous = activeWorkName;
    if (!await loadLibraryData(select.value)) {
      select.value = previous || initial;
    } else {
      const url = new URL(window.location.href);
      url.searchParams.set('data', select.value);
      window.history.replaceState(null, '', url);
    }
  });
  await loadLibraryData(initial);
}

async function loadLibraryData(name = getInitialWorkName()) {
  const url = workFileUrl(name);
  if (!url) return false;
  const requestNumber = ++libraryLoadSequence;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Cannot load ${url}`);
    const loaded = await response.json();
    if (requestNumber !== libraryLoadSequence) return false;
    if (!loaded || !loaded.segments || !Array.isArray(loaded.groups)) {
      throw new Error('Invalid library structure');
    }
    clearPlayer();
    currentSegment = null;
    segmentEndHandled = false;
    libraryData = loaded;
    activeWorkName = name;
    currentGroup = null;
    document.getElementById('libraryTitle').textContent = loaded.libraryTitle || 'ספריית וידאו';
    document.getElementById('currentTitle').textContent = 'בחר קול ולאחר מכן בחר קטע';
    // Reflect the actual title from the JSON, even if the index is stale.
    const option = [...document.getElementById('workSelector').options].find(o => o.value === name);
    if (option) option.textContent = loaded.libraryTitle || option.textContent;
    renderGroupButtons();
    renderSegmentButtons();
    initMobileMode();
    createSkipButtons();
    startSkipButtonsUpdater();
    setupPlaybackOptions();
    setupPlaybackSpeed();
    return true;
  } catch (error) {
    if (requestNumber === libraryLoadSequence) {
      document.getElementById('currentTitle').textContent = `שגיאה בטעינת קובץ הנתונים: ${url}`;
      console.error(error);
    }
    return false;
  }
}

function onYouTubeIframeAPIReady() {
  youtubeReady = true;
}

function renderGroupButtons() {
  const container = document.getElementById('groupButtons');
  const secondContainer = document.getElementById('groupButtons2');
  const allGroups = [
    ...(libraryData.groups || []),
    ...(libraryData.groups2 || [])
  ];

  container.innerHTML = '';
  secondContainer.innerHTML = '';
  secondContainer.style.display = 'none';
  container.style.setProperty('--group-columns', 5);

  const visibleGroups = allGroups
    .filter(group => hasGroupContent(group.id))
    .map(group => ({
      group,
      position: getGroupMatrixPosition(group)
    }))
    .filter(item => item.position);

  // דוחסים את שורות הקולות הרגילים: שורה שאין בה אף קול אינה תופסת מקום.
  const regularRanks = [...new Set(
    visibleGroups
      .filter(item => item.position.kind === 'regular')
      .map(item => item.position.rank)
  )].sort((a, b) => a - b);

  const regularRowByRank = new Map(
    regularRanks.map((rank, index) => [rank, index + 1])
  );

  const hasAll = visibleGroups.some(item => item.position.kind === 'all');
  const hasSoloRow = visibleGroups.some(item => item.position.kind === 'solo');

  // "כולם" מוצג בשורת הקולות הרגילה הראשונה.
  // כשאין כלל קולות רגילים, הוא נשאר בשורה הראשונה.
  const allRow = regularRanks.length > 0 ? 1 : 1;

  // שורת הסולנים תמיד אחרונה, לאחר כל שורות הקולות הרגילים.
  // כשאין קולות רגילים אך יש "כולם", הסולנים עוברים לשורה 2.
  const soloRow = regularRanks.length > 0
    ? regularRanks.length + 1
    : (hasAll ? 2 : 1);

  visibleGroups.forEach(({ group, position }) => {
    let row;

    if (position.kind === 'all') {
      row = allRow;
    } else if (position.kind === 'solo') {
      row = soloRow;
    } else {
      row = regularRowByRank.get(position.rank);
    }

    if (!row) {
      return;
    }

    const btn = document.createElement('button');

    // כפתורי קולות הסולו מוצגים תמיד בשתי שורות קבועות,
    // ללא תלות ברוחב המסך או בשבירת שורה אוטומטית.
    if (position.kind === 'solo' && position.column > 1) {
      const soloVoiceByColumn = {
        2: 'סופרן',
        3: 'אלט',
        4: 'טנור',
        5: 'בס'
      };

      const voiceLine = document.createElement('span');
      voiceLine.textContent = soloVoiceByColumn[position.column] || group.label;
      voiceLine.style.display = 'block';

      const soloLine = document.createElement('span');
      soloLine.textContent = 'סולו';
      soloLine.style.display = 'block';

      btn.appendChild(voiceLine);
      btn.appendChild(soloLine);
    } else {
      btn.textContent = group.label;
    }

    btn.style.gridColumn = String(position.column);
    btn.style.gridRow = String(row);

    if (group.id === currentGroup) {
      btn.classList.add('active');
    }

    btn.onclick = function () {
      currentGroup = group.id;
      currentSegment = null;
      clearPlayer();

      document.getElementById('currentTitle').textContent =
        'בחר קטע מהרשימה';

      renderGroupButtons();
      renderSegmentButtons();
      showMobileMenu();
    };

    container.appendChild(btn);
  });
}

function getGroupMatrixPosition(group) {
  const label = String(group.label || '').trim();
  const id = String(group.id || '').trim().toLowerCase();

  if (label === 'כולם' || id === 'all') {
    return { column: 1, kind: 'all' };
  }

  if (label === 'סולנים' || id === 'solos') {
    return { column: 1, kind: 'solo' };
  }

  const soloDefinitions = [
    { column: 2, hebrew: 'סופרן', ids: ['sopsoli', 'sopranosolo', 'sopranosoli'] },
    { column: 3, hebrew: 'אלט', ids: ['altsoli', 'altosolo', 'altosoli'] },
    { column: 4, hebrew: 'טנור', ids: ['tensoli', 'tenorsolo', 'tenorsoli'] },
    { column: 5, hebrew: 'בס', ids: ['basssoli', 'basssolo', 'basssolos'] }
  ];

  for (const voice of soloDefinitions) {
    const isSoloLabel = new RegExp(
      `^${escapeRegExp(voice.hebrew)}\\s+סולו$`
    ).test(label);

    if (isSoloLabel || voice.ids.includes(id)) {
      return { column: voice.column, kind: 'solo' };
    }
  }

  const voiceDefinitions = [
    { column: 2, hebrew: 'סופרן', ids: ['soprano', 'sopran', 'sonprano'] },
    { column: 3, hebrew: 'אלט', ids: ['alto', 'alt'] },
    { column: 4, hebrew: 'טנור', ids: ['tenor'] },
    { column: 5, hebrew: 'בס', ids: ['bass', 'base'] }
  ];

  for (const voice of voiceDefinitions) {
    const labelMatch = label.match(
      new RegExp(`^${escapeRegExp(voice.hebrew)}(?:\\s*(\\d+))?$`)
    );

    let number = null;

    if (labelMatch) {
      number = labelMatch[1] ? Number(labelMatch[1]) : 0;
    } else {
      for (const baseId of voice.ids) {
        const idMatch = id.match(
          new RegExp(`^${escapeRegExp(baseId)}[\\s._-]*(\\d*)$`)
        );
        if (idMatch) {
          number = idMatch[1] ? Number(idMatch[1]) : 0;
          break;
        }
      }
    }

    if (number !== null && Number.isFinite(number)) {
      return {
        column: voice.column,
        kind: 'regular',
        rank: number
      };
    }
  }

  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasGroupContent(groupId) {
  const segments = libraryData.segments[groupId] || [];
  return segments.length > 0;
}

function renderSegmentButtons() {
  const title = document.getElementById('segmentsTitle');
  const container = document.getElementById('segmentButtons');
  container.innerHTML = '';
  container.classList.remove('segment-buttons-ltr');

  if (!currentGroup) {
    title.textContent = 'בחר קול';
    return;
  }

  title.textContent = 'קטעים';

  const segments = libraryData.segments[currentGroup] || [];

  if (segments.length === 0) {
    title.textContent = 'אין קטעים בקבוצה זו';
    return;
  }

  if (segments[0] && segments[0].ltr !== false) {
    container.classList.add('segment-buttons-ltr');
  }

  segments.forEach(segment => {
    const btn = document.createElement('button');
    btn.className = 'segment-button';
    btn.textContent = segment.title;

    applySegmentNumberColor(btn, segment);

    if (currentSegment === segment) {
      btn.classList.add('active');
    }

    applyTextDirection(btn, segment);

    btn.onclick = function () {
      loadSegment(segment, true);
    };

    container.appendChild(btn);
  });
}

function applySegmentNumberColor(button, segment) {
  const title = String(segment.title || '');
  const match = title.match(/^\s*(\d+)/);

  if (!match) {
    return;
  }

  const number = Number(match[1]);

  if (!Number.isFinite(number)) {
    return;
  }

const colors = [
  '#dbeafe', // כחול
  '#dcfce7', // ירוק
  '#fef3c7', // צהוב
  '#fde2e8', // ורוד
  '#e9d5ff', // סגול
  '#fed7aa', // כתום
  '#bfdbfe', // כחול חזק יותר
  '#bbf7d0', // ירוק חזק יותר
  '#fde68a', // צהוב חזק יותר
  '#fbcfe8', // ורוד חזק יותר
  '#ddd6fe', // סגול חזק יותר
  '#fdba74'  // כתום חזק יותר
];

  button.classList.add('segment-numbered');
  button.style.setProperty(
    '--segment-group-bg',
    colors[(number - 1) % colors.length]
  );
}

function applyTextDirection(element, segment) {
  const isLtr = segment.ltr !== false;

  if (isLtr) {
    element.style.direction = 'ltr';
    element.style.textAlign = 'left';
  } else {
    element.style.direction = 'rtl';
    element.style.textAlign = 'right';
  }
}

function loadSegment(segment, autoplay) {
  const isDifferentSegment = currentSegment !== segment;
  currentSegment = segment;
  segmentEndHandled = false;

  if (isDifferentSegment) {
    resetPlaybackSpeed();
  }

  renderSegmentButtons();
  const currentTitle = document.getElementById('currentTitle');

  const groupLabel = getCurrentGroupLabel();
  currentTitle.textContent = groupLabel
    ? `${groupLabel} -----> ${segment.title}`
    : segment.title;

  applyTextDirection(currentTitle, segment);

  const source = segment.source || 'youtube';

  if (source === 'youtube') {
    loadYouTubeSegment(segment, autoplay);
    return;
  }

  if (source === 'gdrive') {
    loadHtmlMedia(
      getGoogleDriveDirectUrl(segment.fileId),
      autoplay,
      getSegmentMediaType(segment),
      Number(segment.start) || 0
    );
    showMobilePlayer();
    return;
  }

  if (source === 'url') {
    loadHtmlMedia(
      segment.url,
      autoplay,
      getSegmentMediaType(segment),
      Number(segment.start) || 0
    );
    showMobilePlayer();
    return;
  }

  currentTitle.innerHTML =
    `<span class="error">סוג מקור לא נתמך: ${source}</span>`;
}

function getSegmentMediaType(segment) {
  const explicitType = String(segment.type || segment.mediaType || '').toLowerCase();

  if (explicitType === 'audio' || explicitType === 'video') {
    return explicitType;
  }

  const url = String(segment.url || segment.fileName || '').toLowerCase().split('?')[0];

  if (url.match(/\.(mp3|wav|m4a|aac|ogg|oga|flac)$/)) {
    return 'audio';
  }

  return 'video';
}

function loadYouTubeSegment(segment, autoplay) {
  if (!window.YT || typeof YT.Player !== 'function') {
    document.getElementById('currentTitle').innerHTML =
      '<span class="error">נגן YouTube עדיין נטען, נסה שוב בעוד רגע</span>';
    return;
  }

  youtubeReady = true;
  ensureYouTubeContainer();

  const videoId = segment.videoId;
  const startSeconds = Number(segment.start) || 0;

  if (!player) {
    activeYoutubeVideoId = videoId;
    player = new YT.Player('player', {
      videoId: videoId,
      playerVars: {
        start: startSeconds,
        rel: 0,
        modestbranding: 1,
        autoplay: autoplay ? 1 : 0
      },
      events: {
        onReady: () => applyPlaybackSpeed(),
        onStateChange: onYouTubePlayerStateChange
      }
    });
  } else if (activeYoutubeVideoId === videoId) {
    // Switching segments inside the same YouTube video must not reload it.
    // A seek preserves the existing iframe and playback session.
    player.seekTo(startSeconds, true);
    if (autoplay) {
      player.playVideo();
    } else {
      player.pauseVideo();
    }
  } else {
    activeYoutubeVideoId = videoId;
    if (autoplay) {
      player.loadVideoById({ videoId: videoId, startSeconds: startSeconds });
    } else {
      player.cueVideoById({ videoId: videoId, startSeconds: startSeconds });
    }
    setTimeout(() => applyPlaybackSpeed(), 0);
  }

  currentMode = 'youtube';
  showMobilePlayer();
}

function loadHtmlMedia(mediaUrl, autoplay, mediaType, startSeconds) {
  const wrapper = document.getElementById('videoWrapper');

  stopCurrentVideo();
  wrapper.innerHTML = '';
  player = null;
  activeYoutubeVideoId = null;

  wrapper.classList.toggle('audio-wrapper', mediaType === 'audio');

  const media = document.createElement(mediaType === 'audio' ? 'audio' : 'video');
  media.id = 'htmlVideo';
  media.controls = true;
  media.src = mediaUrl;
  media.playbackRate = currentPlaybackRate;

  if (mediaType === 'audio') {
    media.className = 'audio-player';
  }

  if (autoplay) {
    media.autoplay = true;
  }

  media.addEventListener('loadedmetadata', () => {
    if (startSeconds && startSeconds > 0 && startSeconds < media.duration) {
      media.currentTime = startSeconds;
    }

    updateSkipButtons();
  });

  media.addEventListener('timeupdate', () => { updateSkipButtons(); checkSegmentEnd(); });
  media.addEventListener('ended', handleSegmentEnded);

  wrapper.appendChild(media);

  if (mediaType === 'audio') {
    addAudioVolumeControl(wrapper, media);
  }

  currentMode = 'html';
}

function addAudioVolumeControl(wrapper, media) {
  const control = document.createElement('div');
  control.className = 'audio-volume-control';

  const label = document.createElement('span');
  label.textContent = 'עוצמה';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '1';
  slider.step = '0.01';
  slider.value = String(media.volume);
  slider.setAttribute('aria-label', 'עוצמת קול');

  const value = document.createElement('span');
  value.className = 'audio-volume-value';
  value.textContent = `${Math.round(media.volume * 100)}%`;

  slider.addEventListener('input', () => {
    media.volume = Number(slider.value);
    media.muted = media.volume === 0;
    value.textContent = `${Math.round(media.volume * 100)}%`;
  });

  control.appendChild(label);
  control.appendChild(slider);
  control.appendChild(value);
  wrapper.appendChild(control);
}


function loadHtmlVideo(videoUrl, autoplay) {
  loadHtmlMedia(videoUrl, autoplay, 'video', 0);
}

function ensureYouTubeContainer() {
  const wrapper = document.getElementById('videoWrapper');

  if (currentMode !== 'youtube') {
    wrapper.classList.remove('audio-wrapper');
    wrapper.innerHTML = '<div id="player"></div>';
    player = null;
    activeYoutubeVideoId = null;
  }
}

function clearPlayer() {
  stopCurrentVideo();

  const wrapper = document.getElementById('videoWrapper');
  wrapper.classList.remove('audio-wrapper');
  wrapper.innerHTML = '<div id="player"></div>';

  player = null;
  activeYoutubeVideoId = null;
  currentMode = null;
}

function stopCurrentVideo() {
  if (currentMode === 'youtube' && player && typeof player.stopVideo === 'function') {
    player.stopVideo();
  }

  if (currentMode === 'html') {
    const video = document.getElementById('htmlVideo');
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }
}

function getGoogleDriveDirectUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

function isMobileView() {
  return window.matchMedia('(max-width: 800px)').matches;
}

function showMobileMenu() {
  if (!isMobileView()) {
    return;
  }

  document.body.classList.remove('mobile-player-mode');
  document.body.classList.add('mobile-menu-mode');
}

function showMobilePlayer() {
  if (!isMobileView()) {
    return;
  }

  document.body.classList.remove('mobile-menu-mode');
  document.body.classList.add('mobile-player-mode');
}

function initMobileMode() {
  document.body.classList.remove('mobile-menu-mode');
  document.body.classList.remove('mobile-player-mode');

  if (isMobileView()) {
    document.body.classList.add('mobile-player-mode');
  }
}

function isInsideIframe() {
  try {
    return window.self !== window.top;
  } catch (e) {
    return true;
  }
}

function setupOpenFullButton() {
  const btn = document.getElementById('openFullBtn');

  if (!btn) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const returnUrl = params.get('return');

  btn.style.display = 'none';
  btn.onclick = null;

  if (isInsideIframe()) {
    btn.style.display = '';
    btn.textContent = 'פתח במסך מלא';

    btn.onclick = function () {
      const currentUrl = new URL(window.location.href);

      if (
        document.referrer &&
        document.referrer.startsWith('https://sites.google.com/')
      ) {
        currentUrl.searchParams.set('return', document.referrer);
      }

      window.open(currentUrl.toString(), '_blank');
    };

    return;
  }

  if (
    returnUrl &&
    returnUrl.startsWith('https://sites.google.com/')
  ) {
    btn.style.display = '';
    btn.textContent = 'חזרה לאתר המקהלה';

    btn.onclick = function () {
      window.location.href = returnUrl;
    };
  }
}

function setupPlaybackOptions() {
  const playAll = document.getElementById('playAllCheckbox');
  const repeatOne = document.getElementById('repeatSegmentCheckbox');

  if (playAll) {
    playAll.checked = false;
  }

  if (repeatOne) {
    repeatOne.checked = false;
  }
}

function formatPlaybackRate(rate) {
  const numericRate = Number(rate);

  if (Number.isInteger(numericRate)) {
    return numericRate.toFixed(1);
  }

  return String(numericRate);
}

function updatePlaybackSpeedDisplay() {
  const slider = document.getElementById('playbackSpeedRange');
  const value = document.getElementById('playbackSpeedValue');

  if (slider) {
    slider.value = String(currentPlaybackRate);
  }

  if (value) {
    value.textContent = `${formatPlaybackRate(currentPlaybackRate)}×`;
  }
}

function applyPlaybackSpeed() {
  if (
    currentMode === 'youtube' &&
    player &&
    typeof player.setPlaybackRate === 'function'
  ) {
    player.setPlaybackRate(currentPlaybackRate);
  }

  if (currentMode === 'html') {
    const media = document.getElementById('htmlVideo');

    if (media) {
      media.playbackRate = currentPlaybackRate;
    }
  }
}

function setPlaybackSpeed(rate) {
  const parsed = Number(rate);

  if (!Number.isFinite(parsed)) {
    return;
  }

  currentPlaybackRate = Math.min(2.0, Math.max(0.5, parsed));
  updatePlaybackSpeedDisplay();
  applyPlaybackSpeed();
}

function resetPlaybackSpeed() {
  currentPlaybackRate = DEFAULT_PLAYBACK_RATE;
  updatePlaybackSpeedDisplay();
  applyPlaybackSpeed();
}

function setupPlaybackSpeed() {
  const slider = document.getElementById('playbackSpeedRange');

  currentPlaybackRate = DEFAULT_PLAYBACK_RATE;
  updatePlaybackSpeedDisplay();

  if (!slider) {
    return;
  }

  slider.addEventListener('input', () => {
    setPlaybackSpeed(slider.value);
  });
}
function isPlayAllEnabled() {
  const checkbox = document.getElementById('playAllCheckbox');
  return !!(checkbox && checkbox.checked);
}

function isRepeatSegmentEnabled() {
  const checkbox = document.getElementById('repeatSegmentCheckbox');
  return !!(checkbox && checkbox.checked);
}

function getCurrentGroupSegments() {
  if (!libraryData || !currentGroup) {
    return [];
  }

  return libraryData.segments[currentGroup] || [];
}

function getCurrentSegmentIndex() {
  const segments = getCurrentGroupSegments();
  return segments.indexOf(currentSegment);
}

// `end` is an absolute position in seconds. -1 or absent means no explicit stop.
// Older JSON files remain valid and retain full-media playback.
function getConfiguredSegmentEnd() {
  if (!currentSegment || currentSegment.end === undefined || currentSegment.end === null || currentSegment.end === '') return null;
  const end = Number(currentSegment.end);
  const start = Number(currentSegment.start) || 0;
  return Number.isFinite(end) && end > start ? end : null;
}

function checkSegmentEnd() {
  if (!currentSegment || segmentEndHandled || advancingAfterEnded) return;
  const end = getConfiguredSegmentEnd();
  if (end === null || currentMode === null) return;
  const current = getCurrentVideoTime();
  // Do not trigger while the player has not reached the segment start yet.
  if (!Number.isFinite(current) || current < end - 0.15) return;
  segmentEndHandled = true;
  // Keep NEW's original play-all/repeat priority, otherwise pause at end.
  if (isPlayAllEnabled() || isRepeatSegmentEnabled()) {
    handleSegmentEnded();
  } else if (currentMode === 'youtube' && player && typeof player.pauseVideo === 'function') {
    player.pauseVideo();
  } else if (currentMode === 'html') {
    const media = document.getElementById('htmlVideo');
    if (media) media.pause();
  }
}

function handleSegmentEnded() {
  if (advancingAfterEnded) {
    return;
  }

  advancingAfterEnded = true;

  try {
    if (isPlayAllEnabled()) {
      playNextSegmentInGroup(isRepeatSegmentEnabled());
      return;
    }

    if (isRepeatSegmentEnabled() && currentSegment) {
      loadSegment(currentSegment, true);
    }
  } finally {
    setTimeout(() => {
      advancingAfterEnded = false;
    }, 250);
  }
}

function playNextSegmentInGroup(loopToFirst) {
  const segments = getCurrentGroupSegments();
  const currentIndex = getCurrentSegmentIndex();

  if (!segments.length || currentIndex < 0) {
    return;
  }

  const nextIndex = currentIndex + 1;

  if (nextIndex < segments.length) {
    loadSegment(segments[nextIndex], true);
    return;
  }

  if (loopToFirst) {
    loadSegment(segments[0], true);
  }
}

function onYouTubePlayerStateChange(event) {
  if (window.YT && event.data === YT.PlayerState.ENDED) {
    handleSegmentEnded();
  }
}

function getCurrentGroupLabel() {
  const allGroups = [
    ...(libraryData.groups || []),
    ...(libraryData.groups2 || [])
  ];

  const group = allGroups.find(g => g.id === currentGroup);
  return group ? group.label : '';
}

function createSkipButtons() {
  const container = document.getElementById('skipButtons');

  if (!container) {
    return;
  }

  container.innerHTML = '';

  const positiveRow = document.createElement('div');
  positiveRow.className = 'skip-row skip-positive';

  const negativeRow = document.createElement('div');
  negativeRow.className = 'skip-row skip-negative';

  SKIP_VALUES
    .filter(seconds => seconds > 0)
    .forEach(seconds => {
      const btn = document.createElement('button');

      btn.textContent = `+${seconds}`;
      btn.dataset.skip = seconds;

      btn.onclick = function () {
        skipVideo(seconds);
      };

      positiveRow.appendChild(btn);
    });

  const endBtn = document.createElement('button');
  endBtn.textContent = '>>|';
  endBtn.className = 'skip-end';
  endBtn.onclick = jumpToEnd;
  positiveRow.appendChild(endBtn);

  const startBtn = document.createElement('button');
  startBtn.textContent = '|<<';
  startBtn.className = 'skip-start';
  startBtn.onclick = jumpToStart;
  negativeRow.appendChild(startBtn);

  SKIP_VALUES
    .filter(seconds => seconds < 0)
    .forEach(seconds => {
      const btn = document.createElement('button');

      btn.textContent = `${seconds}`;
      btn.dataset.skip = seconds;

      btn.onclick = function () {
        skipVideo(seconds);
      };

      negativeRow.appendChild(btn);
    });

  container.appendChild(negativeRow);
  container.appendChild(positiveRow);

  updateSkipButtons();
}

function getCurrentVideoTime() {
  if (currentMode === 'youtube' &&
      player &&
      typeof player.getCurrentTime === 'function') {
    return player.getCurrentTime();
  }

  if (currentMode === 'html') {
    const video = document.getElementById('htmlVideo');
    if (video) {
      return video.currentTime;
    }
  }

  return 0;
}

function getVideoDuration() {
  if (currentMode === 'youtube' &&
      player &&
      typeof player.getDuration === 'function') {
    return player.getDuration();
  }

  if (currentMode === 'html') {
    const video = document.getElementById('htmlVideo');
    if (video && !isNaN(video.duration)) {
      return video.duration;
    }
  }

  return 0;
}

function skipVideo(seconds) {
  const current = getCurrentVideoTime();
  const duration = getVideoDuration();

  if (!duration) {
    return;
  }

  let target = current + seconds;

  target = Math.max(0, target);
  target = Math.min(duration, target);

  if (currentMode === 'youtube') {
    player.seekTo(target, true);
  }

  if (currentMode === 'html') {
    const video = document.getElementById('htmlVideo');

    if (video) {
      video.currentTime = target;
    }
  }

  updateSkipButtons();
}

function jumpToStart() {
  if (currentMode === 'youtube') {
    player.seekTo(0, true);
  }

  if (currentMode === 'html') {
    const video = document.getElementById('htmlVideo');

    if (video) {
      video.currentTime = 0;
    }
  }

  updateSkipButtons();
}

function jumpToEnd() {
  const duration = getVideoDuration();

  if (!duration) {
    return;
  }

  if (currentMode === 'youtube') {
    player.seekTo(duration, true);
  }

  if (currentMode === 'html') {
    const video = document.getElementById('htmlVideo');

    if (video) {
      video.currentTime = duration;
    }
  }

  updateSkipButtons();
}

function updateSkipButtons() {
  const container = document.getElementById('skipButtons');

  if (!container) {
    return;
  }

  const current = getCurrentVideoTime();
  const duration = getVideoDuration();

  const buttons = container.querySelectorAll('button[data-skip]');

  buttons.forEach(btn => {
    const skip = Number(btn.dataset.skip);

    if (!duration) {
      btn.disabled = true;
      return;
    }

    const target = current + skip;

    btn.disabled =
      target < 0 ||
      target > duration;
  });

  const startBtn = container.querySelector('.skip-start');
  const endBtn = container.querySelector('.skip-end');

  if (startBtn) {
    startBtn.disabled = !duration || current <= 0;
  }

  if (endBtn) {
    endBtn.disabled = !duration || current >= duration;
  }
}

function startSkipButtonsUpdater() {
  if (skipButtonsTimer) {
    clearInterval(skipButtonsTimer);
  }

  skipButtonsTimer = setInterval(() => { updateSkipButtons(); checkSegmentEnd(); }, 250);
}

function parseTimeString(text) {

  text = text.trim();

  const parts = text.split(':').map(Number);

  if (parts.some(isNaN)) {
    return null;
  }

  if (parts.length === 1) {
    return parts[0];
  }

  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  if (parts.length === 3) {
    return (
      parts[0] * 3600 +
      parts[1] * 60 +
      parts[2]
    );
  }

  return null;
}

function jumpToExactTime() {

  const input =
    document.getElementById('jumpToTimeInput');

  if (!input) {
    return;
  }

  const seconds =
    parseTimeString(input.value);

  if (seconds === null) {
    return;
  }

  const duration = getVideoDuration();

  if (!duration) {
    return;
  }

  const target =
    Math.max(0, Math.min(duration, seconds));

  if (currentMode === 'youtube') {
    player.seekTo(target, true);
  }

  if (currentMode === 'html') {
    const video =
      document.getElementById('htmlVideo');

    if (video) {
      video.currentTime = target;
    }
  }

  updateSkipButtons();
}

document.addEventListener('DOMContentLoaded', () => {

  const btn =
    document.getElementById('jumpToTimeBtn');

  const input =
    document.getElementById('jumpToTimeInput');

  if (btn) {
    btn.onclick = jumpToExactTime;
  }

  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        jumpToExactTime();
      }
    });
  }
});

setupOpenFullButton();
setupWorkSelector();