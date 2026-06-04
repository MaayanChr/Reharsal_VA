let player = null;
let libraryData = null;
let currentGroup = null;
let youtubeReady = false;
let currentMode = null; // youtube / html / null
const SKIP_VALUES = [-30, -15, -10, -5, -1, 1, 5, 10, 15, 30];
let skipButtonsTimer = null;
let currentSegment = null;
let advancingAfterEnded = false;
let audioContext = null;
let audioAnalyser = null;
let audioSourceNode = null;
let audioVisualizerAnimationId = null;

function getDataFileName() {
  const params = new URLSearchParams(window.location.search);
  const dataName = params.get('data') || 'choir-example';

  if (dataName.includes('/') || dataName.includes('\\') || dataName.includes('..')) {
    return 'choir-example.json';
  }

  return `${dataName}.json`;
}

async function loadLibraryData() {
  const fileName = getDataFileName();
  const url = `data/${fileName}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Cannot load ${url}`);
    }

    libraryData = await response.json();
    currentGroup = null;

    document.getElementById('libraryTitle').textContent =
      libraryData.libraryTitle || 'ספריית וידאו';

    document.getElementById('currentTitle').textContent =
      'בחר קול ולאחר מכן בחר קטע';

    clearPlayer();
    renderGroupButtons();
    renderSegmentButtons();
    initMobileMode();
	createSkipButtons();
	startSkipButtonsUpdater();
    setupPlaybackOptions();

  } catch (error) {
    document.getElementById('currentTitle').innerHTML =
      `<span class="error">שגיאה בטעינת קובץ הנתונים: ${url}</span>`;
    console.error(error);
  }
}

function onYouTubeIframeAPIReady() {
  youtubeReady = true;
}

function renderGroupButtons() {
  renderGroupRow('groupButtons', libraryData.groups || [], false);
  renderGroupRow('groupButtons2', libraryData.groups2 || [], true);
}

