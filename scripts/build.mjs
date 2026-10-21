import { readFile, writeFile, mkdir, readdir, cp } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nunjucks from 'nunjucks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = resolve(root, '.generated');
await mkdir(resolve(generated, 'public/static'), { recursive: true });
await cp(resolve(root, 'ui/static'), resolve(generated, 'public/static'), { recursive: true });
const env = new nunjucks.Environment(null, { autoescape: true });
for (const name of ['dt', 'truncate_mid', 'tojson', 'format', 'list', 'string']) {
  env.addFilter(name, (value) => value);
}
let output = '// Generated UI templates: no runtime eval or filesystem access.\nexport default {\n';
for (const name of (await readdir(resolve(root, 'ui/templates'))).filter((n) =>
  n.endsWith('.html'),
)) {
  const source = await readFile(resolve(root, 'ui/templates', name), 'utf8');
  output +=
    nunjucks.precompileString(source, {
      name,
      env,
      wrapper: (templates) =>
        templates
          .map((t) => `${JSON.stringify(t.name)}: (function(){\n${t.template}\n})()`)
          .join(',\n'),
    }) + ',\n';
}
await writeFile(resolve(generated, 'templates.mjs'), output + '};\n');
console.log('Precompiled UI templates and copied static assets.');
