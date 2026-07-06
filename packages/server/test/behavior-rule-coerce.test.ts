import { describe, it, expect } from 'vitest';
import { coerceBehaviorRule, extractJson } from '../src/llm/json-coerce.js';

describe('coerceBehaviorRule (ふるまいの法則 DSL の厳密検証, §2.1)', () => {
  it('正しい DSL を BehaviorRule に整える (source=haiku 固定)', () => {
    const rule = coerceBehaviorRule({
      id: 'whatever',
      description: '攻撃的なら事件化しやすい',
      when: [
        { kind: 'traitAbove', axis: 'aggression', value: 0.6 },
        { kind: 'actionCategory', category: 'wander' },
      ],
      then: [{ kind: 'triggerWeight', delta: 2 }],
    });
    expect(rule.source).toBe('haiku');
    expect(rule.description).toBe('攻撃的なら事件化しやすい');
    expect(rule.when).toHaveLength(2);
    expect(rule.then[0]).toEqual({ kind: 'triggerWeight', delta: 2 });
  });

  it('未知の条件 kind は throw (無言フォールバック禁止)', () => {
    expect(() =>
      coerceBehaviorRule({
        description: 'x',
        when: [{ kind: 'eval', code: 'rm -rf' }],
        then: [{ kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.1 }],
      }),
    ).toThrow();
  });

  it('未知の気質軸は throw', () => {
    expect(() =>
      coerceBehaviorRule({
        description: 'x',
        when: [{ kind: 'traitAbove', axis: 'evil', value: 0.5 }],
        then: [{ kind: 'emotionDelta', emotionAxis: 'joy', delta: 0.1 }],
      }),
    ).toThrow();
  });

  it('未知の効果 kind は throw', () => {
    expect(() =>
      coerceBehaviorRule({
        description: 'x',
        when: [{ kind: 'hasNeighbor' }],
        then: [{ kind: 'spawnMonster', n: 9 }],
      }),
    ).toThrow();
  });

  it('when/then が空なら throw (何もしないルールを弾く)', () => {
    expect(() => coerceBehaviorRule({ description: 'x', when: [], then: [{ kind: 'triggerWeight', delta: 1 }] })).toThrow();
    expect(() => coerceBehaviorRule({ description: 'x', when: [{ kind: 'hasNeighbor' }], then: [] })).toThrow();
  });

  it('triggerWeight の delta は安全域 (-5..5) にクランプされる', () => {
    const rule = coerceBehaviorRule({
      description: 'x',
      when: [{ kind: 'hasNeighbor' }],
      then: [{ kind: 'triggerWeight', delta: 999 }],
    });
    expect(rule.then[0]).toEqual({ kind: 'triggerWeight', delta: 5 });
  });

  it('生活プロファイル向け条件を検証して受け入れる', () => {
    const rule = coerceBehaviorRule({
      description: '音楽家の夜騒音',
      when: [
        { kind: 'valueIncludes', text: '音楽' },
        { kind: 'hobby', hobby: 'collector' },
        { kind: 'activity', activity: 'nocturnal' },
        { kind: 'wealthAbove', value: 100 },
      ],
      then: [{ kind: 'actionFlavor', text: '夜更けの音が響いた' }],
    });
    expect(rule.when).toEqual([
      { kind: 'valueIncludes', text: '音楽' },
      { kind: 'hobby', hobby: 'collector' },
      { kind: 'activity', activity: 'nocturnal' },
      { kind: 'wealthAbove', value: 100 },
    ]);
  });

  it('コードフェンス付き JSON も extractJson 経由で読める', () => {
    const text = '```json\n{"description":"夜は怖い","when":[{"kind":"timeOfDay","timeOfDay":"night"}],"then":[{"kind":"emotionDelta","emotionAxis":"fear","delta":0.2}]}\n```';
    const rule = coerceBehaviorRule(extractJson(text));
    expect(rule.when[0]).toEqual({ kind: 'timeOfDay', timeOfDay: 'night' });
  });
});