function renderGroupRow(containerId, groups, hideIfAllEmpty) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  const hasAnyContent = groups.some(group => hasGroupContent(group.id));

  if (hideIfAllEmpty && !hasAnyContent) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';

  groups.forEach(group => {
    const btn = document.createElement('button');
    btn.textContent = group.label;

    const hasContent = hasGroupContent(group.id);
    btn.disabled = !hasContent;

    if (group.id === currentGroup) {
      btn.classList.add('active');
    }

    btn.onclick = function () {
      if (!hasContent) {
        return;
      }

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

function hasGroupContent(groupId) {
  const segments = libraryData.segments[groupId] || [];
  return segments.length > 0;
}

function renderSegmentButtons() {
  const container = document.getElementById('segmentButtons');
  container.innerHTML = '';

  if (!currentGroup) {
    container.textContent = 'בחר קול';
    return;
  }

  const segments = libraryData.segments[currentGroup] || [];

  if (segments.length === 0) {
    container.textContent = 'אין קטעים בקבוצה זו';
    return;
  }

  segments.forEach(segment => {
    const btn = document.createElement('button');
    btn.className = 'segment-button';
    btn.textContent = segment.title;
	
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
  currentSegment = segment;
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
    player = new YT.Player('player', {
      videoId: videoId,
      playerVars: {
        start: startSeconds,
        rel: 0,
        modestbranding: 1,
        autoplay: autoplay ? 1 : 0
      },
      events: {
        onStateChange: onYouTubePlayerStateChange
      }
    });
  } else {
    player.loadVideoById({
      videoId: videoId,
      startSeconds: startSeconds
    });
  }

  currentMode = 'youtube';
  showMobilePlayer();
}

function loadHtmlMedia(mediaUrl, autoplay, mediaType, startSeconds) {
  const wrapper = document.getElementById('videoWrapper');

  stopCurrentVideo();
  destroyAudioVisualizer();
  wrapper.innerHTML = '';

  wrapper.classList.toggle('audio-wrapper', mediaType === 'audio');

  const media = document.createElement(mediaType === 'audio' ? 'audio' : 'video');
  media.id = 'htmlVideo';
  media.controls = true;
  media.src = mediaUrl;

  if (mediaType === 'audio') {
    media.className = 'audio-player';

    const visualizer = document.createElement('canvas');
    visualizer.id = 'audioVisualizer';
    visualizer.className = 'audio-visualizer';
    visualizer.setAttribute('aria-label', 'תצוגת עוצמת שמע');
    wrapper.appendChild(visualizer);
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

  media.addEventListener('timeupdate', updateSkipButtons);
  media.addEventListener('ended', handleSegmentEnded);

  wrapper.appendChild(media);
  currentMode = 'html';

  if (mediaType === 'audio') {
    initAudioVisualizer(media);
  }
}

function loadHtmlVideo(videoUrl, autoplay) {
  loadHtmlMedia(videoUrl, autoplay, 'video', 0);
}

function ensureYouTubeContainer() {
  const wrapper = document.getElementById('videoWrapper');

  if (currentMode !== 'youtube') {
    destroyAudioVisualizer();
    wrapper.classList.remove('audio-wrapper');
    wrapper.innerHTML = '<div id="player"></div>';
    player = null;
  }
}

function clearPlayer() {
  stopCurrentVideo();
  destroyAudioVisualizer();

  const wrapper = document.getElementById('videoWrapper');
  wrapper.classList.remove('audio-wrapper');
  wrapper.innerHTML = '<div id="player"></div>';

  player = null;
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
    document.body.classList.add('mobile-menu-mode');
  }
}
function setupOpenFullButton() {
  const btn = document.getElementById('openFullBtn');

  if (!btn) {
    return;
  }

  btn.onclick = function () {
    window.open(window.location.href, '_blank');
  };
}

setupOpenFullButton();
function isInsideIframe() {
  return window.self !== window.top;
}

function setupOpenFullButton() {
  const btn = document.getElementById('openFullBtn');

  if (!btn) {
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const returnUrl = params.get('return');

  if (isInsideIframe()) {
    btn.textContent = 'פתח במסך מלא';

    btn.onclick = function () {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('return', document.referrer || '');

      window.open(currentUrl.toString(), '_blank');
    };
  } else {
    btn.textContent = 'חזרה לאתר המקהלה';

    btn.onclick = function () {
      if (returnUrl) {
        window.location.href = returnUrl;
      } else {
        history.back();
      }
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

  skipButtonsTimer = setInterval(updateSkipButtons, 500);
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

function destroyAudioVisualizer() {
  if (audioVisualizerAnimationId) {
    cancelAnimationFrame(audioVisualizerAnimationId);
    audioVisualizerAnimationId = null;
  }

  if (audioSourceNode) {
    try {
      audioSourceNode.disconnect();
    } catch (error) {
      // ignore
    }
    audioSourceNode = null;
  }

  if (audioAnalyser) {
    try {
      audioAnalyser.disconnect();
    } catch (error) {
      // ignore
    }
    audioAnalyser = null;
  }
}

function initAudioVisualizer(media) {
  const canvas = document.getElementById('audioVisualizer');

  if (!canvas) {
    return;
  }

  drawIdleAudioVisualizer(canvas);

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  if (!AudioContextClass) {
    return;
  }

  try {
    if (!audioContext) {
      audioContext = new AudioContextClass();
    }

    audioAnalyser = audioContext.createAnalyser();
    audioAnalyser.fftSize = 256;
    audioAnalyser.smoothingTimeConstant = 0.82;

    audioSourceNode = audioContext.createMediaElementSource(media);
    audioSourceNode.connect(audioAnalyser);
    audioAnalyser.connect(audioContext.destination);

    media.addEventListener('play', () => {
      if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
      }
    });

    drawAudioVisualizer(canvas, audioAnalyser);
  } catch (error) {
    drawIdleAudioVisualizer(canvas);
  }
}

function resizeCanvasToDisplaySize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * window.devicePixelRatio));
  const height = Math.max(1, Math.floor(rect.height * window.devicePixelRatio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function drawAudioVisualizer(canvas, analyser) {
  const ctx = canvas.getContext('2d');
  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    resizeCanvasToDisplaySize(canvas);

    const width = canvas.width;
    const height = canvas.height;

    analyser.getByteFrequencyData(data);

    drawAudioBars(ctx, width, height, data, '#eaf0f7', '#7c8fa6');

    audioVisualizerAnimationId = requestAnimationFrame(draw);
  }

  draw();
}

function drawIdleAudioVisualizer(canvas) {
  const ctx = canvas.getContext('2d');

  resizeCanvasToDisplaySize(canvas);

  const width = canvas.width;
  const height = canvas.height;
  const data = new Uint8Array(80);

  for (let i = 0; i < data.length; i++) {
    data[i] = 35 + 65 * Math.abs(Math.sin(i * 0.37));
  }

  drawAudioBars(ctx, width, height, data, '#eaf0f7', '#b6c4d4');
}

function drawAudioBars(ctx, width, height, data, backgroundColor, barColor) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, width, height);

  const bars = 80;
  const step = Math.max(1, Math.floor(data.length / bars));
  const gap = Math.max(1, Math.floor(width / bars * 0.25));
  const barWidth = Math.max(2, Math.floor((width - gap * (bars - 1)) / bars));

  ctx.fillStyle = barColor;

  for (let i = 0; i < bars; i++) {
    let sum = 0;

    for (let j = 0; j < step; j++) {
      sum += data[i * step + j] || 0;
    }

    const value = sum / step / 255;
    const barHeight = Math.max(3, value * height * 0.9);
    const x = i * (barWidth + gap);
    const y = (height - barHeight) / 2;

    ctx.fillRect(x, y, barWidth, barHeight);
  }
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
loadLibraryData();