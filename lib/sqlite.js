// Loads sql.js (SQLite in WebAssembly). It ships as a classic script: on the page it's added as a <script> tag
// (the page CSP allows only this site's own scripts, no eval); in the import worker it's evaluated from source.
let SQL;
const base = new URL('./vendor/', import.meta.url);

function initFromPage() {
  return new Promise((resolve, reject) => {
    if (self.initSqlJs) return resolve(self.initSqlJs);
    const s = document.createElement('script');
    s.src = new URL('sql-wasm.js', base).href;
    s.onload = () => resolve(self.initSqlJs);
    s.onerror = () => reject(new Error('Could not load SQLite'));
    document.head.append(s);
  });
}
async function initFromWorker() {
  const src = await fetch(new URL('sql-wasm.js', base)).then(r => r.text());
  return new Function(src + '\nreturn initSqlJs;')();
}

export async function sqlite() {
  if (SQL) return SQL;
  const initSqlJs = typeof document !== 'undefined' ? await initFromPage() : await initFromWorker();
  SQL = await initSqlJs({ locateFile: f => new URL(f, base).href });
  return SQL;
}
