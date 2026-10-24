#!/usr/bin/env node
// Lightweight regression for H-1 (title-image XSS).
// Replicates the pure validation logic from app.js so it can run in Node.

function isValidTitleImageSrc(src) {
    if (typeof src !== 'string') return false;
    const stripped = src.replace(/[\r\n\s]/g, '');
    if (!stripped) return false;
    if (/["'<>]/.test(stripped)) return false;
    return /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(stripped);
}

function encodeMarkdownUrl(src) {
    const encoded = encodeURI(String(src || ''));
    return encoded.replace(/[()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function safeTitleImageWidth(width) {
    const n = parseInt(width, 10);
    if (!Number.isFinite(n)) return '700px';
    return Math.max(200, Math.min(1000, n)) + 'px';
}

const tests = [
    // Normal canvas-generated PNG/WebP/JPEG/GIF should pass
    { src: 'data:image/png;base64,iVBORw0KGgo=', label: 'normal PNG', expect: true },
    { src: 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+wACAAQA=', label: 'normal WebP', expect: true },
    { src: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD=', label: 'normal JPEG', expect: true },
    { src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', label: 'normal GIF', expect: true },
    // SVG payload must be rejected
    { src: 'data:image/svg+xml,<svg onload="window.__audit_xss=1">', label: 'SVG payload', expect: false },
    // Quoted / angle-bracket payloads must be rejected
    { src: 'data:image/png;base64,"test"', label: 'quoted value', expect: false },
    { src: 'data:image/png;base64,<test>', label: 'angle brackets', expect: false },
    // javascript: / vbscript: / text/html must be rejected
    { src: 'javascript:alert(1)', label: 'javascript scheme', expect: false },
    { src: 'vbscript:msgbox(1)', label: 'vbscript scheme', expect: false },
    { src: 'data:text/html,<script>alert(1)</script>', label: 'data text/html', expect: false },
    // Whitespace-stripped but still invalid
    { src: '  data:image/svg+xml,<svg>  ', label: 'stripped SVG', expect: false },
    // Empty / non-string
    { src: '', label: 'empty string', expect: false },
    { src: null, label: 'null', expect: false },
];

let passed = 0;
let failed = 0;
for (const t of tests) {
    const result = isValidTitleImageSrc(t.src);
    const ok = result === t.expect;
    if (ok) passed++;
    else failed++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + t.label + '  expect=' + t.expect + ' got=' + result);
}

// Markdown encoding check
const mdUrl = 'data:image/png;base64,abc() test';
const encoded = encodeMarkdownUrl(mdUrl);
const okEncoded = !encoded.includes('(') && !encoded.includes(')') && !encoded.includes(' ');
if (okEncoded) passed++;
else failed++;
console.log((okEncoded ? 'PASS' : 'FAIL') + '  Markdown URL encoding  no paren/space in output');

for (const [input, expected] of [
    ['700px', '700px'],
    ['200px', '200px'],
    ['1000px', '1000px'],
    ['9999px', '1000px'],
    ['1px', '200px'],
    ['100%', '200px'],
    ['nonsense', '700px'],
    ['700px; background:url(x)', '700px'],
]) {
    const got = safeTitleImageWidth(input);
    const ok = got === expected;
    if (ok) passed++;
    else failed++;
    console.log((ok ? 'PASS' : 'FAIL') + '  width ' + JSON.stringify(input) + '  expect=' + expected + ' got=' + got);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed ? 1 : 0);
