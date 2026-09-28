// Modelled on bpgraph.test.mjs's sample(): "A spec that uses every node kind;
// each test breaks one thing in a copy." The names are invented: they belong to
// the Lantern Puzzle sample game of __fixtures__/synthetic.
import type { BlueprintSpec } from '../spec-types.js';

export function sample(): BlueprintSpec {
  return {
    asset: '/Game/LanternPuzzle/Core/BPC_Sample',
    create: { parent: '/Script/Engine.ActorComponent' },
    variables: [
      { name: 'Glow', type: 'name', default: 'Dim' },
      { name: 'PulseInterval', type: 'float', default: 0.2 },
      { name: 'PulseTimer', type: 'struct:/Script/Engine.TimerHandle' },
      { name: 'Rail', type: 'object:/Script/Engine.SplineComponent' },
      { name: 'Hints', type: 'array<text>' },
      { name: 'Menu', type: 'object:/Game/LanternPuzzle/Core/Widgets/WBP_Lantern_Menu.WBP_Lantern_Menu_C' },
    ],
    components: [{ name: 'ChimeAudio', class: '/Script/Engine.AudioComponent' }],
    functions: [
      { name: 'CheckGlow', inputs: [], outputs: [], pure: false },
      { name: 'Twice', inputs: [{ name: 'In', type: 'float' }], outputs: [{ name: 'Out', type: 'float' }], pure: true },
    ],
    graphs: [
      {
        graph: 'CheckGlow',
        nodes: {
          entry: { entry: true },
          g: { get: 'Glow' },
          cmp: { call: 'EqualEqual_NameName', class: '/Script/Engine.KismetMathLibrary' },
          br: { branch: true },
          s: { set: 'Glow' },
          c: { cast: '/Game/LanternPuzzle/Core/PC_Lantern.PC_Lantern_C' },
          owner: { call: 'GetOwner', class: '/Script/Engine.ActorComponent' },
        },
        links: [
          ['entry.then', 'br.execute'],
          ['g.Glow', 'cmp.A'],
          ['cmp.ReturnValue', 'br.Condition'],
          ['br.then', 's.execute'],
          ['br.else', 'c.execute'],
          ['owner.ReturnValue', 'c.Object'],
        ],
        defaults: { 'cmp.B': 'Bright', 's.Glow': 'Blazing' },
      },
      {
        graph: 'Twice',
        nodes: {
          entry: { entry: true },
          result: { result: true },
          mul: { call: 'Multiply_DoubleDouble', class: '/Script/Engine.KismetMathLibrary' },
        },
        links: [['entry.then', 'result.execute'], ['entry.In', 'mul.A'], ['mul.ReturnValue', 'result.Out']],
        defaults: { 'mul.B': 2 },
      },
      {
        graph: 'EventGraph',
        nodes: {
          bp: { event: 'ReceiveBeginPlay' },
          tick: { custom_event: 'OnTick', inputs: [{ name: 'Amount', type: 'float' }] },
          click: { bound_event: { target: 'PlayButton', event: 'OnClicked' } },
          seq: { sequence: 3 },
          sel: { select: 2 },
          me: { self: true },
          w: { create_widget: '/Game/LanternPuzzle/Core/Widgets/WBP_Lantern_Menu.WBP_Lantern_Menu_C', x: 900, y: 0 },
          t: { timer: true },
          mine: { call: 'CheckGlow' },
        },
        links: [
          ['bp.then', 'seq.execute'],
          ['seq.then_0', 't.execute'],
          ['seq.then_1', 'w.execute'],
          ['seq.then_2', 'mine.execute'],
          ['me.self', 't.Object'],
          ['tick.then', 'mine.execute'],
        ],
        defaults: { 't.FunctionName': 'CheckGlow', 't.Time': '0.2', 't.bLooping': true },
      },
    ],
    cdo_defaults: { PrimaryComponentTick: { bCanEverTick: false } },
  };
}
