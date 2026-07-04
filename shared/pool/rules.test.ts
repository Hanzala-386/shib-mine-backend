/* Node test for the pure 8-ball rules engine. Run: npx tsx shared/pool/rules.test.ts */
import { applyShotRules, groupIds, EIGHT_BALL, type RuleState } from './rules';
import type { SimResult, TableState, BallState, SimEvent } from './physics';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ FAIL: ${name}`); }
}

/** Build a table state where the listed object-ball ids are ACTIVE (plus cue). */
function stateWithActive(activeIds: number[]): TableState {
  const balls: BallState[] = [{ id: 0, x: 100, y: 200, vx: 0, vy: 0, active: true }];
  for (let id = 1; id <= 15; id++) {
    balls.push({ id, x: 400, y: 200, vx: 0, vy: 0, active: activeIds.includes(id) });
  }
  return { balls };
}

function sim(opts: {
  pocketed?: number[];
  cuePocketed?: boolean;
  firstContactId?: number | null;
  events?: SimEvent[];
  finalActive?: number[];
}): SimResult {
  return {
    finalState: stateWithActive(opts.finalActive ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
    events: opts.events ?? [],
    frames: [],
    pocketed: opts.pocketed ?? [],
    cuePocketed: opts.cuePocketed ?? false,
    firstContactId: opts.firstContactId ?? null,
    durationMs: 1000,
  };
}

const ev = (type: SimEvent['type'], t: number, ballId?: number, otherId?: number): SimEvent =>
  ({ type, t, x: 0, y: 0, speed: 100, ballId, otherId });

const openState: RuleState = { openTable: true, shooterGroup: null, shooterOnEight: false, isBreak: false };

console.log('rules.ts — 8-ball rule engine');

// 1) Scratch (cue pocketed) → foul + ball in hand, turn passes.
{
  const t = applyShotRules(openState, sim({ cuePocketed: true, firstContactId: 1, events: [ev('ball_ball', 5, 0, 1), ev('cushion', 20, 0)] }));
  assert('scratch → foul', t.foul && t.fouls.includes('scratch'));
  assert('scratch → ball in hand', t.ballInHand);
  assert('scratch → turn passes', !t.keepTurn);
}

// 2) No contact → foul.
{
  const t = applyShotRules(openState, sim({ firstContactId: null, events: [ev('cushion', 10, 0)] }));
  assert('no-contact → foul', t.foul && t.fouls.includes('no_contact'));
}

// 3) Wrong-group-first (assigned solids, hits a stripe first) → foul.
{
  const rs: RuleState = { openTable: false, shooterGroup: 'solids', shooterOnEight: false, isBreak: false };
  const t = applyShotRules(rs, sim({ firstContactId: 9, events: [ev('ball_ball', 5, 0, 9), ev('cushion', 20, 9)] }));
  assert('wrong-first → foul', t.foul && t.fouls.includes('wrong_ball_first'));
}

// 4) Clean open-table pot of a single solid → assign solids, keep turn, no foul.
{
  const t = applyShotRules(openState, sim({
    pocketed: [3], firstContactId: 3,
    events: [ev('ball_ball', 5, 0, 3), ev('pocket', 40, 3)],
    finalActive: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  }));
  assert('open pot → no foul', !t.foul);
  assert('open pot → assign solids', t.assignedGroup === 'solids');
  assert('open pot → table closes', !t.openTableAfter);
  assert('open pot → keep turn', t.keepTurn);
}

// 5) Open-table pot of BOTH groups → table stays open, keep turn, no assignment.
{
  const t = applyShotRules(openState, sim({
    pocketed: [3, 11], firstContactId: 3,
    events: [ev('ball_ball', 5, 0, 3), ev('pocket', 40, 3), ev('pocket', 45, 11)],
    finalActive: [1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15],
  }));
  assert('mixed pot → stays open', t.openTableAfter && t.assignedGroup === null);
  assert('mixed pot → keep turn', t.keepTurn && !t.foul);
}

// 6) Legal 8-ball win: on the 8, pockets 8, no foul.
{
  const rs: RuleState = { openTable: false, shooterGroup: 'solids', shooterOnEight: true, isBreak: false };
  const t = applyShotRules(rs, sim({
    pocketed: [8], firstContactId: 8,
    events: [ev('ball_ball', 5, 0, 8), ev('pocket', 40, 8)],
    finalActive: [9, 10, 11, 12, 13, 14, 15],
  }));
  assert('legal 8 → game over', !!t.gameOver);
  assert('legal 8 → shooter wins', !!t.gameOver && t.gameOver.shooterWins === true);
}

// 7) Early 8 (group not cleared) → loss.
{
  const rs: RuleState = { openTable: false, shooterGroup: 'solids', shooterOnEight: false, isBreak: false };
  const t = applyShotRules(rs, sim({
    pocketed: [8], firstContactId: 3,
    events: [ev('ball_ball', 5, 0, 3), ev('ball_ball', 8, 3, 8), ev('pocket', 40, 8)],
    finalActive: [1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15],
  }));
  assert('early 8 → game over', !!t.gameOver);
  assert('early 8 → shooter LOSES', !!t.gameOver && t.gameOver.shooterWins === false);
}

// 8) Scratch on the 8 while on the 8 → loss.
{
  const rs: RuleState = { openTable: false, shooterGroup: 'stripes', shooterOnEight: true, isBreak: false };
  const t = applyShotRules(rs, sim({
    pocketed: [8], cuePocketed: true, firstContactId: 8,
    events: [ev('ball_ball', 5, 0, 8), ev('pocket', 40, 8)],
  }));
  assert('scratch-on-8 → loss', !!t.gameOver && t.gameOver.shooterWins === false);
}

// 9) Cushion-after-contact foul: hit own ball, nothing potted, no rail after.
{
  const rs: RuleState = { openTable: false, shooterGroup: 'solids', shooterOnEight: false, isBreak: false };
  const t = applyShotRules(rs, sim({
    firstContactId: 2,
    events: [ev('ball_ball', 5, 0, 2)], // no cushion, nothing pocketed
  }));
  assert('no-rail-after-contact → foul', t.foul && t.fouls.includes('no_cushion'));
}

// 10) Cushion BEFORE contact does not satisfy the rule (bank into ball, then dead).
{
  const rs: RuleState = { openTable: false, shooterGroup: 'solids', shooterOnEight: false, isBreak: false };
  const t = applyShotRules(rs, sim({
    firstContactId: 2,
    events: [ev('cushion', 3, 0), ev('ball_ball', 8, 0, 2)], // rail happened before contact
  }));
  assert('pre-contact rail → still foul', t.foul && t.fouls.includes('no_cushion'));
}

// 11) Break is exempt from the cushion rule (no pot, no rail = legal).
{
  const rs: RuleState = { openTable: true, shooterGroup: null, shooterOnEight: false, isBreak: true };
  const t = applyShotRules(rs, sim({ firstContactId: 1, events: [ev('ball_ball', 5, 0, 1)] }));
  assert('break exempt from cushion rule', !t.foul);
}

// 12) Hit-8-first when NOT on the 8 → foul.
{
  const rs: RuleState = { openTable: false, shooterGroup: 'solids', shooterOnEight: false, isBreak: false };
  const t = applyShotRules(rs, sim({
    firstContactId: 8,
    events: [ev('ball_ball', 5, 0, 8), ev('cushion', 20, 8)],
  }));
  assert('8-first (not on 8) → foul', t.foul && t.fouls.includes('wrong_ball_first'));
}

// 13) Potting opponent's ball only (assigned solids, pockets a stripe) → no keep-turn.
{
  const rs: RuleState = { openTable: false, shooterGroup: 'solids', shooterOnEight: false, isBreak: false };
  const t = applyShotRules(rs, sim({
    pocketed: [11], firstContactId: 2,
    events: [ev('ball_ball', 5, 0, 2), ev('pocket', 40, 11)],
    finalActive: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15],
  }));
  assert('pot opponent ball → turn passes', !t.keepTurn && !t.foul);
}

// sanity on helpers
assert('groupIds solids', groupIds('solids').join(',') === '1,2,3,4,5,6,7');
assert('EIGHT_BALL is 8', EIGHT_BALL === 8);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
