import type { WireWorld } from '@pagus/sim';

export function factionTrialPanel(world: WireWorld, vote: (pick: 'kill' | 'spare') => void, cooling: boolean): HTMLElement {
  const root = document.createElement('div');
  const trial = world.trial, f = trial?.factions;
  if (!trial || !f) return root;
  const name = (id: string): string => world.villagers.find(v => v.id === id)?.name ?? id;
  const title = document.createElement('h3'); title.textContent = '噴水広場・勢力裁判'; root.append(title);
  for (const side of ['accusers', 'defenders'] as const) {
    const team = document.createElement('p');
    team.textContent = `${side === 'accusers' ? '告発側' : '被告側'} ${f[side].length}人：${f[side].map(name).join('・')}`;
    root.append(team);
  }
  for (const line of f.lines.slice(-4)) {
    const p = document.createElement('p'); p.textContent = `${name(line.speaker)}「${line.text}」`; root.append(p);
  }
  const result = document.createElement('p');
  result.textContent = f.loser ? `${f.explanation} 対象全員：${f[f.loser].map(name).join('・')}` : '住民が証言と反論をぶつけ合っています。勝敗は住民BTが決定します。';
  root.append(result);
  if (trial.stage === 'fate' && f.loser) {
    const tally = document.createElement('p'); tally.textContent = `敗北側全員の量刑：廃棄処分 ${trial.fateVotes.kill}票 / 教育 ${trial.fateVotes.spare}票`; root.append(tally);
    for (const [pick, text] of [['spare', '敗北側全員を教育'], ['kill', '敗北側全員を廃棄処分']] as const) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
      button.disabled = cooling; button.onclick = () => vote(pick); root.append(button);
    }
  } else if (trial.verdict) {
    const sentence = document.createElement('strong');
    sentence.textContent = `判決：敗北側全員に${trial.verdict === 'death' ? '廃棄処分' : '教育'}を言い渡す。`;
    root.append(sentence);
  }
  return root;
}
