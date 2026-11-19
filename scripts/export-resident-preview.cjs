// Offline artifact export, using the production coefficient mesh (no game server or simulation).
// Each TS source is transpiled to a temporary .cjs file whose require() specifiers are rewritten
// to the absolute paths of the allowed dependencies, then loaded with the normal require().
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require(process.argv[2]);
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[3]);
fs.mkdirSync(output, { recursive: true });
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagus-resident-preview-'));
const compile = (relative, dependencies) => {
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const linked = js.replace(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g, (_match, _quote, name) => {
    if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Missing preview dependency: ${name}`);
    return `require(${JSON.stringify(dependencies[name])})`;
  });
  const file = path.join(workDir, `${path.basename(relative, '.ts')}.cjs`);
  fs.writeFileSync(file, linked, 'utf8');
  return file;
};
try {
  const education = compile('packages/sim/src/education-profile.ts', {});
  const mutations = compile('packages/client/src/resident-mutations.ts', {'@pagus/sim': education});
  const primitives = compile('packages/client/src/mesh-primitives.ts', {});
  const costume = compile('packages/client/src/resident-costume.ts', {});
  const speciesDetail = compile('packages/client/src/resident-species-detail.ts', {});
  const geometry = require(compile('packages/client/src/resident-mesh.ts', {'@pagus/sim': education, './resident-mutations.js': mutations, './resident-costume.js': costume, './resident-species-detail.js': speciesDetail, './mesh-primitives.js': primitives}));
  const species = ['猫','兎','梟','熊','栗鼠','鼯鼠','蛇'];
  const models = species.map((kind, i) => {
    const base = { id:`preview-${i}`,species:kind,reformCount:0,appearance:{body:'animal',descriptors:[]},mixedParts:[] };
    const mixedParts = [['cthulhu'],['slime'],['extraArms'],['hybrid'],['tentacles','eyes'],['eyes','teapot'],['hybrid','cthulhu']][i];
    return { species:kind, parts:mixedParts, normal:Array.from(geometry.triangulate(geometry.residentParts(base))),
      mixed:Array.from(geometry.triangulate(geometry.residentParts({...base,reformCount:mixedParts.length,mixedParts}))) };
  });
  fs.writeFileSync(path.join(output,'resident-meshes.json'),JSON.stringify(models),'utf8');
  process.stdout.write(`Exported ${models.length} resident pairs to ${output}\n`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}
