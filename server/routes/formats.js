
const express = require('express');
const { spawn } = require('child_process');

const router = express.Router();

const MAX_URL_LENGTH = 2048;
const YTDLP_TIMEOUT_MS = parsePositiveInt(
  process.env.YTDLP_TIMEOUT_MS,
  120 * 1000
);


const YTDLP_PATH =
  process.env.YTDLP_PATH ||
  'C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe';



router.post('/', async (req, res, next) => {
  try {
    const { url } = req.body || {};
    const normalizedUrl = normalizeInput(url);

    if (!isValidYouTubeUrl(normalizedUrl)) {
      return res.status(400).json({
        error: 'Please enter a valid YouTube link.'
      });
    }

    const { stdout } = await runYtDlp([
      '--ignore-config',
      '-J',
      '--no-playlist',
      '--no-warnings',
      normalizedUrl
    ]);

    let metadata;

    try {
      metadata = JSON.parse(stdout);
    } catch {
      return res.status(500).json({
        error: "We couldn't read this video's details. Please try another link."
      });
    }

    const allFormats = Array.isArray(metadata.formats)
      ? metadata.formats
      : [];

    const mp4VideoFormats = allFormats
      .filter((format) =>
        format.ext === 'mp4' &&
        format.vcodec &&
        format.vcodec !== 'none' &&
        format.format_id &&
        Number.isFinite(Number(format.height)) &&
        Number(format.height) > 0
      )
      .sort((a, b) => {
        if ((b.height || 0) !== (a.height || 0)) {
          return (b.height || 0) - (a.height || 0);
        }

        const aHasAudio =
          a.acodec && a.acodec !== 'none' ? 1 : 0;
        const bHasAudio =
          b.acodec && b.acodec !== 'none' ? 1 : 0;

        if (bHasAudio !== aHasAudio) {
          return bHasAudio - aHasAudio;
        }

        if ((b.tbr || 0) !== (a.tbr || 0)) {
          return (b.tbr || 0) - (a.tbr || 0);
        }

        return (
          (b.filesize || b.filesize_approx || 0) -
          (a.filesize || a.filesize_approx || 0)
        );
      });

    if (mp4VideoFormats.length === 0) {
      return res.status(404).json({
        error: 'No downloadable qualities were found for this video.'
      });
    }

    const seenHeights = new Set();
    const qualityFormats = [];

    for (const format of mp4VideoFormats) {
      const height = Number(format.height);

      if (seenHeights.has(height)) {
        continue;
      }

      seenHeights.add(height);

      qualityFormats.push({
        formatId: format.format_id,
        quality: `${height}p`,
        hasAudio: Boolean(
          format.acodec && format.acodec !== 'none'
        )
      });

      if (qualityFormats.length >= 12) {
        break;
      }
    }

    const channelName = getChannelName(metadata);

    return res.json({
      title: metadata.title || 'YouTube Video',
      duration: normalizeDuration(metadata.duration),
      thumbnail: getBestVideoThumbnail(metadata),
      channel: {
        name: channelName
      },
      formats: qualityFormats
    });
  } catch (error) {
    return next(error);
  }
});

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const complete = (error, result) => {
      if (settled) return;

      settled = true;
      clearTimeout(timeoutId);

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const timeoutId = setTimeout(() => {
      timedOut = true;

      if (child && !settled) {
        child.kill();
      }
    }, YTDLP_TIMEOUT_MS);

    try {
      child = spawn(YTDLP_PATH, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      clearTimeout(timeoutId);
      return reject(createSpawnError(error));
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      console.error('[yt-dlp] Failed to start process:', {
        code: error.code,
        message: error.message,
        configuredPath: YTDLP_PATH
      });

      complete(createSpawnError(error));
    });

    child.on('close', (code) => {
      if (timedOut) {
        console.error('[yt-dlp] Process timed out.');

        return complete(
          withStatus(
            504,
            'The download request timed out. Please try again.'
          )
        );
      }

      if (code === 0) {
        return complete(null, { stdout, stderr });
      }

      console.error('[yt-dlp] Process failed:', {
        exitCode: code,
        stderr: stderr.slice(-3000),
        stdout: stdout.slice(-1000)
      });

      const details = getReadableYtDlpError(stderr || stdout);

      return complete(withStatus(500, details));
    });
  });
}

