'use strict';

const PINTEREST_REGEX =
    /https?:\/\/(?:www\.)?(?:[\w-]+\.)?(?:pinterest\.(?:com|co\.uk|de|fr|it|es|nl|se|ch|co\.in|br|au|at|cl|jp|ru|ie|ca|mx|nz|pt|ph)|pin\.it)\/[^\s)>\]'"]+/i;

/**
 * Extract the first Pinterest URL from a string.
 * Strips trailing punctuation that is not part of the URL.
 */
function extractPinterestUrl(text) {
    const m = (text || '').match(PINTEREST_REGEX);
    return m ? m[0].replace(/[),.;>'"]+$/, '') : null;
}

/** Decode HTML entities and strip tags; truncate to 200 chars. */
function cleanText(str) {
    return (str || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || 'Pinterest Media';
}

/** Guess file extension from a URL path. */
function getExtFromUrl(url) {
    const m = (url || '').match(/\.(jpg|jpeg|png|gif|webp|avif|mp4|mov|webm)(?:\?|$)/i);
    return m ? m[1].toLowerCase() : 'jpg';
}

/** Map an extension to a MIME type. */
function getContentType(ext) {
    const map = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
        gif: 'image/gif',  webp: 'image/webp', avif: 'image/avif',
        mp4: 'video/mp4',  mov: 'video/mp4',   webm: 'video/webm',
    };
    return map[ext] || 'application/octet-stream';
}

/** Build a filesystem-safe filename from a pin title and extension. */
function getSafeFilename(title, ext) {
    const base = cleanText(title)
        .replace(/[^a-z0-9\-_]+/gi, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'pinterest_media';
    return `${base}.${ext}`;
}

/**
 * Build a multipart/form-data body as a single Buffer.
 * @param {string}   boundary
 * @param {Object}   fields      – { name: value } text fields
 * @param {Object}   file        – { fieldName, filename, contentType, buffer }
 */
function buildMultipartBody(boundary, fields, file) {
    const NL = '\r\n';
    const chunks = [];

    for (const [name, value] of Object.entries(fields)) {
        chunks.push(
            Buffer.from(`--${boundary}${NL}Content-Disposition: form-data; name="${name}"${NL}${NL}${value}${NL}`)
        );
    }

    const safeFilename = file.filename.replace(/["\\\r\n]/g, '_');
    chunks.push(
        Buffer.from(
            `--${boundary}${NL}` +
            `Content-Disposition: form-data; name="${file.fieldName}"; filename="${safeFilename}"${NL}` +
            `Content-Type: ${file.contentType}${NL}${NL}`
        )
    );
    chunks.push(file.buffer);
    chunks.push(Buffer.from(`${NL}--${boundary}--${NL}`));

    return Buffer.concat(chunks);
}

module.exports = {
    PINTEREST_REGEX,
    extractPinterestUrl,
    cleanText,
    getExtFromUrl,
    getContentType,
    getSafeFilename,
    buildMultipartBody,
};
