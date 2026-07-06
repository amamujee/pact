const fs = require('fs');
let content = fs.readFileSync('public/index.html', 'utf8');

console.log('=== FIXING AVATARS: replacing colored circles with real human photos ===\n');

// ── STEP 1: Update CSS for .dm-av (animated demo) ──────────────────────────
const dmAvOld = `.dm-av {
            width: 28px;
            height: 28px;
            border-radius: 7px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.62rem;
            font-weight: 700;
            color: white;
            margin-top: 1px;
        }`;
const dmAvNew = `.dm-av {
            width: 28px;
            height: 28px;
            border-radius: 7px;
            flex-shrink: 0;
            overflow: hidden;
            background: #6366F1;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-top: 1px;
        }
        .dm-av img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }`;

if (content.includes(dmAvOld)) {
    content = content.replace(dmAvOld, dmAvNew);
    console.log('✅ CSS .dm-av updated');
} else {
    console.log('❌ CSS .dm-av NOT FOUND — searching for alternatives...');
    const idx = content.indexOf('.dm-av {');
    if (idx >= 0) {
        const end = content.indexOf('}', content.indexOf('color: white;', idx));
        const snippet = content.substring(idx, end + 1);
        console.log('Found at index', idx, ':', JSON.stringify(snippet));
    }
}

// ── STEP 2: Update CSS for .mock-avatar (hero Slack mock) ─────────────────
const mockAvatarOld = `        .mock-avatar {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.7rem;
            font-weight: 700;
            color: white;
        }`;
const mockAvatarNew = `        .mock-avatar {
            width: 32px;
            height: 32px;
            border-radius: 8px;
            flex-shrink: 0;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .mock-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }`;

if (content.includes(mockAvatarOld)) {
    content = content.replace(mockAvatarOld, mockAvatarNew);
    console.log('✅ CSS .mock-avatar updated');
} else {
    console.log('❌ CSS .mock-avatar NOT FOUND — searching...');
    const idx = content.indexOf('.mock-avatar {');
    if (idx >= 0) {
        const end = content.indexOf('}', content.indexOf('color: white;', idx));
        const snippet = content.substring(idx, end + 1);
        console.log('Found at index', idx, ':', JSON.stringify(snippet));
    }
}

// ── STEP 3: Update CSS for .trust-card-avatar (testimonials) ──────────────
const trustCardOld = `        .trust-card-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: linear-gradient(135deg, rgba(245,158,11,0.15), rgba(139,92,246,0.1));
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8rem;
            font-weight: 700;
            color: var(--accent);
        }`;
const trustCardNew = `        .trust-card-avatar {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            flex-shrink: 0;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .trust-card-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }`;

if (content.includes(trustCardOld)) {
    content = content.replace(trustCardOld, trustCardNew);
    console.log('✅ CSS .trust-card-avatar updated');
} else {
    console.log('❌ CSS .trust-card-avatar NOT FOUND — searching...');
    const idx = content.indexOf('.trust-card-avatar {');
    if (idx >= 0) {
        const end = content.indexOf('}', content.indexOf('color: var(--accent)', idx));
        const snippet = content.substring(idx, end + 1);
        console.log('Found at index', idx, ':', JSON.stringify(snippet));
    }
}

// ── STEP 4: Fix HTML — Alex avatar in hero Slack mock (line ~2370) ─────────
const alexAvatarOld = `<div class=\"mock-avatar\" style=\"background: #6366F1;\">A</div>`;
const alexAvatarNew = `<div class=\"mock-avatar\" style=\"background: #6366F1;\"><img src=\"https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=32&h=32&fit=crop&crop=face\" alt=\"Alex\" width=\"32\" height=\"32\"></div>`;

if (content.includes(alexAvatarOld)) {
    content = content.replace(alexAvatarOld, alexAvatarNew);
    console.log('✅ HTML Alex avatar (hero Slack mock) fixed');
} else {
    console.log('❌ HTML Alex avatar NOT FOUND — searching...');
    const idx = content.indexOf('mock-avatar');
    const snippets = [];
    let pos = 0;
    while ((pos = content.indexOf('mock-avatar', pos)) !== -1 && snippets.length < 3) {
        const snippet = content.substring(pos, pos + 120);
        snippets.push(`pos=${pos}: ${JSON.stringify(snippet)}`);
        pos++;
    }
    snippets.forEach(s => console.log(' ', s));
}

// ── STEP 5: Fix HTML — Trust card avatars (lines ~2692, 2702, 2712) ────────
const emAvatarOld = `<div class=\"trust-card-avatar\">EM</div>`;
const emAvatarNew = `<div class=\"trust-card-avatar\"><img src=\"https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=40&h=40&fit=crop&crop=face\" alt=\"Engineering Manager\" width=\"40\" height=\"40\"></div>`;