function createSpawnError(error) {
  if (error.code === 'ENOENT') {
    return withStatus(
      500,
      'yt-dlp was not found. Install it or configure YTDLP_PATH.'
    );
  }

  return withStatus(
    500,
    'Could not start the download service.'
  );
}

function getReadableYtDlpError(message) {
  const rawLines = String(message || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const errorLine =
    [...rawLines].reverse().find((line) => /^ERROR:/i.test(line)) ||
    rawLines[rawLines.length - 1] ||
    '';

  const cleaned = errorLine
    .replace(/^ERROR:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/^[A-Za-z0-9_-]{6,}:\s*/, '')
    .replace(/^Unable to download [^:]+:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normalized = cleaned.toLowerCase();

  if (!normalized) {
    return 'Could not process this video. Please try another link.';
  }

  if (
    normalized.includes('video unavailable') ||
    normalized.includes('video is unavailable')
  ) {
    return 'This video is unavailable.';
  }

  if (normalized.includes('private video')) {
    return 'This video is private.';
  }

  if (
    normalized.includes('age-restricted') ||
    normalized.includes('confirm your age')
  ) {
    return 'This video is age-restricted.';
  }

  if (
    normalized.includes('not available in your country') ||
    normalized.includes('geo-restricted')
  ) {
    return 'This video is blocked in your region.';
  }

  if (normalized.includes('requested format is not available')) {
    return 'This quality is not available. Please choose another one.';
  }

  if (
    normalized.includes('too many requests') ||
    normalized.includes('http error 429')
  ) {
    return 'Too many requests right now. Please try again later.';
  }

  if (
    normalized.includes('timed out') ||
    normalized.includes('network') ||
    normalized.includes('connection')
  ) {
    return 'Network issue while contacting YouTube. Please try again.';
  }

  if (
    normalized.includes('copyright') ||
    normalized.includes('forbidden')
  ) {
    return 'This video cannot be downloaded.';
  }

  return 'Could not process this video. Please try another link.';
}

function isValidYouTubeUrl(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_URL_LENGTH
  ) {
    return false;
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    return false;
  }

  const host = url.hostname.replace(/^www\./, '').toLowerCase();

  return [
    'youtube.com',
    'm.youtube.com',
    'youtu.be',
    'music.youtube.com'
  ].includes(host);
}

function getBestVideoThumbnail(metadata) {
  const thumbnails = Array.isArray(metadata?.thumbnails)
    ? metadata.thumbnails
    : [];

  const bestFromList = thumbnails
    .map((thumbnail) => ({
      url: normalizeHttpUrl(thumbnail?.url),
      score: getThumbnailScore(thumbnail)
    }))
    .filter((thumbnail) => thumbnail.url)
    .sort((a, b) => b.score - a.score)[0];

  if (bestFromList?.url) {
    return bestFromList.url;
  }

  return normalizeHttpUrl(metadata?.thumbnail);
}

function getChannelName(metadata) {
  const candidates = [
    metadata?.channel,
    metadata?.uploader,
    metadata?.creator,
    metadata?.uploader_id,
    metadata?.channel_id
  ];

  for (const candidate of candidates) {
    const normalized = normalizeInput(candidate);

    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function normalizeHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  const input = value.trim();
  const normalizedValue = input.startsWith('//')
    ? `https:${input}`
    : input;

  try {
    const parsed = new URL(normalizedValue);

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }

    return parsed.toString();
  } catch {
    return '';
  }
}

function getThumbnailScore(thumbnail) {
  const width = Number(thumbnail?.width) || 0;
  const height = Number(thumbnail?.height) || 0;
  const preference = Number(thumbnail?.preference) || 0;

  return width * height + preference;
}

function normalizeDuration(value) {
  const seconds = Number(value);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return Math.floor(seconds);
}

function normalizeInput(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function withStatus(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

module.exports = router;
