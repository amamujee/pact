const fs = require('fs');
let content = fs.readFileSync('public/index.html', 'utf8');

// Add CSS for footer-contact-email after .footer-links a:hover rule
const oldCSS = '.footer-links a:hover { color: var(--text-light); }\n\n        /* ══════════════════════════════════════════\n           RESPONSIVE';
const newCSS = '.footer-links a:hover { color: var(--text-light); }\n        .footer-contact-email { color: var(--accent); }\n        .footer-contact-email:hover { color: var(--accent-hover); }\n\n        /* ══════════════════════════════════════════\n           RESPONSIVE';

if (content.includes(oldCSS)) {
    content = content.replace(oldCSS, newCSS);
    fs.writeFileSync('public/index.html', content);
    console.log('SUCCESS: CSS for footer-contact-email added');
} else {
    console.log('NOT FOUND: Looking for CSS section...');
    const idx = content.indexOf('.footer-links a:hover');
    if (idx >= 0) {
        console.log('Found .footer-links a:hover at index:', idx);
        console.log('Context:', JSON.stringify(content.substring(idx, idx + 300)));
    } else {
        console.log('.footer-links a:hover not found');
    }
}