const tlAvatarOld = `<div class=\"trust-card-avatar\">TL</div>`;
const tlAvatarNew = `<div class=\"trust-card-avatar\"><img src=\"https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=40&h=40&fit=crop&crop=face\" alt=\"Tech Lead\" width=\"40\" height=\"40\"></div>`;

const pmAvatarOld = `<div class=\"trust-card-avatar\">PM</div>`;
const pmAvatarNew = `<div class=\"trust-card-avatar\"><img src=\"https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face\" alt=\"Product Manager\" width=\"40\" height=\"40\"></div>`;

if (content.includes(emAvatarOld)) {
    content = content.replace(emAvatarOld, emAvatarNew);
    console.log('✅ Trust card avatar EM fixed');
} else { console.log('❌ EM avatar NOT FOUND'); }

if (content.includes(tlAvatarOld)) {
    content = content.replace(tlAvatarOld, tlAvatarNew);
    console.log('✅ Trust card avatar TL fixed');
} else { console.log('❌ TL avatar NOT FOUND'); }

if (content.includes(pmAvatarOld)) {
    content = content.replace(pmAvatarOld, pmAvatarNew);
    console.log('✅ Trust card avatar PM fixed');
} else { console.log('❌ PM avatar NOT FOUND'); }

// ── STEP 6: Fix JS — userMsg template (line ~3126) ─────────────────────────
const jsUserMsgOld = `userMsg: function(text) {
                return '<div class=\"dm-av\" style=\"background:#6366F1\">A</div>'`;
const jsUserMsgNew = `userMsg: function(text) {
                return '<div class=\"dm-av\"><img src=\"https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=28&h=28&fit=crop&crop=face\" alt=\"Alex\" width=\"28\" height=\"28\"></div>'`;

if (content.includes(jsUserMsgOld)) {
    content = content.replace(jsUserMsgOld, jsUserMsgNew);
    console.log('✅ JS userMsg template fixed (animated demo)');
} else {
    console.log('❌ JS userMsg NOT FOUND — searching...');
    const idx = content.indexOf('dm-av');
    const snippets = [];
    let pos = 0;
    while ((pos = content.indexOf('dm-av', pos)) !== -1 && snippets.length < 5) {
        const snippet = content.substring(pos, pos + 100);
        snippets.push(`pos=${pos}: ${JSON.stringify(snippet)}`);
        pos++;
    }
    snippets.forEach(s => console.log(' ', s));
}

// ── Save ────────────────────────────────────────────────────────────────────
fs.writeFileSync('public/index.html', content);
console.log('\n✅ All changes written to public/index.html');

// ── Verify ──────────────────────────────────────────────────────────────────
let updated = fs.readFileSync('public/index.html', 'utf8');
const checks = [
    ['dm-av img', 'CSS for dm-av with img'],
    ['mock-avatar img', 'CSS for mock-avatar with img'],
    ['trust-card-avatar img', 'CSS for trust-card-avatar with img'],
    ['images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=32&h=32&fit=crop&crop=face', 'Alex avatar in hero mock'],
    ['images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=28&h=28&fit=crop&crop=face', 'Alex avatar in JS demo'],
    ['images.unsplash.com/photo-1494790108377-be9c29b29330?w=40&h=40&fit=crop&crop=face', 'EM trust avatar'],
    ['images.unsplash.com/photo-1500648767791-00dcc994a43e?w=40&h=40&fit=crop&crop=face', 'TL trust avatar'],
    ['images.unsplash.com/photo-1438761681033-6461ffad8d80?w=40&h=40&fit=crop&crop=face', 'PM trust avatar'],
];
console.log('\n--- Verification ---');
checks.forEach(([pattern, label]) => {
    const found = updated.includes(pattern);
    console.log(found ? `✅ ${label}` : `❌ ${label} — NOT FOUND`);
});

// Check for old patterns
const oldPatterns = [
    ['>A</div>', 'Old Alex avatar (initial A)'],
    ['>EM</div>', 'Old EM avatar (initial EM)'],
    ['>TL</div>', 'Old TL avatar (initial TL)'],
    ['>PM</div>', 'Old PM avatar (initial PM)'],
];
console.log('\n--- Old patterns (should be gone) ---');
oldPatterns.forEach(([pattern, label]) => {
    const found = updated.includes(pattern);
    console.log(found ? `❌ ${label} — STILL PRESENT` : `✅ ${label} — removed`);
});

console.log('\nDone!');