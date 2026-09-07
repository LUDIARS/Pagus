// Offline artifact export, using the production coefficient mesh (no game server or simulation).
const fs = require('node:fs');
const path = require('node:path');
const ts = require(process.argv[2]);
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[3]);
fs.mkdirSync(output, { recursive: true });
const compile = (relative, dependencies) => {
  const text = fs.readFileSync(path.join(root, relative), 'utf8');
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  new Function('require','module','exports',js)((name) => { if (!(name in dependencies)) throw new Error(`Missing preview dependency: ${name}`); return dependencies[name]; },module,module.exports);
  return module.exports;
};
const education = compile('packages/sim/src/education-profile.ts', {});
const mutations = compile('packages/client/src/resident-mutations.ts', {'@pagus/sim': education});
const primitives = compile('packages/client/src/mesh-primitives.ts', {});
const geometry = compile('packages/client/src/resident-mesh.ts', {'@pagus/sim': education, './resident-mutations.js': mutations, './mesh-primitives.js': primitives});
const species = ['猫','兎','梟','熊','栗鼠','鼯鼠','蛇'];
const models = species.map((kind, i) => {
  const base = { id:`preview-${i}`,species:kind,reformCount:0,appearance:{body:'animal',descriptors:[]},mixedParts:[] };
  const mixedParts = [['cthulhu'],['slime'],['extraArms'],['hybrid'],['tentacles','eyes'],['eyes','teapot'],['hybrid','cthulhu']][i];
  return { species:kind, parts:mixedParts, normal:Array.from(geometry.triangulate(geometry.residentParts(base))),
    mixed:Array.from(geometry.triangulate(geometry.residentParts({...base,reformCount:mixedParts.length,mixedParts}))) };
});
fs.writeFileSync(path.join(output,'resident-meshes.json'),JSON.stringify(models),'utf8');
process.stdout.write(`Exported ${models.length} resident pairs to ${output}\n`);
