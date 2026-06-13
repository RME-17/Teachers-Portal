const fs = require('fs');
const path = require('path');
const ROOT = '/workspaces/Teachers-Portal';
const RAW = 'https://raw.githubusercontent.com/RME-17/Teachers-Portal/main/';

function read(f){ return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function scriptTag(code){ return '<script>\n' + code.replace(/<\/script>/gi, '<\\/script>') + '\n</script>'; }

let html = read('index.html');

// 1. remove the renderer.js preload hint (file no longer exists standalone)
html = html.replace(/[ \t]*<link rel="preload" href="renderer.js" as="script" \/>\s*\n?/, '\n');

// 2. web-shim without its dynamic loader tail (we inline supabase + preload directly)
let webshim = read('web-shim.js');
const marker = '// --- Load vendored supabase-js';
const idx = webshim.indexOf(marker);
if (idx !== -1) { webshim = webshim.slice(0, idx).replace(/\s*$/, '') + '\n})();\n'; }
else { throw new Error('web-shim loader marker not found'); }

// 3. inline bundle in exact original boot order
const order = [
  ['web-shim (electron+supabase bridge mock)', webshim],
  ['vendor/supabase.js', read('vendor/supabase.js')],
  ['preload.js', read('preload.js')],
  ['renderer-idle-power.js', read('renderer-idle-power.js')],
  ['renderer.js', read('renderer.js')],
  ['renderer-calendar.js', read('renderer-calendar.js')],
  ['obsidian-links.js', read('obsidian-links.js')],
  ['renderer-obsidian-view.js', read('renderer-obsidian-view.js')],
  ['renderer-settings.js', read('renderer-settings.js')],
];
const bundle = '\n<!-- === RME standalone inlined bundle === -->\n' + order.map(([n,c]) => '<!-- ' + n + ' -->\n' + scriptTag(c)).join('\n') + '\n';

// 4. drop the two external loader script tags
html = html.replace(/[ \t]*<script src="web-shim.js" defer><\/script>\s*\n?/, '\n');
html = html.replace(/[ \t]*<script src="boot-launch.js" defer><\/script>\s*\n?/, '\n');

// 5. insert bundle before </body>
if (html.indexOf('</body>') !== -1) { html = html.replace('</body>', bundle + '</body>'); }
else { html += bundle; }

// 6. rewrite relative asset refs to absolute raw GitHub URLs so they load when opened locally
html = html.replace(/(["'(])assets\//g, '$1' + RAW + 'assets/');

const out = path.join(ROOT, 'Teachers-Portal-standalone.html');
fs.writeFileSync(out, html);
console.log('OK wrote', out, (fs.statSync(out).size/1024/1024).toFixed(2), 'MB');
