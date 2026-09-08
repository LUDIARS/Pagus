import { mixedPartsFor, type Villager } from '@pagus/sim';
import type { ShapePart, Vec3 } from './resident-mesh.js';

/** Body transformations and additional limbs are independent of the resident's base species. */
export function mutateAnatomy(v: Villager, base: ShapePart[]): ShapePart[] {
  const mixed = mixedPartsFor(v);
  const result = mixed.includes('slime') ? base.map((part) => ({ ...part,
    center: [part.center[0], part.center[1] * .84, part.center[2]] as Vec3,
    radius: [part.radius[0] * 1.12, part.radius[1] * .92, part.radius[2] * 1.12] as Vec3,
    color: part.preserveColor || part.color[0] < .2 ? part.color : [.32, .81, .73] as Vec3,
  })) : [...base];
  const add = (center:Vec3,radius:Vec3,color:Vec3):void => { result.push({center,radius,color}); };
  if (mixed.includes('slime')) {
    add([0,.08,0],[.59,.13,.4],[.27,.73,.66]);
    add([-.24,1.14,.19],[.1,.15,.025],[.80,1,.91]);
    add([.12,.55,.29],[.06,.09,.02],[.64,.95,.89]);
    add([.37,.28,.05],[.17,.3,.19],[.31,.79,.71]);
  }
  if (mixed.includes('extraArms')) {
    for (const side of [-1,1]) {
      // A visibly separate lower pair, with forearms and hands, rather than a shoulder ornament.
      add([side*.44,.42,.12],[.19,.10,.12],[.58,.68,.81]);
      add([side*.63,.32,.16],[.11,.18,.11],[.58,.68,.81]);
      add([side*.67,.18,.22],[.14,.12,.13],[.91,.81,.65]);
    }
  }
  if (mixed.includes('cthulhu')) {
    const green:Vec3=[.28,.48,.43];
    add([0,.98,.36],[.29,.19,.17],green);
    for (let strand=0;strand<5;strand++) {
      const rootX=(strand-2)*.105;
      for (let segment=0;segment<10;segment++) {
        const t=segment/9;
        const curl=t*t*Math.PI*1.7;
        const x=rootX+Math.sin(curl)*(strand-2)*.065;
        const y=.96-t*.53+Math.max(0,t-.65)*.72;
        const z=.47+Math.sin(t*Math.PI)*.20+(strand%2)*.04;
        const r=.078-t*.048;
        add([x,y,z],[r,r*1.2,r],green);
        if(segment>1&&segment%2===0) add([x,y-.025,z+r],[r*.45,r*.32,.018],[.74,.79,.55]);
      }
    }
    for(const side of [-1,1]) add([side*.36,.83,-.20],[.3,.34,.075],[.29,.39,.39]);
  }
  return result;
}
